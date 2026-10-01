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


def test_recommendations_cold_start_varies_between_users(client, db):
    """Холодный старт без предпочтений — у каждого юзера свой набор.

    Раньше stable_jitter в _varied_popular был только тай-брейком: у юзера
    без сигналов score_track глобален и упорядочивает пул строго, без связей,
    поэтому все, кто пропустил онбординг, получали один и тот же список в
    одном и том же порядке (живая регрессия: «у всех юзеров на главной
    рекомендуются одинаковые треки»).
    """
    create_user(db, username="cold-one")
    create_user(db, username="cold-two")
    for i in range(30):
        _track(db, f"hit-{i}", f"Artist{i}", play_count=1000 - i)

    first = client.get(
        "/api/recommendations/", headers=auth_headers(client, username="cold-one")
    )
    second = client.get(
        "/api/recommendations/", headers=auth_headers(client, username="cold-two")
    )
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text

    first_ids = {t["id"] for t in first.json()["tracks"]}
    second_ids = {t["id"] for t in second.json()["tracks"]}
    assert first_ids and second_ids
    assert first_ids != second_ids, (
        "два холодных юзера без сигналов получили идентичную выдачу"
    )


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


def _liked_playlist(db, user):
    liked_pl = Playlist(
        name="Понравившиеся", is_public=False, is_liked=True, owner_id=user.id
    )
    db.add(liked_pl)
    db.commit()
    db.refresh(liked_pl)
    return liked_pl


def _stub_external_pool(monkeypatch, tracks):
    async def _external_pool(*_args, **_kwargs):
        return list(tracks)

    monkeypatch.setattr(
        "app.routers.recommendations._external_recommendation_pool",
        _external_pool,
    )


def _external(external_id, *, title=None, artist="ExternalArtist", play_count=0):
    return ExternalTrackResponse(
        id=f"ytmusic:{external_id}",
        source="ytmusic",
        external_id=external_id,
        title=title or f"song {external_id}",
        artist=artist,
        duration=190,
        stream_url="",
        play_count=play_count,
    )


def test_acoustic_candidates_respect_excluded_artists(client, db):
    """Акустический путь не обходит исключённых юзером артистов.

    Регрессия: акустический кандидат проходил в выдачу мимо keep_track, а
    вместе с ним — мимо проверки excluded_artists.
    """
    user = create_user(db, username="acoustic-excluded-user")
    user.excluded_artists = ["BannedArtist"]
    liked_pl = _liked_playlist(db, user)
    seed = Track(
        title="seed", artist="KnownArtist", duration=100, source="local",
        file_path="minio://music/ex-seed.mp3",
        acoustic_features=_features(tempo=0.2, brightness=0.2, bass=0.8),
    )
    banned = Track(
        title="banned close", artist="BannedArtist", duration=100, source="local",
        file_path="minio://music/ex-banned.mp3",
        acoustic_features=_features(tempo=0.21, brightness=0.2, bass=0.8),
    )
    allowed = Track(
        title="allowed close", artist="NewArtist", duration=100, source="local",
        file_path="minio://music/ex-allowed.mp3",
        acoustic_features=_features(tempo=0.22, brightness=0.21, bass=0.79),
    )
    db.add_all([seed, banned, allowed])
    db.commit()
    db.execute(playlist_tracks.insert().values(
        playlist_id=liked_pl.id, track_id=seed.id, position=0))
    db.commit()

    response = client.get(
        "/api/recommendations/",
        headers=auth_headers(client, username="acoustic-excluded-user"),
    )

    assert response.status_code == 200, response.text
    ids = {track["id"] for track in response.json()["tracks"]}
    assert allowed.id in ids
    assert banned.id not in ids


