"""Ползунок «новые артисты / знакомые» (User.discovery_ratio).

Настройка задаёт долю выдачи под НЕЗНАКОМЫХ артистов и читается обоими
движками — /recommendations и волной (см. app/discovery.py). Здесь проверяются
три вещи: арифметика долей, сохранение настройки через API и то, что она реально
меняет выдачу рекомендаций.
"""

import pytest

from app.cache import clear_pattern
from app.discovery import DEFAULT_DISCOVERY_RATIO, discovery_ratio, discovery_slots
from app.models import Playlist, Track, playlist_tracks, track_cooccurrence
from app.routers.flow import (
    _STANDARD_FLOW_LIMIT,
    _STANDARD_FAVORITE_SLOTS,
    _STANDARD_LASTFM_SLOTS,
    _STANDARD_LIKED_SLOTS,
    _standard_slots,
)

from tests.conftest import auth_headers, create_user


@pytest.fixture(autouse=True)
def _clear_recs_cache():
    # Выдача кэшируется на 5 минут, а id юзеров в sqlite начинаются с 1 в каждом
    # тесте — общий Redis иначе протекает между тестами (см. test_recommendations).
    clear_pattern("recs:*")
    yield
    clear_pattern("recs:*")


def _track(db, title, artist, play_count=0, genre="rock"):
    # Жанр проставлен намеренно: у безжанрового кандидата от НЕЗНАКОМОГО артиста
    # проверка вкуса (taste.make_relevance_check) не находит ни одного сигнала и
    # отбраковывает его до всяких квот. В тесте про доли нужен сосед, который
    # проверку проходит, — иначе он не появится ни при какой настройке.
    t = Track(
        title=title,
        artist=artist,
        duration=100,
        source="ytmusic",
        external_id=title,
        play_count=play_count,
        genre=genre,
    )
    db.add(t)
    db.commit()
    db.refresh(t)
    return t


# --- арифметика долей ---


class _FakeUser:
    def __init__(self, **kwargs):
        for key, value in kwargs.items():
            setattr(self, key, value)


def test_discovery_ratio_clamps_and_falls_back():
    assert discovery_ratio(_FakeUser(discovery_ratio=0.45)) == 0.45
    assert discovery_ratio(_FakeUser(discovery_ratio=0.0)) == 0.0
    # Значение из строки, созданной до миграции 0015, и мусор из чужого кода не
    # должны обнулять разведку — падаем в дефолт.
    assert discovery_ratio(_FakeUser(discovery_ratio=None)) == DEFAULT_DISCOVERY_RATIO
    assert discovery_ratio(_FakeUser()) == DEFAULT_DISCOVERY_RATIO
    assert discovery_ratio(_FakeUser(discovery_ratio="nonsense")) == DEFAULT_DISCOVERY_RATIO
    # Границы: за пределы 0..1 выходить нельзя, иначе квота съест всю порцию.
    assert discovery_ratio(_FakeUser(discovery_ratio=2.5)) == 1.0
    assert discovery_ratio(_FakeUser(discovery_ratio=-1.0)) == 0.0


def test_discovery_slots_edges():
    # Ноль означает именно ноль: выключивший разведку не должен её получать.
    assert discovery_slots(15, 0.0) == 0
    # ...а ненулевая доля всегда даёт хотя бы одно место, даже если округление
    # съело бы её целиком.
    assert discovery_slots(8, 0.01) == 1
    assert discovery_slots(15, DEFAULT_DISCOVERY_RATIO) == 3
    assert discovery_slots(15, 1.0) == 15
    assert discovery_slots(0, 1.0) == 0


def test_standard_slots_default_keeps_previous_split():
    """У юзера, который ползунок не трогал, порция волны не меняется."""
    assert _standard_slots(DEFAULT_DISCOVERY_RATIO) == (
        _STANDARD_LASTFM_SLOTS,
        _STANDARD_LIKED_SLOTS,
        _STANDARD_FAVORITE_SLOTS,
    )


@pytest.mark.parametrize("ratio", [0.0, 0.1, 0.2, 0.34, 0.5, 0.75, 1.0])
def test_standard_slots_always_fill_the_batch(ratio):
    lastfm, liked, favorite = _standard_slots(ratio)
    assert lastfm + liked + favorite == _STANDARD_FLOW_LIMIT
    assert min(lastfm, liked, favorite) >= 0
    assert lastfm == discovery_slots(_STANDARD_FLOW_LIMIT, ratio)


def test_standard_slots_extremes():
    assert _standard_slots(0.0) == (0, 6, 9)
    assert _standard_slots(1.0) == (15, 0, 0)


# --- сохранение через API ---


