"""app/artist_probe.py: сравнение артистов по косинусу и один трек победителя.

Проверяем ровно то, за что модуль отвечает: что близость меряется
РАСПРЕДЕЛЕНИЕМ вкуса, а не объёмом истории; что артист выбирается каталогом
целиком; что наружу уходит ОДИН трек, а не пул; и что при отсутствии близких
имён пик честно пустой — поток обязан работать без подсказки.
"""

import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from app import artist_probe
from app.artist_probe import (
    PROBE_MIN_TRACKS,
    artist_vector,
    candidate_artists,
    compare_artists,
    cosine_distance,
    cosine_similarity,
    probe_key,
    taste_vector,
    track_vector,
)
from app.cache import clear_pattern, get_cache, set_cache
from app.models import Playlist, Track, playlist_tracks, user_play_events
from app.schemas import ExternalTrackResponse

from tests.conftest import TestingSessionLocal, auth_headers, create_user


@pytest.fixture(autouse=True)
def _clear_probe_cache():
    # Ключ пика живёт 6 часов в общем Redis, а id юзеров sqlite переиспользует
    # с 1 в каждом тесте: без очистки пик прошлого теста подставляется в
    # следующий и ломает и проверку исключения, и выдачу потока.
    clear_pattern("flow:*")
    yield
    clear_pattern("flow:*")


def _external(artist, title, external_id, genre=None):
    return ExternalTrackResponse(
        id=f"ytmusic:{external_id}",
        source="ytmusic",
        external_id=external_id,
        title=title,
        artist=artist,
        duration=180,
        stream_url="",
        genre=genre,
    )


def _profile(**overrides):
    """Минимальный профиль вкуса — только те ключи, которые читает модуль."""
    profile = {
        "artists": ["LovedArtist"],
        "artist_weight": {"lovedartist": 8.0},
        "genre_counts": {"phonk": 6, "trap": 2},
        "title_tags": [],
        "banned_artists": set(),
        "prefer_cyrillic": None,
    }
    profile.update(overrides)
    return profile


def _catalog(artist, genre, count=PROBE_MIN_TRACKS, prefix=None):
    prefix = prefix or artist.lower()
    return [
        _external(artist, f"{prefix} song {i}", f"{prefix}{i}", genre=genre)
        for i in range(count)
    ]


def _liked_artist(db, user, artist="LovedArtist"):
    """Курированный трек — минимальный профиль вкуса (артист с весом > 0)."""
    playlist = Playlist(
        name="Понравившиеся", is_public=False, is_liked=True, owner_id=user.id
    )
    db.add(playlist)
    db.commit()
    db.refresh(playlist)
    track = Track(title="liked-song", artist=artist, duration=100, source="local")
    db.add(track)
    db.commit()
    db.execute(
        playlist_tracks.insert().values(
            playlist_id=playlist.id, track_id=track.id, position=0
        )
    )
    db.commit()
    return track


# --- геометрия -------------------------------------------------------------


def test_taste_vector_ignores_history_size():
    """Юзер с шестью прослушиваниями и с шестью тысячами — один вектор.

    Ось нормируется по L1 (см. _axis_normalized), иначе косинус к каталогу
    кандидата зависел бы от того, как давно юзер зарегистрировался.
    """
    small = taste_vector(_profile(genre_counts={"phonk": 6, "trap": 2}))
    large = taste_vector(_profile(genre_counts={"phonk": 6000, "trap": 2000}))

    assert small == pytest.approx(large)
    assert small["g:phonk"] == pytest.approx(0.75)
    assert small["g:trap"] == pytest.approx(0.25)


def test_taste_vector_skips_script_axis_without_dominance():
    """prefer_cyrillic=None — оси письменности нет ни у вкуса, ни у кандидатов.

    dominant_is_cyrillic отдаёт None, когда доминирования нет (или текстов
    слишком мало). Проставлять в этом случае одну из сторон значило бы решить
    за юзера то, чего он не сказал.
    """
    mixed = taste_vector(_profile(prefer_cyrillic=None))
    assert not any(term.startswith("s:") for term in mixed)

    cyrillic = taste_vector(_profile(prefer_cyrillic=True))
    assert cyrillic["s:cyr"] == pytest.approx(0.5)