def test_acoustic_pool_skips_only_private_foreign_collections(client, db):
    """Трек из чужого ПУБЛИЧНОГО плейлиста — не приватная коллекция.

    Раньше акустический путь исключал любой трек из любого чужого плейлиста,
    и кандидатов почти не оставалось.
    """
    user = create_user(db, username="acoustic-privacy-user")
    other = create_user(db, username="acoustic-privacy-other")
    liked_pl = _liked_playlist(db, user)
    public_pl = Playlist(name="Public", is_public=True, owner_id=other.id)
    private_pl = Playlist(name="Private", is_public=False, owner_id=other.id)
    seed = Track(
        title="seed", artist="KnownArtist", duration=100, source="local",
        file_path="minio://music/pr-seed.mp3",
        acoustic_features=_features(tempo=0.2, brightness=0.2, bass=0.8),
    )
    in_public = Track(
        title="in public", artist="PublicArtist", duration=100, source="local",
        file_path="minio://music/pr-public.mp3",
        acoustic_features=_features(tempo=0.21, brightness=0.2, bass=0.8),
    )
    in_private = Track(
        title="in private", artist="PrivateArtist", duration=100, source="local",
        file_path="minio://music/pr-private.mp3",
        acoustic_features=_features(tempo=0.22, brightness=0.21, bass=0.79),
    )
    db.add_all([public_pl, private_pl, seed, in_public, in_private])
    db.commit()
    db.execute(playlist_tracks.insert(), [
        {"playlist_id": liked_pl.id, "track_id": seed.id, "position": 0},
        {"playlist_id": public_pl.id, "track_id": in_public.id, "position": 0},
        {"playlist_id": private_pl.id, "track_id": in_private.id, "position": 0},
    ])
    db.commit()

    response = client.get(
        "/api/recommendations/",
        headers=auth_headers(client, username="acoustic-privacy-user"),
    )

    assert response.status_code == 200, response.text
    ids = {track["id"] for track in response.json()["tracks"]}
    assert in_public.id in ids
    assert in_private.id not in ids


def test_candidate_window_is_not_frozen_on_oldest_rows(client, db, monkeypatch):
    """Новые треки любимого артиста доходят до ранжирования.

    Регрессия: окно `ORDER BY id LIMIT 500` после SQL-предфильтра, который
    пропускает ВСЕ soundcloud-треки, целиком занимали старейшие чужие
    загрузки, а новый трек любимого артиста в выборку не попадал. Внешних
    кандидатов достаточно, чтобы добор популярным не спасал его сам.
    """
    _stub_external_pool(
        monkeypatch, [_external(f"filler-{index}") for index in range(12)]
    )
    user = create_user(db, username="window-user")
    liked_pl = _liked_playlist(db, user)
    seed = _track(db, "fav seed", "FavArtist", play_count=1)
    db.execute(playlist_tracks.insert().values(
        playlist_id=liked_pl.id, track_id=seed.id, position=0))
    db.add_all([
        Track(
            title=f"junk upload {index}", artist=f"Uploader{index}",
            duration=100, source="soundcloud", external_id=f"junk-{index}",
        )
        for index in range(600)
    ])
    db.commit()
    newest = _track(db, "fav newest", "FavArtist", play_count=1)

    response = client.get(
        "/api/recommendations/?limit=5",
        headers=auth_headers(client, username="window-user"),
    )

    assert response.status_code == 200, response.text
    assert newest.id in {track["id"] for track in response.json()["tracks"]}


def test_external_popularity_uses_provider_scale(client, db, monkeypatch):
    """Просмотры провайдера оцениваются на своей шкале, а не на локальной.

    Регрессия: при локальной шкале (400 прослушиваний) трек с 500 и с
    2 млн просмотров получали одинаковую, максимальную популярность.
    """
    _stub_external_pool(monkeypatch, [
        _external("viral", play_count=2_000_000),
        _external("nobody", play_count=500),
    ])
    user = create_user(db, username="external-popularity-user")
    liked_pl = _liked_playlist(db, user)
    seed = _track(db, "seed", "SeedArtist", play_count=1)
    db.execute(playlist_tracks.insert().values(
        playlist_id=liked_pl.id, track_id=seed.id, position=0))
    db.commit()

    response = client.get(
        "/api/recommendations/",
        headers=auth_headers(client, username="external-popularity-user"),
    )

    assert response.status_code == 200, response.text
    scores = {
        track.get("external_id"): track["recommendation_score"]
        for track in response.json()["tracks"]
    }
    assert scores["viral"] > scores["nobody"]


