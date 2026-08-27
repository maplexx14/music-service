"""Рекомендации /api/recommendations: учёт скипов и отказ от слепой добивки.

Сценарий воспроизводит регрессию из-за внешних (безжанровых) треков: сид —
артист из лайков, надоевший артист ушёл в минус по скипам, а несвязанный хит
сервиса не должен занимать место в выдаче.
"""

import pytest

from app.cache import clear_pattern
from app.models import (
    Track,
    Playlist,
    playlist_tracks,
    user_track_plays,
    user_track_skips,
    recommendation_events,
)
from app.schemas import ExternalTrackResponse

from tests.conftest import auth_headers, create_user


@pytest.fixture(autouse=True)
def _clear_recs_cache():
    # Тесты пересоздают БД, но Redis общий: юзеры получают одинаковые id, и кэш
    # recs:{id} протекает между тестами. Чистим до и после.
    clear_pattern("recs:*")
    yield
    clear_pattern("recs:*")


def _track(db, title, artist, play_count=0, genre=None):
    t = Track(title=title, artist=artist, duration=100, source="ytmusic",
              external_id=title, play_count=play_count, genre=genre)
    db.add(t)
    db.commit()
    db.refresh(t)
    return t


def _features(**overrides):
    vector = {
        "tempo": 0.5,
        "loudness": 0.5,
        "dynamics": 0.5,
        "brightness": 0.5,
        "bass": 0.5,
        "zero_crossing": 0.5,
        "pulse_clarity": 0.5,
    }
    vector.update(overrides)
    return {"vector": vector}


def test_recommendations_respect_taste_and_skips(client, db):
    user = create_user(db)

    liked_pl = Playlist(name="Понравившиеся", is_public=False, is_liked=True, owner_id=user.id)
    db.add(liked_pl)
    db.commit()
    db.refresh(liked_pl)

    liked = _track(db, "liked-good", "GoodArtist", play_count=1)
    more_good = _track(db, "more-good", "GoodArtist", play_count=5)      # ждём в выдаче
    annoying_seed = _track(db, "annoying-seed", "AnnoyingArtist", play_count=2)
    annoying_more = _track(db, "annoying-more", "AnnoyingArtist", play_count=100)  # не ждём
    unrelated_hit = _track(db, "mega-hit", "PopStar", play_count=1000)   # не ждём (без добивки)

    # liked-good лежит в плейлисте лайков
    db.execute(playlist_tracks.insert().values(
        playlist_id=liked_pl.id, track_id=liked.id, position=0))
    # annoying-seed играли дважды (попадает в сид часто-играемых)
    db.execute(user_track_plays.insert().values(
        user_id=user.id, track_id=annoying_seed.id, play_count=2))
    # ...и его же трижды скипнули — артист уходит в минус
    db.execute(user_track_skips.insert().values(
        user_id=user.id, track_id=annoying_seed.id, skip_count=3))
    db.commit()

    resp = client.get("/api/recommendations/", headers=auth_headers(client))
    assert resp.status_code == 200, resp.text
    ids = {t["id"] for t in resp.json()["tracks"]}

    assert more_good.id in ids, "трек любимого артиста должен рекомендоваться"
    assert annoying_seed.id not in ids, "скипнутый трек исключён"
    assert annoying_more.id not in ids, "надоевший (минусовой) артист исключён"
    assert unrelated_hit.id not in ids, "несвязанный хит не добивает выдачу"


def test_recommendations_cold_start_shows_popular(client, db):
    """Без сигналов вкуса — холодный старт: показываем популярное сервиса."""
    create_user(db, username="bob")
    hit = _track(db, "cold-hit", "Whoever", play_count=500)

    resp = client.get("/api/recommendations/", headers=auth_headers(client, username="bob"))
    assert resp.status_code == 200, resp.text
    ids = {t["id"] for t in resp.json()["tracks"]}
    assert hit.id in ids


def test_recommendations_cold_start_respects_preferred_genre(
    client, db, monkeypatch
):
    """Жанр из онбординга сам по себе персонализирует первую выдачу."""
    from app.routers import recommendations as recommendations_router

    # SQLite не поддерживает Postgres-оператор ~*. Здесь проверяем основной
    # контракт через явное поле Track.genre, поэтому текстовые фильтры не нужны.
    monkeypatch.setattr(
        recommendations_router, "build_keyword_filters", lambda *_args, **_kwargs: []
    )

    user = create_user(db, username="genre-user")
    user.preferred_genres = ["rock"]
    db.commit()

    wanted = _track(db, "wanted-rock", "RockArtist", play_count=1, genre="Rock")
    unwanted = _track(db, "unwanted-pop", "PopArtist", play_count=1000, genre="pop")

    resp = client.get(
        "/api/recommendations/",
        headers=auth_headers(client, username="genre-user"),
    )
    assert resp.status_code == 200, resp.text
    ids = {t["id"] for t in resp.json()["tracks"]}

    assert wanted.id in ids
    assert unwanted.id not in ids


