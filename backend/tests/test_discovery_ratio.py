"""Баланс открытия новых артистов (User.discovery_ratio)."""

import pytest

from app.cache import clear_pattern
from app.discovery import DEFAULT_DISCOVERY_RATIO, discovery_ratio
from app.models import Playlist, Track, playlist_tracks, track_cooccurrence
from app.recommendation_scoring import score_track

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
    # отбраковывает его ещё до общего ранжирования. В тесте про prior нужен сосед, который
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


# --- нормализация настройки ---


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
    # Границы: prior всегда остаётся в диапазоне 0..1.
    assert discovery_ratio(_FakeUser(discovery_ratio=2.5)) == 1.0
    assert discovery_ratio(_FakeUser(discovery_ratio=-1.0)) == 0.0


def test_discovery_ratio_slots_are_bounded():
    """Положительный приоритет задаёт цель, но не ломает пустой fallback."""
    import app.discovery as discovery

    assert discovery.discovery_slots(15, 0.0) == 0
    assert discovery.discovery_slots(15, 0.2) == 3
    assert discovery.discovery_slots(15, 1.0) == 15
    assert discovery.discovery_slots(0, 1.0) == 0


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


def test_recommendations_ratio_is_soft_prior(client, db, monkeypatch):
    """Ползунок меняет ranking, но не резервирует позиции."""
    from app.routers import recommendations as recommendations_router

    # SQLite не умеет Postgres-оператор ~* из build_keyword_filters (см.
    # test_recommendations); контракт проверяется артистами, а не жанром.
    monkeypatch.setattr(
        recommendations_router, "build_keyword_filters", lambda *_a, **_kw: []
    )

    captured = []

    def _base_score(track, **kwargs):
        captured.append((track.artist, kwargs.get("novelty")))
        return score_track(track, **kwargs)

    monkeypatch.setattr(recommendations_router, "score_track", _base_score)

    low_user, _ = _taste_with_stranger_neighbour(db, "low-prior-user")
    low_user.discovery_ratio = 0.0
    db.commit()
    low = client.get(
        "/api/recommendations/?limit=3",
        headers=auth_headers(client, username="low-prior-user"),
    )
    assert low.status_code == 200, low.text

    clear_pattern("recs:*")
    high_user, _ = _taste_with_stranger_neighbour(db, "high-prior-user")
    high_user.discovery_ratio = 1.0
    db.commit()
    high = client.get(
        "/api/recommendations/?limit=3",
        headers=auth_headers(client, username="high-prior-user"),
    )
    assert high.status_code == 200, high.text

    low_artists = _artists(low)
    high_artists = _artists(high)
    assert low_artists.count("StrangerBand") <= high_artists.count("StrangerBand")
    assert {novelty for _artist, novelty in captured} == {False, True}