def test_undisliked_external_track_returns(client, db, monkeypatch):
    """Снятый дизлайк внешнего трека снимает и исключение из выдачи."""
    from datetime import datetime, timedelta, timezone

    _stub_external_pool(monkeypatch, [
        _external("forgiven"),
        _external("still-disliked"),
    ])
    user = create_user(db, username="undislike-user")
    liked_pl = _liked_playlist(db, user)
    seed = _track(db, "seed", "SeedArtist", play_count=1)
    db.execute(playlist_tracks.insert().values(
        playlist_id=liked_pl.id, track_id=seed.id, position=0))
    now = datetime.now(timezone.utc)
    for external_id, event_type, age in (
        ("forgiven", "dislike", 2),
        ("forgiven", "undislike", 1),
        ("still-disliked", "dislike", 1),
    ):
        db.execute(recommendation_events.insert().values(
            user_id=user.id, source="ytmusic", external_id=external_id,
            title=f"song {external_id}", artist="ExternalArtist",
            event_type=event_type, surface="library",
            occurred_at=now - timedelta(minutes=age),
        ))
    db.commit()

    response = client.get(
        "/api/recommendations/",
        headers=auth_headers(client, username="undislike-user"),
    )

    assert response.status_code == 200, response.text
    external_ids = {track.get("external_id") for track in response.json()["tracks"]}
    assert "forgiven" in external_ids
    assert "still-disliked" not in external_ids


def test_external_pool_excludes_whole_collection(client, db, monkeypatch):
    """Внешний трек из коллекции не возвращается, даже если он за пределами
    первых _TASTE_QUERY_LIMIT строк сигналов вкуса (большой импорт)."""
    from datetime import datetime, timedelta, timezone
    from app.routers import recommendations as recommendations_router

    monkeypatch.setattr(recommendations_router, "_TASTE_QUERY_LIMIT", 5)
    _stub_external_pool(monkeypatch, [
        _external("old-owned", title="old owned song", artist="OwnedArtist"),
        _external("fresh", title="fresh song", artist="OwnedArtist"),
    ])
    user = create_user(db, username="big-import-user")
    imported = Playlist(
        name="Imported", origin="imported", is_public=False, owner_id=user.id
    )
    db.add(imported)
    db.commit()
    tracks = [
        Track(
            title="old owned song" if index == 0 else f"owned {index}",
            artist="OwnedArtist", duration=100, source="ytmusic",
            external_id="old-owned" if index == 0 else f"owned-{index}",
        )
        for index in range(10)
    ]
    db.add_all(tracks)
    db.commit()
    now = datetime.now(timezone.utc)
    db.execute(playlist_tracks.insert(), [
        {
            "playlist_id": imported.id,
            "track_id": track.id,
            "position": index,
            # Трек 0 добавлен раньше всех — за пределами лимита.
            "added_at": now - timedelta(days=100 - index),
        }
        for index, track in enumerate(tracks)
    ])
    db.commit()

    response = client.get(
        "/api/recommendations/",
        headers=auth_headers(client, username="big-import-user"),
    )

    assert response.status_code == 200, response.text
    external_ids = {track.get("external_id") for track in response.json()["tracks"]}
    assert "fresh" in external_ids
    assert "old-owned" not in external_ids
    returned_ids = {track["id"] for track in response.json()["tracks"]}
    assert not returned_ids & {track.id for track in tracks}, (
        "свои треки из коллекции вернулись в выдачу"
    )