def test_taste_vector_keeps_tag_rank_order():
    """От тегов в профиле остаются только ключи, но порядок — по весу."""
    vector = taste_vector(_profile(title_tags=["slowed", "reverb", "remix"]))

    assert vector["t:slowed"] > vector["t:reverb"] > vector["t:remix"]
    # Ось всё равно весит ровно свои 0.6 — сумма долей внутри оси равна 1.
    assert sum(
        value for term, value in vector.items() if term.startswith("t:")
    ) == pytest.approx(0.6)


def test_cosine_similarity_bounds():
    left = {"g:phonk": 0.75, "g:trap": 0.25}

    assert cosine_similarity(left, dict(left)) == pytest.approx(1.0)
    assert cosine_distance(left, dict(left)) == pytest.approx(0.0)
    assert cosine_similarity(left, {"g:jazz": 1.0}) == 0.0
    assert cosine_distance(left, {"g:jazz": 1.0}) == pytest.approx(1.0)
    assert cosine_similarity(left, {}) == 0.0
    assert cosine_similarity({}, left) == 0.0


def test_off_vocabulary_words_cost_similarity():
    """Слово названия вне личного словаря — не нейтрально, а в минус.

    Терма для него не появляется, но ось вкуса свою долю в длине вектора
    сохраняет — и косинус падает. Это и есть штраф «не про то», ради которого
    словарь берётся у юзера, а не у языка.
    """
    profile = _profile(title_tags=["slowed"], genre_counts={"phonk": 1})
    user_vector = taste_vector(profile)
    vocabulary = {"slowed"}

    on_topic = track_vector(
        _external("NewName", "midnight slowed", "a1", genre="phonk"),
        tag_vocabulary=vocabulary,
        script_axis=False,
    )
    off_topic = track_vector(
        _external("NewName", "midnight session", "a2", genre="phonk"),
        tag_vocabulary=vocabulary,
        script_axis=False,
    )

    assert cosine_similarity(user_vector, on_topic) > cosine_similarity(
        user_vector, off_topic
    )


def test_artist_vector_is_catalogue_frequency():
    """Вектор артиста — частоты по каталогу, а не сумма по трекам."""
    tracks = [
        _external("NewName", "one", "n1", genre="phonk"),
        _external("NewName", "two", "n2", genre="phonk"),
        _external("NewName", "three", "n3", genre="jazz"),
    ]
    vector = artist_vector(tracks, script_axis=False)

    assert vector["g:phonk"] == pytest.approx(2 / 3)
    assert vector["g:jazz"] == pytest.approx(1 / 3)


def test_artist_vector_of_empty_catalogue_is_empty():
    assert artist_vector([], script_axis=False) == {}


# --- отбор кандидатов ------------------------------------------------------


def test_candidate_artists_keeps_only_new_names(monkeypatch):
    """Знакомые и забаненные имена в сравнение не идут.

    Знакомого сравнивать не с чем: доля разведки — про новые имена, а свой
    каталог знакомый артист и так отдаёт отдельным источником.
    """
    async def _names(artist):
        assert artist == "LovedArtist"
        return [
            {"name": "LovedArtist", "browse_id": "SAME"},
            {"name": "BannedName", "browse_id": "BAD"},
            {"name": "FreshName", "browse_id": "GOOD"},
            {"name": "FreshName", "browse_id": "DUPLICATE"},
            {"name": "NoBrowseId", "browse_id": ""},
        ]

    monkeypatch.setattr("app.routers.flow._similar_artist_names", _names)

    found = asyncio.run(candidate_artists(_profile(banned_artists={"bannedname"})))

    assert found == [{"name": "FreshName", "browse_id": "GOOD"}]


def test_candidate_artists_survives_a_dead_neighbour(monkeypatch):
    """Один упавший сид не отменяет сравнение остальных."""
    async def _names(artist):
        if artist == "LovedArtist":
            raise RuntimeError("provider down")
        return [{"name": "FreshName", "browse_id": "GOOD"}]

    monkeypatch.setattr("app.routers.flow._similar_artist_names", _names)

    found = asyncio.run(
        candidate_artists(_profile(artists=["LovedArtist", "SecondArtist"]), seeds=2)
    )

    assert found == [{"name": "FreshName", "browse_id": "GOOD"}]


# --- сравнение и выбор трека ----------------------------------------------