def test_updating_preferences_invalidates_cached_recommendations(client, db):
    """После онбординга главная не должна пять минут отдавать старый cold start."""
    create_user(db, username="pref-user")
    wanted = _track(db, "chosen-track", "ChosenArtist", play_count=1)
    unwanted = _track(db, "global-hit", "OtherArtist", play_count=1000)
    headers = auth_headers(client, username="pref-user")

    first = client.get("/api/recommendations/", headers=headers)
    assert first.status_code == 200, first.text
    assert unwanted.id in {t["id"] for t in first.json()["tracks"]}

    saved = client.put(
        "/api/users/me/preferences",
        headers=headers,
        json={"preferred_genres": [], "preferred_artists": ["ChosenArtist"]},
    )
    assert saved.status_code == 200, saved.text

    second = client.get("/api/recommendations/", headers=headers)
    assert second.status_code == 200, second.text
    ids = {t["id"] for t in second.json()["tracks"]}

    assert wanted.id in ids
    assert unwanted.id not in ids


def test_recommendations_ignore_other_users_library(client, db):
    """Библиотека другого юзера не подмешивается в рекомендации.

    Та же боевая регрессия, что и в test_flow: таблица tracks общая, владельца у
    трека нет, а Track.play_count — счётчик на всех юзеров. Юзер, импортировавший
    большой плейлист, возглавлял глобальный топ, и его треки ехали остальным
    через добор популярным (_varied_popular).

    Профиль Алисы намеренно без жанра: непустой genres поднимает
    build_keyword_filters с Postgres-regex (`~*` и `\\y`), который SQLite в
    тестах не выполняет.
    """
    alice = create_user(db, username="alice")
    bob = create_user(db, username="bob")

    liked_pl = Playlist(name="Понравившиеся", is_public=False, is_liked=True, owner_id=alice.id)
    db.add(liked_pl)
    db.commit()
    db.refresh(liked_pl)

    liked = _track(db, "мой любимый", "AliceArtist", play_count=1)
    own_more = _track(db, "второй", "AliceArtist", play_count=3)
    db.execute(playlist_tracks.insert().values(
        playlist_id=liked_pl.id, track_id=liked.id, position=0))
    db.commit()

    bob_pl = Playlist(name="Импорт", is_public=False, is_liked=False, owner_id=bob.id)
    db.add(bob_pl)
    db.commit()
    db.refresh(bob_pl)
    bob_tracks = [
        _track(db, f"bob phonk {i}", f"BobArtist{i}", play_count=500 + i)
        for i in range(12)
    ]
    for pos, t in enumerate(bob_tracks):
        db.execute(playlist_tracks.insert().values(
            playlist_id=bob_pl.id, track_id=t.id, position=pos))
    db.commit()

    resp = client.get("/api/recommendations/", headers=auth_headers(client))
    assert resp.status_code == 200, resp.text

    tracks = resp.json()["tracks"]
    leaked = {t["artist"] for t in tracks if t["artist"].startswith("BobArtist")}
    assert not leaked, f"в рекомендации Алисы протекла библиотека Боба: {leaked}"
    assert own_more.id in {t["id"] for t in tracks}, (
        "свой трек любимого артиста должен остаться в выдаче"
    )


def test_recommendations_include_acoustically_close_new_artist(client, db):
    """Акустически близкий новый артист конкурирует в общем endpoint-score."""
    user = create_user(db, username="acoustic-endpoint-user")
    liked_pl = Playlist(
        name="Понравившиеся",
        is_public=False,
        is_liked=True,
        owner_id=user.id,
    )
    seed = Track(
        title="seed",
        artist="KnownArtist",
        duration=100,
        source="local",
        file_path="minio://music/seed.mp3",
        acoustic_features=_features(tempo=0.2, brightness=0.2, bass=0.8),
    )
    close = Track(
        title="close",
        artist="NewArtist",
        duration=100,
        source="local",
        file_path="minio://music/close.mp3",
        acoustic_features=_features(tempo=0.22, brightness=0.21, bass=0.79),
    )
    far = Track(
        title="far",
        artist="OtherArtist",
        duration=100,
        source="local",
        file_path="minio://music/far.mp3",
        acoustic_features=_features(tempo=0.95, brightness=0.9, bass=0.05),
    )
    db.add_all([liked_pl, seed, close, far])
    db.commit()
    db.execute(
        playlist_tracks.insert().values(
            playlist_id=liked_pl.id,
            track_id=seed.id,
            position=0,
        )
    )
    db.commit()

    response = client.get(
        "/api/recommendations/?limit=20",
        headers=auth_headers(client, username="acoustic-endpoint-user"),
    )

    assert response.status_code == 200, response.text
    ids = {track["id"] for track in response.json()["tracks"]}
    assert close.id in ids
    assert far.id not in ids