def test_recommendations_limit_is_bounded(client, db):
    create_user(db, username="limit-user")
    headers = auth_headers(client, username="limit-user")

    assert client.get("/api/recommendations/?limit=10000", headers=headers).status_code == 422
    assert client.get("/api/recommendations/?limit=0", headers=headers).status_code == 422
    assert client.get("/api/recommendations/tracks?limit=10000", headers=headers).status_code == 422


def test_playlist_recommendations_skip_own_and_empty(client, db):
    """В рекомендациях плейлистов нет своих и пустых, и эндпоинт не пишет
    строк выдачи треков, которых никто не видел."""
    from sqlalchemy import func, select
    from app.models import recommendation_impressions

    user = create_user(db, username="playlist-recs-user")
    other = create_user(db, username="playlist-recs-other")
    own = Playlist(name="Own public", is_public=True, owner_id=user.id)
    empty = Playlist(name="Empty", is_public=True, owner_id=other.id)
    filled = Playlist(name="Filled", is_public=True, owner_id=other.id)
    db.add_all([own, empty, filled])
    db.commit()
    track = _track(db, "some song", "SomeArtist", play_count=1)
    db.execute(playlist_tracks.insert(), [
        {"playlist_id": own.id, "track_id": track.id, "position": 0},
        {"playlist_id": filled.id, "track_id": track.id, "position": 0},
    ])
    db.commit()

    headers = auth_headers(client, username="playlist-recs-user")
    playlists = client.get("/api/recommendations/playlists", headers=headers)
    assert playlists.status_code == 200, playlists.text
    assert [p["id"] for p in playlists.json()] == [filled.id]
    assert db.execute(
        select(func.count()).select_from(recommendation_impressions)
    ).scalar() == 0

    home = client.get("/api/recommendations/", headers=headers)
    assert home.status_code == 200, home.text
    assert [p["id"] for p in home.json()["playlists"]] == [filled.id]


def test_artist_skips_lower_score_of_untrusted_artist(client, db, monkeypatch):
    """Скипы артиста снижают score его треков и не делают его «новым».

    Регрессия: штраф артисту за скипы участвовал только в решении о доверии,
    а недоверенный артист считался новым и получал бонус новизны — у
    заскипанного артиста score оказывался ВЫШЕ, чем у такого же без скипов.
    """
    from app.routers import recommendations as recommendations_router

    monkeypatch.setattr(
        recommendations_router, "build_keyword_filters", lambda *_args, **_kwargs: []
    )
    _stub_external_pool(monkeypatch, [])
    user = create_user(db, username="artist-skips-user")
    user.preferred_genres = ["rock"]
    db.commit()

    skipped_seed = _track(db, "s played", "SkippedArtist", play_count=1, genre="rock")
    skipped_other = _track(db, "s skipped", "SkippedArtist", play_count=1, genre="rock")
    skipped_candidate = _track(db, "s candidate", "SkippedArtist", play_count=1, genre="rock")
    clean_seed = _track(db, "t played", "CleanArtist", play_count=1, genre="rock")
    clean_candidate = _track(db, "t candidate", "CleanArtist", play_count=1, genre="rock")
    db.execute(user_track_plays.insert(), [
        {"user_id": user.id, "track_id": skipped_seed.id, "play_count": 2},
        {"user_id": user.id, "track_id": clean_seed.id, "play_count": 2},
    ])
    db.execute(user_track_skips.insert().values(
        user_id=user.id, track_id=skipped_other.id, skip_count=3))
    db.commit()

    response = client.get(
        "/api/recommendations/",
        headers=auth_headers(client, username="artist-skips-user"),
    )

    assert response.status_code == 200, response.text
    scores = {
        track["id"]: track["recommendation_score"]
        for track in response.json()["tracks"]
    }
    assert clean_candidate.id in scores
    assert scores.get(skipped_candidate.id, float("-inf")) < scores[clean_candidate.id]