def test_closest_artist_wins_and_yields_one_track(monkeypatch):
    """Ближе по каталогу — тот и отдаёт трек. Ровно один."""
    catalogues = {
        "NEAR": _catalog("NearName", "phonk"),
        "FAR": _catalog("FarName", "classical"),
    }

    async def _pool(browse_id):
        return catalogues[browse_id]

    monkeypatch.setattr("app.routers.flow._artist_songs_pool", _pool)

    payload = asyncio.run(
        compare_artists(
            _profile(),
            [
                {"name": "FarName", "browse_id": "FAR"},
                {"name": "NearName", "browse_id": "NEAR"},
            ],
        )
    )

    assert payload["artist"] == "NearName"
    assert payload["track"]["artist"] == "NearName"
    assert payload["distance"] < payload["ranking"][-1]["distance"]
    # Наружу уходит ОДИН трек: это добавка качества к разведке, а не ещё один
    # источник объёма.
    assert isinstance(payload["track"], dict)
    assert {row["artist"] for row in payload["ranking"]} == {"NearName", "FarName"}


def test_thin_catalogue_is_not_compared(monkeypatch):
    """Артист с двумя найденными треками не сравнивается.

    Его «каталог» — случайная пара названий: вектор по ним говорит о выдаче
    провайдера, а не об артисте.
    """
    async def _pool(browse_id):
        if browse_id == "THIN":
            return _catalog("ThinName", "phonk", count=PROBE_MIN_TRACKS - 1)
        return _catalog("FullName", "phonk")

    monkeypatch.setattr("app.routers.flow._artist_songs_pool", _pool)

    payload = asyncio.run(
        compare_artists(
            _profile(),
            [
                {"name": "ThinName", "browse_id": "THIN"},
                {"name": "FullName", "browse_id": "FULL"},
            ],
        )
    )

    assert payload["artist"] == "FullName"
    assert [row["artist"] for row in payload["ranking"]] == ["FullName"]


def test_features_do_not_join_the_artist_vector(monkeypatch):
    """Страница артиста отдаёт и фиты — в его вектор идут только его треки."""
    async def _pool(browse_id):
        return [
            *_catalog("HostName", "phonk"),
            *_catalog("GuestName", "classical", prefix="guest"),
        ]

    monkeypatch.setattr("app.routers.flow._artist_songs_pool", _pool)

    payload = asyncio.run(
        compare_artists(_profile(), [{"name": "HostName", "browse_id": "HOST"}])
    )

    assert payload["ranking"][0]["tracks"] == PROBE_MIN_TRACKS
    assert payload["track"]["artist"] == "HostName"


def test_distant_candidates_yield_no_track(monkeypatch):
    """Ниже порога близости пик пустой, а не «лучший из далёких»."""
    async def _pool(browse_id):
        return _catalog("FarName", "classical")

    monkeypatch.setattr("app.routers.flow._artist_songs_pool", _pool)

    payload = asyncio.run(
        compare_artists(
            _profile(genre_counts={"phonk": 6}),
            [{"name": "FarName", "browse_id": "FAR"}],
        )
    )

    assert payload["track"] is None
    # Ranking всё равно на месте: по нему видно, что воркер работал.
    assert payload["ranking"][0]["artist"] == "FarName"


def test_cold_start_profile_is_not_compared(monkeypatch):
    """Без вкуса «самый подходящий» был бы случайным — сравнения нет."""
    called = False

    async def _pool(browse_id):
        nonlocal called
        called = True
        return _catalog("FreshName", "phonk")

    monkeypatch.setattr("app.routers.flow._artist_songs_pool", _pool)

    payload = asyncio.run(
        compare_artists(
            _profile(genre_counts={}, title_tags=[], prefer_cyrillic=None),
            [{"name": "FreshName", "browse_id": "GOOD"}],
        )
    )

    assert payload is None
    assert called is False