def test_recommendations_do_not_open_acoustic_pool_without_user_profile(client, db):
    """Сам факт анализа чужого трека не является пользовательским сигналом."""
    user = create_user(db, username="no-acoustic-profile-user")
    liked_pl = Playlist(
        name="Понравившиеся",
        is_public=False,
        is_liked=True,
        owner_id=user.id,
    )
    seed = Track(
        title="seed without analysis",
        artist="KnownArtist",
        duration=100,
        source="local",
        file_path="minio://music/unprofiled-seed.mp3",
    )
    unrelated = Track(
        title="globally analyzed",
        artist="UnrelatedArtist",
        duration=100,
        source="local",
        file_path="minio://music/unrelated.mp3",
        acoustic_features=_features(tempo=0.2, brightness=0.2, bass=0.8),
    )
    db.add_all([liked_pl, seed, unrelated])
    db.commit()
    db.execute(
        playlist_tracks.insert().values(
            playlist_id=liked_pl.id,
            track_id=seed.id,
            position=0,
        )
    )
    db.commit()

    response = client.get(
        "/api/recommendations/",
        headers=auth_headers(client, username="no-acoustic-profile-user"),
    )

    assert response.status_code == 200, response.text
    assert unrelated.id not in {
        track["id"] for track in response.json()["tracks"]
    }


def test_recommendations_retrieve_provider_track_from_imported_playlist(
    client, db, monkeypatch
):
    """Imported collection signals can reach beyond materialized local tracks."""
    user = create_user(db, username="provider-recommendation-user")
    imported = Playlist(
        name="Imported",
        description="Импортировано из Spotify",
        origin="imported",
        is_public=False,
        owner_id=user.id,
    )
    seed = Track(
        title="seed song",
        artist="SeedArtist",
        duration=180,
        source="local",
        file_path="minio://music/seed-song.mp3",
    )
    db.add_all([imported, seed])
    db.commit()
    db.execute(
        playlist_tracks.insert().values(
            playlist_id=imported.id,
            track_id=seed.id,
            position=0,
        )
    )
    db.commit()

    favorite_calls = []
    similar_calls = []

    async def _lastfm(_request, artist, title):
        assert artist == "SeedArtist"
        assert title == "seed song"
        return [
            ExternalTrackResponse(
                id="ytmusic:provider-blocked",
                source="ytmusic",
                external_id="provider-blocked",
                title="blocked song",
                artist="BlockedArtist",
                duration=190,
                stream_url="",
            ),
            ExternalTrackResponse(
                id="ytmusic:provider-close",
                source="ytmusic",
                external_id="provider-close",
                title="close provider song",
                artist="RelatedArtist",
                duration=190,
                stream_url="",
            ),
            ExternalTrackResponse(
                id="soundcloud:provider-close-sc",
                source="soundcloud",
                external_id="provider-close-sc",
                title="close provider song",
                artist="RelatedArtist",
                duration=190,
                stream_url="https://soundcloud.example/stream",
            ),
        ]

    async def _favorite(_request, _artist):
        favorite_calls.append(_artist)
        return []

    async def _tag(_request, _genre):
        return []

    async def _similar(_artist):
        similar_calls.append(_artist)
        return []

    monkeypatch.setattr("app.routers.flow._lastfm_pool", _lastfm)
    monkeypatch.setattr("app.routers.flow._favorite_artist_pool", _favorite)
    monkeypatch.setattr("app.routers.flow._similar_pool", _similar)
    monkeypatch.setattr("app.routers.flow._tag_pool", _tag)

    db.execute(
        recommendation_events.insert().values(
            user_id=user.id,
            source="ytmusic",
            external_id="provider-blocked",
            title="blocked song",
            artist="BlockedArtist",
            event_type="skip",
            surface="library",
        )
    )
    db.commit()

    response = client.get(
        "/api/recommendations/?limit=5",
        headers=auth_headers(client, username="provider-recommendation-user"),
    )

    assert response.status_code == 200, response.text
    provider = [
        track for track in response.json()["tracks"]
        if track.get("external_id") == "provider-close"
    ]
    assert provider, response.json()
    assert provider[0]["source"] == "ytmusic"
    assert provider[0]["stream_url"].endswith("/api/ytdlp/stream/provider-close")
    assert not [
        track for track in response.json()["tracks"]
        if track.get("external_id") == "provider-blocked"
    ]
    assert not [
        track for track in response.json()["tracks"]
        if track.get("external_id") == "provider-close-sc"
    ]
    assert favorite_calls == []
    assert similar_calls == []