def _own_playlist(db, user, artist, titles):
    playlist = Playlist(name=f"own-{artist}", is_public=False, is_liked=False, owner_id=user.id)
    db.add(playlist)
    db.commit()
    for position, title in enumerate(titles):
        track = _track(db, f"{artist} {title}", artist)
        db.execute(playlist_tracks.insert().values(
            playlist_id=playlist.id, track_id=track.id, position=position
        ))
    db.commit()


def test_home_keeps_only_hits_of_non_favorite_artists(client, db, monkeypatch):
    """Лента живёт по тому же мейнстрим-правилу, что и волна."""
    from app import mainstream

    user = create_user(db, username="home-mainstream-user")
    _own_playlist(db, user, "FavArtist", [f"own {i}" for i in range(5)])

    pool_kwargs = {}

    async def _external_pool(*_args, **kwargs):
        pool_kwargs.update(kwargs)
        return [
            *(_external(f"hit{i}", title=f"Hit {i}", artist="Famous") for i in range(6)),
            _external("deep", title="Deep cut", artist="Famous"),
            _external("demo", title="Garage demo", artist="Nobody", play_count=0),
            _external("rare", title="Rare b-side", artist="FavArtist"),
        ]

    async def _hits(artists, timeout):
        info = {
            "famous": {"listeners": 2_000_000, "top": [f"Hit {i}" for i in range(6)]},
            "nobody": {"listeners": 300, "top": ["Garage demo"]},
        }
        assert "favartist" not in set(artists)
        return {key: info.get(key) for key in artists}

    monkeypatch.setattr(
        "app.routers.recommendations._external_recommendation_pool", _external_pool
    )
    monkeypatch.setattr(mainstream, "available", lambda: True)
    monkeypatch.setattr(mainstream, "artist_hits", _hits)

    resp = client.get(
        "/api/recommendations/?limit=5",
        headers=auth_headers(client, username="home-mainstream-user"),
    )
    assert resp.status_code == 200, resp.text
    titles = {t["title"] for t in resp.json()["tracks"]}
    assert titles, "лента пустая"
    assert not titles & {"Deep cut", "Garage demo"}, titles
    assert pool_kwargs.get("hits_seed_artists") == ("favartist",)


def test_home_external_pool_puts_similar_hits_first(monkeypatch):
    import asyncio

    from app import mainstream
    from app.routers import flow as flow_router
    from app.routers import recommendations as recs

    async def _hits_pool(request, artist):
        assert artist == "favartist"
        return [_external("nb1", title="Big hit", artist="Neighbour")]

    async def _lastfm(request, artist, title):
        return [_external("lf1", title="Similar", artist="Other")]

    async def _empty(*args, **kwargs):
        return []

    monkeypatch.setattr(mainstream, "available", lambda: True)
    monkeypatch.setattr(flow_router, "_similar_hits_pool", _hits_pool)
    monkeypatch.setattr(flow_router, "_lastfm_pool", _lastfm)
    monkeypatch.setattr(flow_router, "_favorite_artist_pool", _empty)
    monkeypatch.setattr(flow_router, "_similar_pool", _empty)
    monkeypatch.setattr(flow_router, "_tag_pool", _empty)
    monkeypatch.setattr(flow_router.ytdlp, "_schedule_audio_matches", lambda items: None)

    class _Request:
        base_url = "http://test/"

    track = Track(title="seed song", artist="SeedArtist", duration=100, source="local")
    pool = asyncio.run(recs._external_recommendation_pool(
        _Request(),
        liked=[(track, None)],
        playlisted=[],
        played=[],
        preferred_artists=[],
        preferred_genres=[],
        limit=5,
        excluded_external=set(),
        hits_seed_artists=("favartist",),
    ))

    assert [t.title for t in pool][:2] == ["Big hit", "Similar"]