def test_best_track_inside_the_winning_catalogue(monkeypatch):
    """Внутри выбранного каталога берём трек с ближайшим СВОИМ вектором."""
    async def _pool(browse_id):
        return [
            _external("NearName", "generic one", "g1", genre="phonk"),
            _external("NearName", "generic two", "g2", genre="classical"),
            _external("NearName", "slowed anthem", "hit", genre="phonk"),
        ]

    monkeypatch.setattr("app.routers.flow._artist_songs_pool", _pool)

    payload = asyncio.run(
        compare_artists(
            _profile(title_tags=["slowed"]),
            [{"name": "NearName", "browse_id": "NEAR"}],
        )
    )

    assert payload["track"]["external_id"] == "hit"
    # Выбранный трек ближе, чем каталог целиком: у артиста в векторе есть жанр,
    # которого у юзера нет, а у трека — только его собственные термы. Именно за
    # этим трек выбирается вторым шагом, а не берётся первым по популярности.
    assert payload["track_distance"] < payload["distance"]


# --- проход воркера и чтение потоком --------------------------------------


def test_probe_advances_past_the_previous_pick(monkeypatch):
    """Второй проход не предлагает тот же трек снова.

    Без исключения прошлого пика воркер вечно возвращал бы одну песню: она же
    и остаётся самой близкой.
    """
    async def _names(artist):
        return [{"name": "NearName", "browse_id": "NEAR"}]

    async def _pool(browse_id):
        return _catalog("NearName", "phonk", count=PROBE_MIN_TRACKS + 1)

    monkeypatch.setattr("app.routers.flow._similar_artist_names", _names)
    monkeypatch.setattr("app.routers.flow._artist_songs_pool", _pool)
    monkeypatch.setattr(artist_probe, "_taste_profile_for", lambda user_id: _profile())

    first = asyncio.run(artist_probe.probe_user(4242))
    second = asyncio.run(artist_probe.probe_user(4242))

    assert first["track"]["external_id"] != second["track"]["external_id"]
    assert get_cache(probe_key(4242))["track"]["external_id"] == (
        second["track"]["external_id"]
    )


def test_refresh_probes_counts_only_new_picks(monkeypatch):
    """Проход по явному списку юзеров: один падает, второй получает пик."""
    async def _names(artist):
        return [{"name": "NearName", "browse_id": "NEAR"}]

    async def _pool(browse_id):
        return _catalog("NearName", "phonk")

    def _profile_for(user_id):
        if user_id == 1:
            raise RuntimeError("profile blew up")
        return _profile()

    monkeypatch.setattr("app.routers.flow._similar_artist_names", _names)
    monkeypatch.setattr("app.routers.flow._artist_songs_pool", _pool)
    monkeypatch.setattr(artist_probe, "_taste_profile_for", _profile_for)

    # Юзер, чей профиль упал, не роняет проход целиком.
    assert asyncio.run(artist_probe.refresh_probes(users=[1, 2])) == 1
    assert get_cache(probe_key(1)) is None
    assert get_cache(probe_key(2))["artist"] == "NearName"


def test_cached_pick_reads_the_worker_result():
    payload = {
        "track": _external("NearName", "slowed anthem", "hit").model_dump(),
        "artist": "NearName",
        "similarity": 0.9,
        "distance": 0.1,
    }
    set_cache(probe_key(7), payload)

    pick = asyncio.run(artist_probe.cached_pick(7))

    assert pick is not None
    assert pick.external_id == "hit"
    assert pick.artist == "NearName"


def test_cached_pick_tolerates_unusable_payload():
    """Поток обязан работать и без подсказки — битый payload это None."""
    assert asyncio.run(artist_probe.cached_pick(9)) is None

    set_cache(probe_key(9), {"track": {"nonsense": True}})
    assert asyncio.run(artist_probe.cached_pick(9)) is None

    set_cache(probe_key(9), {"artist": "NearName", "track": None})
    assert asyncio.run(artist_probe.cached_pick(9)) is None


def test_active_users_are_ordered_by_recency(db, monkeypatch):
    """Лимит прохода обслуживает тех, кто слушает сейчас."""
    monkeypatch.setattr("app.database.SessionLocal", TestingSessionLocal)
    now = datetime.now(timezone.utc)
    recent = create_user(db, username="recent-listener")
    older = create_user(db, username="older-listener")
    stale = create_user(db, username="stale-listener")
    track = Track(title="played", artist="AnyArtist", duration=100, source="local")
    db.add(track)
    db.commit()
    db.execute(
        user_play_events.insert(),
        [
            {
                "user_id": recent.id,
                "track_id": track.id,
                "played_at": now - timedelta(hours=1),
            },
            {
                "user_id": older.id,
                "track_id": track.id,
                "played_at": now - timedelta(days=3),
            },
            {
                "user_id": stale.id,
                "track_id": track.id,
                "played_at": now - timedelta(days=40),
            },
        ],
    )
    db.commit()

    assert artist_probe.active_user_ids(days=14, limit=10) == [recent.id, older.id]
    assert artist_probe.active_user_ids(days=14, limit=1) == [recent.id]