def test_preferences_roundtrip_discovery_ratio(client, db):
    create_user(db, username="slider-user")
    headers = auth_headers(client, username="slider-user")

    me = client.get("/api/users/me", headers=headers)
    assert me.status_code == 200, me.text
    assert me.json()["discovery_ratio"] == DEFAULT_DISCOVERY_RATIO

    saved = client.put(
        "/api/users/me/preferences",
        headers=headers,
        json={"discovery_ratio": 0.65},
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["discovery_ratio"] == 0.65

    again = client.get("/api/users/me", headers=headers)
    assert again.json()["discovery_ratio"] == 0.65


def test_preferences_without_ratio_keep_it(client, db):
    """Онбординг ползунок не показывает — и не должен сбрасывать его в дефолт."""
    create_user(db, username="keep-user")
    headers = auth_headers(client, username="keep-user")

    client.put(
        "/api/users/me/preferences",
        headers=headers,
        json={"discovery_ratio": 0.8},
    )
    resp = client.put(
        "/api/users/me/preferences",
        headers=headers,
        json={"preferred_genres": ["rock"]},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["discovery_ratio"] == 0.8


@pytest.mark.parametrize("bad", [1.5, -0.1])
def test_preferences_reject_ratio_out_of_range(client, db, bad):
    create_user(db, username="bad-ratio-user")
    resp = client.put(
        "/api/users/me/preferences",
        headers=auth_headers(client, username="bad-ratio-user"),
        json={"discovery_ratio": bad},
    )
    assert resp.status_code == 422, resp.text


# --- влияние на /recommendations ---


def _taste_with_stranger_neighbour(db, username):
    """Профиль из трёх курированных артистов + один НЕЗНАКОМЫЙ сосед по CF.

    Знакомого материала ровно на порцию из трёх треков, поэтому попадание
    незнакомца в выдачу определяется настройкой, а не бедностью пула.
    """
    user = create_user(db, username=username)
    liked_pl = Playlist(
        name="Понравившиеся", is_public=False, is_liked=True, owner_id=user.id
    )
    db.add(liked_pl)
    db.commit()
    db.refresh(liked_pl)

    known_artists = ["AlphaBand", "BetaBand", "GammaBand"]
    liked_ids = []
    for pos, artist in enumerate(known_artists):
        liked = _track(db, f"{artist} first", artist, play_count=1)
        db.execute(
            playlist_tracks.insert().values(
                playlist_id=liked_pl.id, track_id=liked.id, position=pos
            )
        )
        liked_ids.append(liked.id)
        # Второй трек того же артиста в коллекцию НЕ кладём — он и есть
        # «эксплуатация»: знакомое имя, ещё не слушанный трек.
        _track(db, f"{artist} second", artist, play_count=5)
    db.commit()

    stranger = _track(db, "stranger song", "StrangerBand", play_count=2)
    # Сосед по co-occurrence: единственный путь, которым в выдачу попадает
    # НЕЗНАКОМОЕ имя. Матрицу пишем напрямую — её пересчёт (rebuild_cooccurrence)
    # использует Postgres-функции, которых в sqlite нет.
    for liked_id in liked_ids:
        db.execute(
            track_cooccurrence.insert().values(
                track_id=liked_id, other_track_id=stranger.id, score=1.0
            )
        )
    db.commit()
    return user, stranger


def _artists(resp):
    return [t["artist"] for t in resp.json()["tracks"]]


def test_recommendations_zero_ratio_keeps_only_familiar(client, db, monkeypatch):
    """Ползунок в нуле — незнакомых имён в выдаче нет."""
    from app.routers import recommendations as recommendations_router

    # SQLite не умеет Postgres-оператор ~* из build_keyword_filters (см.
    # test_recommendations); контракт проверяется артистами, а не жанром.
    monkeypatch.setattr(
        recommendations_router, "build_keyword_filters", lambda *_a, **_kw: []
    )

    user, _stranger = _taste_with_stranger_neighbour(db, "no-new-user")
    user.discovery_ratio = 0.0
    db.commit()

    resp = client.get(
        "/api/recommendations/?limit=3",
        headers=auth_headers(client, username="no-new-user"),
    )
    assert resp.status_code == 200, resp.text
    artists = _artists(resp)
    assert len(artists) == 3, f"знакомого материала хватало на порцию: {artists}"
    assert "StrangerBand" not in artists, artists


def test_recommendations_full_ratio_brings_new_artists(client, db, monkeypatch):
    """Тот же профиль с ползунком на максимуме — незнакомец в выдаче."""
    from app.routers import recommendations as recommendations_router

    monkeypatch.setattr(
        recommendations_router, "build_keyword_filters", lambda *_a, **_kw: []
    )

    user, _stranger = _taste_with_stranger_neighbour(db, "all-new-user")
    user.discovery_ratio = 1.0
    db.commit()

    resp = client.get(
        "/api/recommendations/?limit=3",
        headers=auth_headers(client, username="all-new-user"),
    )
    assert resp.status_code == 200, resp.text
    assert "StrangerBand" in _artists(resp), _artists(resp)