def test_popular_fallback_excludes_only_integer_ids(client, db, monkeypatch):
    """Внешние кандидаты (id-строки) не должны попадать в Track.id.in_().

    Боевая регрессия: внешние кандидаты попадали в candidate_pool, а добор
    популярным передавал их строковые id ("soundcloud:408415401") в
    ~Track.id.in_() вместе с целочисленными. Postgres отвечал
    "invalid input syntax for type integer" — эндпоинт падал 500, кэш не
    писался, и каждый заход на главную платил полный холодный путь. SQLite
    (тестовая БД) тип не проверяет, поэтому ловим утечку строк через шпион,
    а не через статус ответа.
    """
    from app.routers import recommendations as recommendations_router

    user = create_user(db, username="popular-fallback-int-ids-user")
    liked_pl = Playlist(name="Понравившиеся", is_public=False, is_liked=True, owner_id=user.id)
    db.add(liked_pl)
    db.commit()
    db.refresh(liked_pl)

    liked = _track(db, "liked-seed", "SeedArtist", play_count=1)
    db.execute(playlist_tracks.insert().values(
        playlist_id=liked_pl.id, track_id=liked.id, position=0))
    db.commit()

    async def _external_pool(*_args, **_kwargs):
        return [
            ExternalTrackResponse(
                id="soundcloud:408415401",
                source="soundcloud",
                external_id="408415401",
                title="external song",
                artist="ExternalArtist",
                duration=190,
                stream_url="https://soundcloud.example/stream",
            )
        ]

    monkeypatch.setattr(
        "app.routers.recommendations._external_recommendation_pool",
        _external_pool,
    )

    seen_exclude_ids = []
    original = recommendations_router._varied_popular

    def _spy(db, exclude_ids, *args, **kwargs):
        seen_exclude_ids.append(exclude_ids)
        return original(db, exclude_ids, *args, **kwargs)

    monkeypatch.setattr(recommendations_router, "_varied_popular", _spy)

    response = client.get(
        "/api/recommendations/",
        headers=auth_headers(client, username="popular-fallback-int-ids-user"),
    )

    assert response.status_code == 200, response.text
    # Пул кандидатов мал (только лайк + внешний трек) — добор популярным
    # обязан был сработать, иначе проверять нечего.
    assert seen_exclude_ids, "popular fallback did not run"
    for exclude_ids in seen_exclude_ids:
        assert all(
            isinstance(tid, int) for tid in exclude_ids
        ), f"non-integer Track.id leaked into SQL: {exclude_ids}"


def test_recommendations_use_real_artist_for_legacy_soundcloud_scope(
    client, db, monkeypatch
):
    """Legacy SoundCloud uploaders must not become the recommendation artist."""
    user = create_user(db, username="legacy-soundcloud-recommendation-user")
    imported = Playlist(
        name="Imported SoundCloud",
        description="Импортировано из SoundCloud",
        origin="imported",
        is_public=False,
        owner_id=user.id,
    )
    legacy_tracks = [
        Track(
            title=f"Kordhell - Imported {index}",
            artist="TrapNation",
            duration=180,
            source="soundcloud",
            external_id=f"legacy-kordhell-{index}",
            stream_url=f"https://soundcloud.test/legacy-{index}",
        )
        for index in range(3)
    ]
    candidate = Track(
        title="Murder In My Mind (another upload)",
        artist="Kordhell",
        duration=180,
        source="soundcloud",
        external_id="kordhell-candidate",
        stream_url="https://soundcloud.test/kordhell-candidate",
    )
    uploader_catalog = Track(
        title="TrapNation original",
        artist="TrapNation",
        duration=180,
        source="soundcloud",
        external_id="trapnation-candidate",
        stream_url="https://soundcloud.test/trapnation-candidate",
    )
    db.add_all([imported, *legacy_tracks, candidate, uploader_catalog])
    db.commit()
    db.execute(
        playlist_tracks.insert(),
        [
            {
                "playlist_id": imported.id,
                "track_id": track.id,
                "position": index,
            }
            for index, track in enumerate(legacy_tracks)
        ],
    )
    db.commit()

    async def _empty_external(*_args, **_kwargs):
        return []

    monkeypatch.setattr(
        "app.routers.recommendations._external_recommendation_pool",
        _empty_external,
    )

    response = client.get(
        "/api/recommendations/?limit=10",
        headers=auth_headers(client, username="legacy-soundcloud-recommendation-user"),
    )

    assert response.status_code == 200, response.text
    ids = {track["id"] for track in response.json()["tracks"]}
    assert candidate.id in ids
    assert uploader_catalog.id not in ids