def test_flow_delivers_the_probe_pick_first_in_discovery(client, db, monkeypatch):
    """Пик воркера идёт первым среди новых имён — внутри цели разведки.

    Своей квоты у него нет: сортировка новых кандидатов стабильная, поэтому
    остальные сохраняют порядок общего ранжирования, и порция по-прежнему
    ограничена discovery_slots.
    """
    user = create_user(db, username="probe-flow-user")
    user.discovery_ratio = 0.6
    db.commit()
    _liked_artist(db, user)

    set_cache(
        probe_key(user.id),
        {
            "track": _external("ProbeName", "probe song", "probe1").model_dump(),
            "artist": "ProbeName",
            "similarity": 0.82,
            "distance": 0.18,
        },
    )

    async def _empty(*args, **kwargs):
        return []

    async def _favorite(request, artist):
        # Каталог любимого артиста — единственный источник, который заводится от
        # одного лайка: сиды radio берутся из внешних треков, а их у локального
        # лайка нет. Артисты каталога незнакомые, значит конкурируют с пиком
        # ровно там, где нужно — внутри цели разведки.
        return [
            _external(f"CatalogName{i}", f"catalog-{i}", f"favorite{i}")
            for i in range(20)
        ]

    bonuses = {}

    def _score(item, **kwargs):
        external_id = getattr(item, "external_id", None) or ""
        bonuses[external_id or getattr(item, "title", "")] = kwargs.get("content_bonus")
        # Каталог оценивается ВЫШЕ пика: без приоритета внутри цели разведки он
        # до порции не дошёл бы, и тест ловил бы просто «в пуле есть трек».
        return 50.0 if external_id.startswith("favorite") else 1.0

    for name in (
        "_similar_pool",
        "_artist_seed_videos",
        "_soundcloud_pool",
        "_radio_pool",
        "_tag_pool",
        "_lastfm_pool",
    ):
        monkeypatch.setattr(f"app.routers.flow.{name}", _empty)
    monkeypatch.setattr("app.routers.flow._favorite_artist_pool", _favorite)
    monkeypatch.setattr("app.routers.flow.score_track", _score)

    resp = client.get(
        "/api/recommendations/flow?limit=6",
        headers=auth_headers(client, username="probe-flow-user"),
    )
    assert resp.status_code == 200, resp.text
    tracks = resp.json()

    assert "probe1" in {track.get("external_id") for track in tracks}, tracks
    assert bonuses["probe1"] == pytest.approx(0.14)
    # Стрим-ссылку пику проставляет тот же _add_explore, что и остальной
    # разведке: без неё трек не сыграется.
    probe_track = next(t for t in tracks if t.get("external_id") == "probe1")
    assert probe_track["stream_url"].endswith("/api/ytdlp/stream/probe1")


def test_flow_works_without_a_probe_pick(client, db, monkeypatch):
    """Нет посчитанного пика — поток ведёт себя ровно как раньше."""
    user = create_user(db, username="no-probe-user")
    user.discovery_ratio = 0.6
    db.commit()
    _liked_artist(db, user)

    async def _empty(*args, **kwargs):
        return []

    async def _favorite(request, artist):
        return [
            _external(f"CatalogName{i}", f"catalog-{i}", f"favorite{i}")
            for i in range(20)
        ]

    for name in (
        "_similar_pool",
        "_artist_seed_videos",
        "_soundcloud_pool",
        "_radio_pool",
        "_tag_pool",
        "_lastfm_pool",
    ):
        monkeypatch.setattr(f"app.routers.flow.{name}", _empty)
    monkeypatch.setattr("app.routers.flow._favorite_artist_pool", _favorite)

    resp = client.get(
        "/api/recommendations/flow?limit=6",
        headers=auth_headers(client, username="no-probe-user"),
    )
    assert resp.status_code == 200, resp.text
    assert len(resp.json()) == 6, resp.text
