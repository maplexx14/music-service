"""/api/recommendations/flow: выдача продолжает работать после того, как
эндпоинт отдаёт соединение БД обратно в пул перед сетевой разведкой.

Регрессия, которую ловим: flow закрывает сессию сразу после _taste_profile
(иначе соединение висит в `idle in transaction` все секунды ожидания YT
Music/SoundCloud). После этого он всё ещё обращается к БД в
_local_candidates и к current_user.id — если закрытие что-то ломает, тест
падает на пустой выдаче или на DetachedInstanceError.
"""

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from app.cache import clear_pattern
from app.discovery import DEFAULT_DISCOVERY_RATIO, discovery_slots, liked_slots
from app.models import (
    Track,
    Playlist,
    playlist_tracks,
    recommendation_events,
    recommendation_impressions,
    user_track_plays,
    user_track_skips,
)
from app.routers.flow import (
    _LIKED_REPLAY_COOLDOWN_DAYS,
    _liked_candidates,
    _persisted_flow_history,
    _taste_profile,
)
from app.schemas import ExternalTrackResponse

from tests.conftest import auth_headers, create_user


@pytest.fixture(autouse=True)
def _clear_flow_cache():
    # Redis общий между тестами, а id юзеров переиспользуются — история потока
    # от прошлого прогона иначе исключает всю выдачу.
    clear_pattern("flow:*")
    yield
    clear_pattern("flow:*")


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    # Разведка flow ходит в YT Music и SoundCloud. Тест про работу с БД —
    # сеть отключаем, остаётся локальный путь (тот самый, что идёт ПОСЛЕ
    # db.close()).
    async def _empty(*args, **kwargs):
        return []

    monkeypatch.setattr("app.routers.flow._radio_pool", _empty)
    monkeypatch.setattr("app.routers.flow._similar_pool", _empty)
    monkeypatch.setattr("app.routers.flow._artist_seed_videos", _empty)
    monkeypatch.setattr("app.routers.flow._soundcloud_pool", _empty)
    monkeypatch.setattr("app.routers.flow._favorite_artist_pool", _empty)
    monkeypatch.setattr("app.routers.flow._tag_pool", _empty)
    monkeypatch.setattr("app.routers.flow._lastfm_pool", _empty)


def _external(artist, title, external_id):
    return ExternalTrackResponse(
        id=f"ytmusic:{external_id}",
        source="ytmusic",
        external_id=external_id,
        title=title,
        artist=artist,
        duration=180,
        stream_url="",
    )


def _liked(db, user, artist="GoodArtist", title="liked-song"):
    """Курированный трек — минимальный профиль вкуса (артист с весом > 0)."""
    playlist = Playlist(name="Понравившиеся", is_public=False, is_liked=True, owner_id=user.id)
    db.add(playlist)
    db.commit()
    db.refresh(playlist)
    track = Track(title=title, artist=artist, duration=100, source="local")
    db.add(track)
    db.commit()
    db.execute(
        playlist_tracks.insert().values(
            playlist_id=playlist.id, track_id=track.id, position=0
        )
    )
    db.commit()
    return playlist, track


def test_persisted_flow_history_missing_table_preserves_outer_transaction(db):
    """Rolling deploys may hit a DB before recommendation telemetry migrates."""
    user = create_user(db, username="legacy-schema-flow-user")
    user.full_name = "must survive probe"
    # The fixture creates telemetry tables, so emulate an older schema by
    # removing just the optional table after the pending user update.
    db.execute(text("DROP TABLE recommendation_impressions"))

    assert _persisted_flow_history(db, user.id, 10) == {}
    db.commit()

    db.refresh(user)
    assert user.full_name == "must survive probe"


def test_flow_uses_one_score_instead_of_source_slots(client, db, monkeypatch):
    user = create_user(db, username="quota-user")
    _liked(db, user, artist="LovedArtist")

    async def _lastfm(request, artist, title):
        return [
            _external(f"Similar{i}", f"similar-{i}", f"lfm{i}")
            for i in range(20)
        ]

    async def _favorite(request, artist):
        assert artist == "LovedArtist"
        return [
            _external(f"Catalog{i}", f"catalog-{i}", f"favorite{i}")
            for i in range(20)
        ]

    bonuses = {}

    def _score(item, **kwargs):
        external_id = getattr(item, "external_id", None)
        bonuses[external_id or getattr(item, "title", "")] = kwargs.get(
            "content_bonus"
        )
        if external_id and external_id.startswith("favorite"):
            return 100.0 - int(external_id.removeprefix("favorite"))
        if external_id and external_id.startswith("lfm"):
            return 0.0
        return -10.0

    monkeypatch.setattr("app.routers.flow._lastfm_pool", _lastfm)
    monkeypatch.setattr("app.routers.flow._favorite_artist_pool", _favorite)
    monkeypatch.setattr("app.routers.flow.score_track", _score)

    resp = client.get(
        "/api/recommendations/flow?limit=15",
        headers=auth_headers(client, username="quota-user"),
    )
    assert resp.status_code == 200, resp.text
    tracks = resp.json()
    assert len(tracks) == 15
    assert all(
        str(track.get("external_id") or "").startswith("favorite")
        for track in tracks
    ), tracks
    assert bonuses["favorite0"] == pytest.approx(0.12)
    assert bonuses["lfm0"] == pytest.approx(0.08)


def test_flow_spreads_comparable_catalog_candidates_across_artists(
    client, db, monkeypatch
):
    """Мягкая диверсификация сохраняет разные имена при близком score."""
    user = create_user(db, username="diverse-favorites-user")
    playlist = Playlist(
        name="Понравившиеся", is_public=False, is_liked=True, owner_id=user.id
    )
    db.add(playlist)
    db.commit()
    db.refresh(playlist)
    liked = [
        Track(
            title=f"liked-{i}",
            artist=f"LovedArtist{i}",
            duration=100,
            source="local",
            file_path=f"minio://music/liked-{i}.mp3",
        )
        for i in range(7)
    ]
    db.add_all(liked)
    db.commit()
    db.execute(
        playlist_tracks.insert(),
        [
            {"playlist_id": playlist.id, "track_id": track.id, "position": i}
            for i, track in enumerate(liked)
        ],
    )
    db.commit()

    async def _favorite(request, artist):
        return [_external(artist, f"new-{artist}", f"favorite-{artist}")]

    monkeypatch.setattr("app.routers.flow._favorite_artist_pool", _favorite)
    response = client.get(
        "/api/recommendations/flow?limit=15",
        headers=auth_headers(client, username="diverse-favorites-user"),
    )
    assert response.status_code == 200, response.text
    favorite = [
        track for track in response.json()
        if str(track.get("external_id") or "").startswith("favorite-")
    ]
    assert len(favorite) == 7
    assert len({track["artist"] for track in favorite}) == 7


def test_flow_gives_liked_tracks_their_share_next_to_unplayed_library(client, db):
    """Понравившееся попадает в поток по своей квоте, остальное — неслышанное.

    Регрессия, которую ловим: лайк исключался из потока тремя способами сразу
    (по id в каталожной выборке, как трек плейлиста и по нормализованному ключу
    от провайдеров), поэтому в волне не появлялся НИ ПРИ КАКОМ положении
    ползунка — пользователь не слышал в ней ничего из того, что сам отметил.
    Ровно liked_slots штук, не больше: волна остаётся волной, а не повтором
    плейлиста лайков.
    """
    user = create_user(db, username="likes-and-new-user")
    playlist = Playlist(
        name="Понравившиеся",
        is_public=False,
        is_liked=True,
        owner_id=user.id,
    )
    db.add(playlist)
    db.commit()
    db.refresh(playlist)

    liked = [
        Track(
            title=f"liked-{i}",
            artist="KnownArtist",
            duration=100,
            source="local",
            file_path=f"minio://music/liked-{i}.mp3",
        )
        for i in range(20)
    ]
    fresh = [
        Track(
            title=f"fresh-{i}",
            artist="KnownArtist",
            duration=100,
            source="local",
            file_path=f"minio://music/fresh-{i}.mp3",
        )
        for i in range(20)
    ]
    db.add_all([*liked, *fresh])
    db.commit()
    db.execute(
        playlist_tracks.insert(),
        [
            {"playlist_id": playlist.id, "track_id": track.id, "position": i}
            for i, track in enumerate(liked)
        ],
    )
    db.commit()

    response = client.get(
        "/api/recommendations/flow?limit=15",
        headers=auth_headers(client, username="likes-and-new-user"),
    )
    assert response.status_code == 200, response.text
    tracks = response.json()
    expected_liked = liked_slots(15, DEFAULT_DISCOVERY_RATIO)
    assert expected_liked, "на дефолтном ползунке квота лайков не может быть нулевой"
    liked_count = sum(track["title"].startswith("liked-") for track in tracks)
    fresh_count = sum(track["title"].startswith("fresh-") for track in tracks)
    assert len(tracks) == 15
    assert liked_count == expected_liked, tracks
    assert fresh_count == 15 - expected_liked, tracks


def test_flow_liked_share_follows_the_slider_not_only_its_end(client, db):
    """Доля лайков растёт к «знакомому» краю плавно, а не появляется в крайнем.

    Ровно та жалоба, из-за которой квота и появилась: понравившееся не
    попадалось в поток, пока ползунок не выкручен полностью в знакомое. Здесь
    один и тот же пул опрашивается на трёх положениях, и лайки обязаны быть
    и на дефолтном — а на максимуме разведки обязаны исчезнуть совсем.
    """
    user = create_user(db, username="slider-share-user")
    playlist = Playlist(
        name="Понравившиеся",
        is_public=False,
        is_liked=True,
        owner_id=user.id,
    )
    db.add(playlist)
    db.commit()
    db.refresh(playlist)
    liked = [
        Track(
            title=f"liked-{i}",
            artist="KnownArtist",
            duration=100,
            source="local",
            file_path=f"minio://music/slider-liked-{i}.mp3",
        )
        for i in range(20)
    ]
    fresh = [
        Track(
            title=f"fresh-{i}",
            artist="KnownArtist",
            duration=100,
            source="local",
            file_path=f"minio://music/slider-fresh-{i}.mp3",
        )
        for i in range(20)
    ]
    db.add_all([*liked, *fresh])
    db.commit()
    db.execute(
        playlist_tracks.insert(),
        [
            {"playlist_id": playlist.id, "track_id": track.id, "position": i}
            for i, track in enumerate(liked)
        ],
    )
    db.commit()

    headers = auth_headers(client, username="slider-share-user")
    counted = {}
    for ratio in (0.0, DEFAULT_DISCOVERY_RATIO, 1.0):
        # Через API, а не мутацией ORM-объекта: flow закрывает сессию внутри
        # запроса, после чего user становится detached, и db.commit() уже ничего
        # не сохраняет — ползунок молча оставался бы прежним на всех итерациях.
        saved = client.put(
            "/api/users/me/preferences",
            headers=headers,
            json={"discovery_ratio": ratio},
        )
        assert saved.status_code == 200, saved.text
        assert saved.json()["discovery_ratio"] == ratio
        # История потока живёт в Redis и между запросами одного теста
        # сохраняется; локальные id она не исключает, но чистим ради
        # независимости трёх замеров друг от друга.
        clear_pattern("flow:*")
        response = client.get(
            "/api/recommendations/flow?limit=15",
            headers=headers,
        )
        assert response.status_code == 200, response.text
        tracks = response.json()
        assert len(tracks) == 15, (ratio, tracks)
        counted[ratio] = sum(
            track["title"].startswith("liked-") for track in tracks
        )

    assert counted[0.0] > counted[DEFAULT_DISCOVERY_RATIO] > counted[1.0]
    assert counted[DEFAULT_DISCOVERY_RATIO] > 0, counted
    assert counted[1.0] == 0, counted


def test_liked_candidates_respect_dislikes_and_the_replay_cooldown(db):
    """Квота лайков не возвращает отвергнутое и не крутит только что сыгранное.

    Лайк «разрешён» в потоке в обход played_ids/collection_track_ids, и легко
    было бы вместе с ними обойти и отрицательные сигналы. Проверяем прямо на
    выборке: дизлайкнутый не проходит совсем, сыгранный внутри кулдауна — пока
    нет, а остывший — да, причём ни разу не игранный идёт впереди.
    """
    user = create_user(db, username="liked-negatives-user")
    playlist = Playlist(
        name="Понравившиеся",
        is_public=False,
        is_liked=True,
        owner_id=user.id,
    )
    db.add(playlist)
    db.commit()
    db.refresh(playlist)
    tracks = {
        name: Track(
            title=name,
            artist="KnownArtist",
            duration=100,
            source="local",
            file_path=f"minio://music/{name}.mp3",
        )
        for name in ("hated", "inside-cooldown", "cooled-down", "never-played")
    }
    db.add_all(tracks.values())
    db.commit()
    db.execute(
        playlist_tracks.insert(),
        [
            {"playlist_id": playlist.id, "track_id": track.id, "position": position}
            for position, track in enumerate(tracks.values())
        ],
    )
    now = datetime.now(timezone.utc)
    db.execute(
        user_track_skips.insert().values(
            user_id=user.id,
            track_id=tracks["hated"].id,
            skip_count=1,
            disliked=True,
            last_skipped=now,
        )
    )
    db.execute(
        user_track_plays.insert(),
        [
            {
                "user_id": user.id,
                "track_id": tracks["inside-cooldown"].id,
                "play_count": 1,
                "last_played": now - timedelta(days=_LIKED_REPLAY_COOLDOWN_DAYS - 1),
            },
            {
                "user_id": user.id,
                "track_id": tracks["cooled-down"].id,
                "play_count": 1,
                "last_played": now - timedelta(days=_LIKED_REPLAY_COOLDOWN_DAYS + 1),
            },
        ],
    )
    db.commit()

    profile = _taste_profile(db, user.id)
    # Четыре лайка перевешивают один дизлайк, иначе артист ушёл бы в
    # banned_artists и выборка была бы пустой по постороннему поводу.
    assert "knownartist" not in profile["banned_artists"]
    titles = [track.title for track in _liked_candidates(db, profile, 10)]
    assert "hated" not in titles, titles
    assert "inside-cooldown" not in titles, titles
    # Ни разу не игранный лайк — впереди остывшего.
    assert titles == ["never-played", "cooled-down"], titles


def test_flow_returns_liked_tracks_the_user_has_already_played(client, db):
    """Остывший лайк возвращается в поток, даже если он весь в recent_ids.

    Вторая половина той же регрессии, и в жизни она и есть основной случай:
    лайк ставят ПОСЛЕ прослушивания, поэтому почти каждый лайк лежит в
    recent_ids — «последние 100 прослушиваний ∪ скипы ∪ треки плейлистов». Пока
    квота лайков получала тот же список исключений, что и каталожный запрос,
    услышанный однажды лайк не возвращался, пока его не вытеснит сотня чужих
    прослушиваний, — а у юзера с короткой историей не возвращался никогда. Здесь
    сыграно всё понравившееся и давно (кулдаун пройден), история короче окна.
    """
    user = create_user(db, username="liked-replay-user")
    playlist = Playlist(
        name="Понравившиеся",
        is_public=False,
        is_liked=True,
        owner_id=user.id,
    )
    db.add(playlist)
    db.commit()
    db.refresh(playlist)
    liked = [
        Track(
            title=f"liked-{i}",
            artist="KnownArtist",
            duration=100,
            source="local",
            file_path=f"minio://music/replay-liked-{i}.mp3",
        )
        for i in range(8)
    ]
    fresh = [
        Track(
            title=f"fresh-{i}",
            artist="KnownArtist",
            duration=100,
            source="local",
            file_path=f"minio://music/replay-fresh-{i}.mp3",
        )
        for i in range(20)
    ]
    db.add_all([*liked, *fresh])
    db.commit()
    db.execute(
        playlist_tracks.insert(),
        [
            {"playlist_id": playlist.id, "track_id": track.id, "position": i}
            for i, track in enumerate(liked)
        ],
    )
    played_at = datetime.now(timezone.utc) - timedelta(
        days=_LIKED_REPLAY_COOLDOWN_DAYS + 30
    )
    db.execute(
        user_track_plays.insert(),
        [
            {
                "user_id": user.id,
                "track_id": track.id,
                "play_count": 2,
                "last_played": played_at,
            }
            for track in liked
        ],
    )
    db.commit()

    profile = _taste_profile(db, user.id)
    # Смысл теста держится на этом: все лайки действительно лежат в recent_ids,
    # то есть путь, по которому их раньше отсекало, реально задействован.
    assert {track.id for track in liked} <= set(profile["recent_ids"])

    response = client.get(
        "/api/recommendations/flow?limit=15",
        headers=auth_headers(client, username="liked-replay-user"),
    )
    assert response.status_code == 200, response.text
    tracks = response.json()
    expected_liked = liked_slots(15, DEFAULT_DISCOVERY_RATIO)
    assert len(tracks) == 15
    assert (
        sum(track["title"].startswith("liked-") for track in tracks) == expected_liked
    ), tracks


def test_flow_liked_quota_still_respects_the_client_queue(client, db):
    """Стоящий в очереди лайк квота не выдаёт второй раз.

    Из исключений для лайков остался ровно один список — клиентский exclude, и
    он обязан работать: иначе трек, уже стоящий в очереди у фронта, пришёл бы в
    той же волне ещё раз.
    """
    user = create_user(db, username="liked-queue-user")
    playlist = Playlist(
        name="Понравившиеся",
        is_public=False,
        is_liked=True,
        owner_id=user.id,
    )
    db.add(playlist)
    db.commit()
    db.refresh(playlist)
    liked = [
        Track(
            title=f"liked-{i}",
            artist="KnownArtist",
            duration=100,
            source="local",
            file_path=f"minio://music/queued-liked-{i}.mp3",
        )
        for i in range(6)
    ]
    fresh = [
        Track(
            title=f"fresh-{i}",
            artist="KnownArtist",
            duration=100,
            source="local",
            file_path=f"minio://music/queued-fresh-{i}.mp3",
        )
        for i in range(20)
    ]
    db.add_all([*liked, *fresh])
    db.commit()
    db.execute(
        playlist_tracks.insert(),
        [
            {"playlist_id": playlist.id, "track_id": track.id, "position": i}
            for i, track in enumerate(liked)
        ],
    )
    db.commit()

    headers = auth_headers(client, username="liked-queue-user")
    first = client.get("/api/recommendations/flow?limit=15", headers=headers)
    assert first.status_code == 200, first.text
    queued = [
        track for track in first.json() if track["title"].startswith("liked-")
    ]
    assert queued, first.json()

    exclude = ",".join(str(track["id"]) for track in queued)
    second = client.get(
        f"/api/recommendations/flow?limit=15&exclude={exclude}",
        headers=headers,
    )
    assert second.status_code == 200, second.text
    returned_titles = {track["title"] for track in second.json()}
    assert not returned_titles & {track["title"] for track in queued}, returned_titles


def test_flow_returns_liked_provider_tracks_not_only_local_files(client, db):
    """Лайк из YT Music/SoundCloud доходит до потока так же, как локальный файл.

    Ловушка, на которую квота лайков натыкалась: excl_videos держит
    collection_external_ids — provider id ВСЕГО, что лежит в плейлистах юзера,
    лайки в том числе. На локальных файлах (external_id пуст) это незаметно, а
    у лайка из провайдера отсекало бы каждый — то есть подавляющее большинство
    реальных лайков в этом сервисе.
    """
    user = create_user(db, username="liked-provider-user")
    playlist = Playlist(
        name="Понравившиеся",
        is_public=False,
        is_liked=True,
        owner_id=user.id,
    )
    db.add(playlist)
    db.commit()
    db.refresh(playlist)
    liked = Track(
        title="лайк из ютуба",
        artist="ProviderArtist",
        duration=100,
        source="ytmusic",
        external_id="liked-video-id",
    )
    # Второй трек того же артиста, не лайкнутый: иначе выдача состояла бы из
    # одного лайка и тест прошёл бы даже при сломанном каталожном пути.
    fresh = Track(
        title="ещё трек того же артиста",
        artist="ProviderArtist",
        duration=100,
        source="ytmusic",
        external_id="fresh-video-id",
    )
    db.add_all([liked, fresh])
    db.commit()
    db.execute(
        playlist_tracks.insert().values(
            playlist_id=playlist.id, track_id=liked.id, position=0
        )
    )
    db.commit()

    response = client.get(
        "/api/recommendations/flow?limit=5",
        headers=auth_headers(client, username="liked-provider-user"),
    )
    assert response.status_code == 200, response.text
    external_ids = {track.get("external_id") for track in response.json()}
    assert "liked-video-id" in external_ids, external_ids

    # Обратная сторона того же вычитания: provider id лайка лежит и в коллекции,
    # и в клиентском exclude, поэтому «вычесть коллекцию» нельзя так, чтобы
    # заодно потерялась очередь фронта. Иначе стоящая в очереди копия от
    # провайдера и лайкнутая строка пришли бы в волне как два трека.
    queued = client.get(
        "/api/recommendations/flow?limit=5&exclude=ytmusic:liked-video-id",
        headers=auth_headers(client, username="liked-provider-user"),
    )
    assert queued.status_code == 200, queued.text
    queued_ids = {track.get("external_id") for track in queued.json()}
    assert "liked-video-id" not in queued_ids, queued_ids


def test_flow_excludes_imported_tracks_but_keeps_their_artist_signal(client, db):
    """Imported tracks shape the scope without being replayed verbatim."""
    user = create_user(db, username="imported-exclusion-user")
    imported = Playlist(
        name="Imported",
        description="Импортировано из SoundCloud",
        origin="imported",
        is_public=False,
        owner_id=user.id,
    )
    imported_track = Track(
        title="imported-song",
        artist="ImportedArtist",
        duration=100,
        source="local",
        file_path="minio://music/imported-song.mp3",
    )
    fresh = [
        Track(
            title=f"fresh-imported-{index}",
            artist="ImportedArtist",
            duration=100,
            source="local",
            file_path=f"minio://music/fresh-imported-{index}.mp3",
        )
        for index in range(6)
    ]
    db.add_all([imported, imported_track, *fresh])
    db.commit()
    db.execute(
        playlist_tracks.insert().values(
            playlist_id=imported.id,
            track_id=imported_track.id,
            position=0,
        )
    )
    db.commit()

    response = client.get(
        "/api/recommendations/flow?limit=5",
        headers=auth_headers(client, username="imported-exclusion-user"),
    )
    assert response.status_code == 200, response.text
    tracks = response.json()
    assert tracks
    assert all(track["title"] != "imported-song" for track in tracks)
    assert any(track["artist"] == "ImportedArtist" for track in tracks)


def test_flow_returns_local_tracks_after_session_close(client, db):
    user = create_user(db)

    liked_pl = Playlist(name="Понравившиеся", is_public=False, is_liked=True, owner_id=user.id)
    db.add(liked_pl)
    db.commit()
    db.refresh(liked_pl)

    # file_path обязателен: без него _media_available отбрасывает локальный трек
    # как «нечего играть», и тест про сессию БД падал бы на пустой выдаче по
    # совершенно посторонней причине. minio-путь не требует файла на диске.
    liked = Track(
        title="liked-song",
        artist="GoodArtist",
        duration=100,
        source="local",
        file_path="minio://music/liked-song.mp3",
    )
    same_artist = Track(
        title="another-song",
        artist="GoodArtist",
        duration=100,
        source="local",
        file_path="minio://music/another-song.mp3",
    )
    db.add_all([liked, same_artist])
    db.commit()
    db.execute(
        playlist_tracks.insert().values(playlist_id=liked_pl.id, track_id=liked.id, position=0)
    )
    db.commit()

    resp = client.get("/api/recommendations/flow?limit=5", headers=auth_headers(client))
    assert resp.status_code == 200, resp.text

    mix = resp.json()
    # Локальные кандидаты читаются из БД уже ПОСЛЕ db.close() — пустая выдача
    # означала бы, что переоткрытие сессии не сработало.
    assert mix, "flow вернул пустую выдачу — локальные кандидаты не прочитались"
    assert any(t["artist"] == "GoodArtist" for t in mix)


def test_flow_response_metadata_matches_delivery_rows(client, db):
    user = create_user(db, username="flow-telemetry-user")
    liked_pl = Playlist(
        name="Понравившиеся",
        is_public=False,
        is_liked=True,
        owner_id=user.id,
    )
    db.add(liked_pl)
    db.commit()
    liked = Track(
        title="flow-seed",
        artist="Flow Artist",
        duration=100,
        source="local",
        file_path="minio://music/flow-seed.mp3",
    )
    candidate = Track(
        title="flow-candidate",
        artist="Flow Artist",
        duration=100,
        source="local",
        file_path="minio://music/flow-candidate.mp3",
    )
    db.add_all([liked, candidate])
    db.commit()
    db.execute(
        playlist_tracks.insert().values(
            playlist_id=liked_pl.id,
            track_id=liked.id,
            position=0,
        )
    )
    db.commit()

    response = client.get(
        "/api/recommendations/flow?limit=5",
        headers=auth_headers(client, username=user.username),
    )
    assert response.status_code == 200, response.text
    items = response.json()
    assert items
    request_ids = {item["recommendation_id"] for item in items}
    assert len(request_ids) == 1
    request_id = request_ids.pop()

    rows = db.execute(
        recommendation_impressions.select()
        .where(recommendation_impressions.c.request_id == request_id)
        .order_by(recommendation_impressions.c.position)
    ).mappings().all()
    assert len(rows) == len(items)
    for position, (item, row) in enumerate(zip(items, rows)):
        assert item["recommendation_surface"] == row["surface"] == "flow"
        assert item["recommendation_position"] == row["position"] == position
        assert item["recommendation_score"] == row["score"]
        assert item["recommendation_model_version"] == row["algorithm_version"]


def test_flow_excludes_played_tracks_but_keeps_new_tracks_by_same_artist(client, db):
    """Старая история не повторяется, но знакомый артист остаётся источником."""
    user = create_user(db, username="history-user")
    played = [
        Track(
            title=f"played-{i}",
            artist="KnownArtist",
            duration=100,
            source="local",
            file_path=f"minio://music/played-{i}.mp3",
        )
        for i in range(101)
    ]
    fresh = Track(
        title="fresh-from-known-artist",
        artist="KnownArtist",
        duration=100,
        source="local",
        file_path="minio://music/fresh.mp3",
    )
    db.add_all([*played, fresh])
    db.commit()

    now = datetime.now(timezone.utc)
    db.execute(
        user_track_plays.insert(),
        [
            {
                "user_id": user.id,
                "track_id": track.id,
                "play_count": 1,
                "last_played": now - timedelta(minutes=i),
            }
            for i, track in enumerate(played)
        ],
    )
    db.commit()
    fresh_id = fresh.id
    played_ids = {track.id for track in played}

    resp = client.get(
        "/api/recommendations/flow?limit=5",
        headers=auth_headers(client, username="history-user"),
    )
    assert resp.status_code == 200, resp.text

    ids = {t["id"] for t in resp.json() if isinstance(t["id"], int)}
    assert fresh_id in ids, "новый трек знакомого артиста должен попасть в flow"
    assert ids.isdisjoint(played_ids), (
        "flow вернул уже прослушанный трек вместо другой композиции артиста"
    )


def test_flow_includes_similar_artists(client, db, monkeypatch):
    """В волне должны появляться НОВЫЕ артисты, а не только выбранные юзером.

    Боевая регрессия: единственный источник похожести (радио YT Music) молчал,
    а вкусовой фильтр отбраковывал всё, что не курировано, — поэтому поток
    состоял ровно из тех 4 артистов, которых юзер выбрал при регистрации.
    Здесь радио пусто (как на проде), похожесть даёт граф артистов.
    """
    user = create_user(db)
    _liked(db, user)

    neighbours = [
        _external("UnknownNeighbour", "Ночная смена", "vid1"),
        _external("AnotherNeighbour", "Второй трек", "vid2"),
    ]

    async def _similar(artist):
        return neighbours

    monkeypatch.setattr("app.routers.flow._similar_pool", _similar)

    resp = client.get("/api/recommendations/flow?limit=5", headers=auth_headers(client))
    assert resp.status_code == 200, resp.text

    artists = {t["artist"] for t in resp.json()}
    assert artists & {"UnknownNeighbour", "AnotherNeighbour"}, (
        f"похожие артисты не дошли до выдачи: {artists}"
    )


def test_flow_includes_lastfm_similar_tracks(client, db, monkeypatch):
    """Похожие треки Last.fm доезжают до выдачи, когда YT-разведка молчит.

    Тот самый случай, ради которого источник и добавлен: у юзера нет ни одного
    ytmusic-трека, поэтому радио сеять нечем, а граф артистов (тоже YT) пуст.
    Похожесть по паре артист+название от videoId не зависит и работает —
    см. app/beets_similar.py и модульный docstring flow.py.
    """
    user = create_user(db)
    _liked(db, user)

    async def _lastfm(request, artist, title):
        # Курированный трек — "GoodArtist - liked-song" (см. _liked).
        assert (artist, title) == ("GoodArtist", "liked-song")
        return [_external("SimilarByName", "похожий трек", "lfm1")]

    monkeypatch.setattr("app.routers.flow._lastfm_pool", _lastfm)

    resp = client.get("/api/recommendations/flow?limit=5", headers=auth_headers(client))
    assert resp.status_code == 200, resp.text

    artists = {t["artist"] for t in resp.json()}
    assert "SimilarByName" in artists, (
        f"похожие по названию треки не дошли до выдачи: {artists}"
    )


def test_flow_trusts_lastfm_more_than_artist_graph(client, db, monkeypatch):
    """Track-similar provenance даёт больший score при равных кандидатах."""
    user = create_user(db)
    _liked(db, user)

    graph_calls = []

    async def _graph(artist):
        graph_calls.append(artist)
        return [_external("GraphNeighbour", "сосед по графу", "g1")]

    async def _lastfm(request, artist, title):
        return [
            _external(f"Similar{i}", f"похожий трек {i}", f"lfm{i}") for i in range(6)
        ]

    monkeypatch.setattr("app.routers.flow._similar_pool", _graph)
    monkeypatch.setattr("app.routers.flow._lastfm_pool", _lastfm)

    resp = client.get("/api/recommendations/flow?limit=5", headers=auth_headers(client))
    assert resp.status_code == 200, resp.text

    artists = {t["artist"] for t in resp.json()}
    assert artists, "выдача пуста"
    assert "GraphNeighbour" not in artists, f"граф артистов вытеснил похожие треки: {artists}"
    assert graph_calls, "граф может расширять общий пул без отдельной квоты"


def test_flow_prefers_new_tracks_from_loved_artists(client, db, monkeypatch):
    """Похожие артисты не вытесняют непрослушанные треки любимого автора."""
    user = create_user(db)
    _liked(db, user, artist="LovedArtist")

    async def _favorite(request, artist):
        return [
            _external("LovedArtist", f"новый любимый {i}", f"loved{i}")
            for i in range(8)
        ]

    async def _similar(artist):
        return [
            _external(f"RandomNeighbour{i}", f"чужой {i}", f"random{i}")
            for i in range(8)
        ]

    monkeypatch.setattr("app.routers.flow._favorite_artist_pool", _favorite)
    monkeypatch.setattr("app.routers.flow._similar_pool", _similar)

    resp = client.get(
        "/api/recommendations/flow?limit=10", headers=auth_headers(client)
    )
    assert resp.status_code == 200, resp.text
    artists = [t["artist"] for t in resp.json()]
    assert "LovedArtist" in artists, artists
    assert any(artist.startswith("RandomNeighbour") for artist in artists), artists


def test_flow_prioritizes_loved_artist_over_merely_played(client, db, monkeypatch):
    """Явный любимый артист идёт раньше сигнала от одного прослушивания."""
    user = create_user(db)
    _liked(db, user, artist="LovedArtist")
    played = Track(
        title="один раз прослушан",
        artist="MerelyPlayed",
        duration=100,
        source="local",
        file_path="minio://music/merely-played.mp3",
    )
    db.add(played)
    db.commit()
    db.execute(
        user_track_plays.insert().values(
            user_id=user.id,
            track_id=played.id,
            play_count=1,
            last_played=datetime.now(timezone.utc),
        )
    )
    db.commit()

    async def _favorite(request, artist):
        prefix = "loved" if artist == "LovedArtist" else "played"
        return [
            _external(artist, f"новый {artist} {i}", f"{prefix}{i}")
            for i in range(5)
        ]

    monkeypatch.setattr("app.routers.flow._favorite_artist_pool", _favorite)
    monkeypatch.setattr(
        "app.routers.flow.weighted_order", lambda keys, weights: list(keys)
    )

    resp = client.get("/api/recommendations/flow?limit=5", headers=auth_headers(client))
    assert resp.status_code == 200, resp.text
    artists = [track["artist"] for track in resp.json()]
    assert artists[0] == "LovedArtist", artists
    assert artists.count("LovedArtist") > artists.count("MerelyPlayed"), artists


def test_flow_rotates_loved_artists_between_batches(client, db, monkeypatch):
    """Следующая порция не повторяет треки и ротирует любимых артистов."""
    user = create_user(db)
    user.preferred_artists = [f"Loved{i}" for i in range(8)]
    db.commit()

    async def _favorite(request, artist):
        suffix = artist.removeprefix("Loved")
        return [
            _external(artist, f"трек {artist}-{i}", f"loved{suffix}_{i}")
            for i in range(3)
        ]

    monkeypatch.setattr("app.routers.flow._favorite_artist_pool", _favorite)
    monkeypatch.setattr(
        "app.routers.flow.weighted_order", lambda keys, weights: list(keys)
    )

    headers = auth_headers(client)
    first = client.get("/api/recommendations/flow?limit=6", headers=headers)
    second = client.get("/api/recommendations/flow?limit=6", headers=headers)
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text

    first_artists = {track["artist"] for track in first.json()}
    second_artists = {track["artist"] for track in second.json()}
    first_ids = {track["external_id"] for track in first.json()}
    second_ids = {track["external_id"] for track in second.json()}
    assert first_ids.isdisjoint(second_ids), (first_ids, second_ids)
    # Ротация дошла до имён, которых в первой порции не было.
    assert second_artists - first_artists, (first_artists, second_artists)
    assert len(first_artists) >= 2
    assert len(second_artists) >= 2


def test_flow_spreads_dominant_artist(client, db, monkeypatch):
    """Артист, у которого треков больше всех, не идёт в выдаче блоком.

    Боевой симптом: `kizaru, kizaru, kizaru` в конце порции и 8 треков Trapt из
    15. Причина — последний резерв (take_overflow) сортировал по занятости один
    раз и резал срезом, отдавая весь остаток одного артиста подряд.
    Пул специально беднее выдачи по числу артистов: полностью избежать повторов
    тут невозможно, но три подряд — уже дефект.
    """
    user = create_user(db)
    _liked(db, user)

    pool = [_external("Solo", f"track {i}", f"solo{i}") for i in range(10)]
    pool += [_external("Other", f"other {i}", f"other{i}") for i in range(3)]
    pool += [_external("Third", f"third {i}", f"third{i}") for i in range(3)]

    async def _similar(artist):
        return pool

    monkeypatch.setattr("app.routers.flow._similar_pool", _similar)

    resp = client.get("/api/recommendations/flow?limit=8", headers=auth_headers(client))
    assert resp.status_code == 200, resp.text

    order = [t["artist"] for t in resp.json()]
    assert order, "flow вернул пустую выдачу"
    longest = best = 1
    for i in range(1, len(order)):
        longest = longest + 1 if order[i] == order[i - 1] else 1
        best = max(best, longest)
    assert best < 3, f"артист идёт блоком: {order}"
    # A-B-A-B здесь НЕ проверяем: артистов в пуле меньше, чем требует разнос, а
    # единственный способ разложить три имени без «через один» — строгая ротация
    # A B C A B C, то есть ровно тот дефект, из-за которого выбор в
    # interleave_artists сделан контекстным и воспроизводимым. Непериодичность проверяется на
    # многих прогонах в test_diversity.py.
    # Миноритарные артисты не должны быть вытеснены доминирующим целиком.
    assert len(set(order)) >= 3, f"выдача выродилась в одного-двух артистов: {order}"


def test_flow_ignores_other_users_library(client, db):
    """Треки, приведённые в базу ДРУГИМ юзером, не попадают в чужую волну.

    Боевой симптом: завёлся второй юзер, импортировал плейлист на 185 треков —
    и они поехали в волну первому. Таблица tracks общая, владельца у трека нет,
    а Track.play_count — счётчик на всех юзеров сразу, поэтому страховочный
    добор (`order_by(desc(play_count))` по всей базе) возглавлял тот, кто
    последним много слушал, и его библиотека уезжала остальным.

    Приманка проходит вкусовой фильтр добора (require_signal): жанр по названию
    определяется, а жанров вкуса у Алисы нет, поэтому genre_is_compatible
    пропускает. Единственное, что её теперь останавливает, — скоуп артистов.

    Профиль Алисы намеренно БЕЗ жанрового сигнала: непустой profile["genres"]
    поднимает build_keyword_filters, а он строит Postgres-regex (`~*` с `\\y`),
    который SQLite в тестах не выполняет.
    """
    alice = create_user(db, username="alice")
    bob = create_user(db, username="bob")

    # Профиль Алисы: один курированный артист, названия нейтральные (жанр по
    # ним не угадывается).
    alice_pl = Playlist(name="Понравившиеся", is_public=False, is_liked=True, owner_id=alice.id)
    db.add(alice_pl)
    db.commit()
    db.refresh(alice_pl)
    own = Track(
        title="Мой любимый",
        artist="AliceArtist",
        duration=100,
        source="local",
        file_path="minio://music/own.mp3",
    )
    own_more = Track(
        title="Второй",
        artist="AliceArtist",
        duration=100,
        source="local",
        file_path="minio://music/own2.mp3",
    )
    db.add_all([own, own_more])
    db.commit()
    db.execute(
        playlist_tracks.insert().values(playlist_id=alice_pl.id, track_id=own.id, position=0)
    )
    db.commit()

    # Библиотека Боба: play_count намного выше, чем у Алисы, — именно она и
    # возглавляла глобальный добор.
    bob_pl = Playlist(name="Импорт", is_public=False, is_liked=False, owner_id=bob.id)
    db.add(bob_pl)
    db.commit()
    db.refresh(bob_pl)
    bob_tracks = [
        Track(
            title=f"Bob phonk {i}",
            artist=f"BobArtist{i}",
            duration=100,
            source="local",
            file_path=f"minio://music/bob{i}.mp3",
            play_count=500 + i,
        )
        for i in range(12)
    ]
    db.add_all(bob_tracks)
    db.commit()
    for pos, t in enumerate(bob_tracks):
        db.execute(
            playlist_tracks.insert().values(
                playlist_id=bob_pl.id, track_id=t.id, position=pos
            )
        )
    db.commit()

    resp = client.get("/api/recommendations/flow?limit=10", headers=auth_headers(client))
    assert resp.status_code == 200, resp.text

    mix = resp.json()
    artists = {t["artist"] for t in mix}
    leaked = {a for a in artists if a.startswith("BobArtist")}
    assert not leaked, f"в волну Алисы протекла библиотека Боба: {leaked}"
    # Иначе тест прошёл бы и на пустой выдаче, ничего не проверив.
    assert "AliceArtist" in artists, f"своя библиотека тоже пропала: {artists}"


def test_flow_response_is_not_cacheable(client, db):
    """Ответ волны уникален на каждый запрос — кэшировать его нельзя.

    Браузер, закэшировав выдачу, играл после перезагрузки ту же цепочку: запрос
    не доходил до бэкенда, серверная история flow:history не двигалась и ротация
    артистов не работала. Прокси это запрещает (см. nginx), но dev-путь через
    vite-прокси идёт мимо nginx — заголовок обязан ставить сам эндпоинт.
    """
    user = create_user(db)
    _liked(db, user)

    resp = client.get("/api/recommendations/flow?limit=5", headers=auth_headers(client))
    assert resp.status_code == 200, resp.text
    assert resp.headers.get("cache-control") == "no-store"


def _rich_familiar_profile(db, username="alice"):
    """Десять курированных артистов с непрослушанными треками — знакомого хватает
    на всю порцию, поэтому доля разведки определяется ТОЛЬКО настройкой."""
    user = create_user(db, username=username)
    _liked(db, user)
    liked_pl = db.query(Playlist).filter_by(owner_id=user.id, is_liked=True).first()

    pos = 10
    for a in range(10):
        seed = Track(
            title=f"свой сид {a}",
            artist=f"OwnArtist{a}",
            duration=100,
            source="local",
            file_path=f"minio://music/seed{a}.mp3",
        )
        db.add(seed)
        db.commit()
        db.execute(playlist_tracks.insert().values(
            playlist_id=liked_pl.id, track_id=seed.id, position=pos))
        pos += 1
        for i in range(2):
            db.add(Track(
                title=f"свой трек {a}-{i}",
                artist=f"OwnArtist{a}",
                duration=100,
                source="local",
                file_path=f"minio://music/own{a}_{i}.mp3",
            ))
            db.commit()
    db.commit()
    return user


def test_flow_does_not_force_exploration_when_trusted_pool_is_rich(
    client, db, monkeypatch
):
    """Новые артисты не вытесняют точные рекомендации при богатом пуле.

    Повторы теперь исключаются историей прослушиваний и выданных порций, поэтому
    для их устранения не нужна обязательная доля разведки. У каждого из десяти
    курированных артистов есть непрослушанные треки, которых достаточно на всю
    порцию. Проверяется ДЕФОЛТНАЯ доля разведки: юзер её не менял.
    """
    _rich_familiar_profile(db)

    # Разведка живая: граф артистов даёт треки НОВЫХ артистов. Берём
    # _similar_pool, а не радио: радио строится от videoId, а ytmusic-треков у
    # юзера нет — сида не будет и радио не вызовется вовсе.
    async def _similar(artist):
        return [
            _external(f"NeighbourArtist{i}", f"новый трек {i}", f"ext{i}")
            for i in range(6)
        ]

    monkeypatch.setattr("app.routers.flow._similar_pool", _similar)

    resp = client.get("/api/recommendations/flow?limit=15", headers=auth_headers(client))
    assert resp.status_code == 200, resp.text

    mix = resp.json()
    artists = [t["artist"] for t in mix]
    assert len(artists) == 15, artists
    assert all(a.startswith("OwnArtist") for a in artists), (
        f"разведка вытеснила точные рекомендации знакомых артистов: {artists}"
    )


def test_flow_high_discovery_ratio_keeps_graph_as_a_candidate_source(
    client, db, monkeypatch
):
    """Высокая цель продолжает расширять пул через граф артистов."""
    user = _rich_familiar_profile(db, "much-new-user")
    user.discovery_ratio = 0.6
    db.commit()

    graph_calls = []

    async def _similar(artist):
        graph_calls.append(artist)
        return [
            _external(f"NeighbourArtist{i}", f"новый трек {i}", f"ext{i}")
            for i in range(6)
        ]

    monkeypatch.setattr("app.routers.flow._similar_pool", _similar)

    resp = client.get(
        "/api/recommendations/flow?limit=15",
        headers=auth_headers(client, username="much-new-user"),
    )
    assert resp.status_code == 200, resp.text
    artists = [t["artist"] for t in resp.json()]
    assert len(artists) == 15, artists
    assert graph_calls, "graph source should be allowed to widen the candidate pool"
    assert sum(artist.startswith("NeighbourArtist") for artist in artists) == 6


def test_flow_max_discovery_ratio_prioritizes_new_artists_over_likes(
    client, db, monkeypatch
):
    """Максимальный приоритет не должен превращаться в выдачу из лайков."""
    user = _rich_familiar_profile(db, "max-discovery-user")
    user.discovery_ratio = 1.0
    db.commit()

    async def _similar(artist):
        return [
            _external(
                f"NeighbourArtist-{artist}-{index}",
                f"новый трек {artist}-{index}",
                f"max-new-{artist}-{index}",
            )
            for index in range(10)
        ]

    monkeypatch.setattr("app.routers.flow._similar_pool", _similar)

    def _score(item, **_kwargs):
        artist = getattr(item, "artist", "")
        return 100.0 if artist.startswith(("OwnArtist", "GoodArtist")) else 0.0

    monkeypatch.setattr("app.routers.flow.score_track", _score)

    response = client.get(
        "/api/recommendations/flow?limit=15",
        headers=auth_headers(client, username="max-discovery-user"),
    )
    assert response.status_code == 200, response.text
    tracks = response.json()
    familiar = {f"ownartist{i}" for i in range(10)} | {"goodartist"}
    novel = [track for track in tracks if track["artist"].lower() not in familiar]
    assert len(tracks) == 15
    assert len(novel) == 15, tracks
    assert len({track["artist"] for track in novel}) >= 8


def test_flow_max_discovery_ratio_falls_back_to_familiar_tracks(client, db):
    """Пустая разведка не должна укорачивать порцию на максимуме."""
    user = _rich_familiar_profile(db, "max-discovery-fallback-user")
    user.discovery_ratio = 1.0
    db.commit()

    response = client.get(
        "/api/recommendations/flow?limit=15",
        headers=auth_headers(client, username="max-discovery-fallback-user"),
    )
    assert response.status_code == 200, response.text
    tracks = response.json()
    assert len(tracks) == 15
    assert all(
        track["artist"].startswith(("OwnArtist", "GoodArtist"))
        for track in tracks
    )


def test_flow_high_discovery_ratio_prefers_fresh_local_tracks_before_likes(
    client, db, monkeypatch
):
    """Частичный внешний пул не добирает порцию лайками сверх их квоты."""
    user = create_user(db, username="partial-discovery-user")
    liked_playlist = Playlist(
        name="Понравившиеся",
        is_public=False,
        is_liked=True,
        owner_id=user.id,
    )
    db.add(liked_playlist)
    db.commit()
    db.refresh(liked_playlist)

    liked = [
        Track(
            title=f"liked-{index}",
            artist="KnownArtist",
            duration=100,
            source="local",
            file_path=f"minio://music/liked-{index}.mp3",
        )
        for index in range(12)
    ]
    fresh = [
        Track(
            title=f"fresh-{index}",
            artist="KnownArtist",
            duration=100,
            source="local",
            file_path=f"minio://music/fresh-{index}.mp3",
        )
        for index in range(8)
    ]
    db.add_all([*liked, *fresh])
    db.commit()
    db.execute(
        playlist_tracks.insert(),
        [
            {"playlist_id": liked_playlist.id, "track_id": track.id, "position": index}
            for index, track in enumerate(liked)
        ],
    )
    db.commit()
    user.discovery_ratio = 0.6
    db.commit()

    async def _similar(_artist):
        return [_external("NewArtist", "one new track", "partial-new")]

    monkeypatch.setattr("app.routers.flow._similar_pool", _similar)

    response = client.get(
        "/api/recommendations/flow?limit=15",
        headers=auth_headers(client, username="partial-discovery-user"),
    )
    assert response.status_code == 200, response.text
    tracks = response.json()
    # Неслышанных локальных треков всего восемь плюс один свежий внешний
    # кандидат. Порция обрывается на них и на квоте лайков — добивать её до
    # запрошенных пятнадцати повтором понравившегося поток не должен.
    expected_liked = min(liked_slots(15, 0.6), 15 - discovery_slots(15, 0.6))
    assert expected_liked, "на 0.6 квота лайков ещё не должна обнуляться"
    assert len(tracks) == 8 + 1 + expected_liked, tracks
    assert sum(track["title"].startswith("fresh-") for track in tracks) == 8
    assert sum(track["title"].startswith("liked-") for track in tracks) == expected_liked


def test_flow_zero_discovery_ratio_softly_demotes_lastfm_candidates(
    client, db, monkeypatch
):
    """Нулевой prior не резервирует места и опускает менее точную разведку."""
    user = _rich_familiar_profile(db, "no-new-flow-user")
    user.discovery_ratio = 0.0
    db.commit()

    async def _lastfm(request, artist, title):
        return [
            _external(f"Similar{i}", f"похожий трек {i}", f"lfm{i}") for i in range(6)
        ]

    monkeypatch.setattr("app.routers.flow._lastfm_pool", _lastfm)

    resp = client.get(
        "/api/recommendations/flow?limit=15",
        headers=auth_headers(client, username="no-new-flow-user"),
    )
    assert resp.status_code == 200, resp.text
    artists = [t["artist"] for t in resp.json()]
    assert len(artists) == 15, artists
    assert all(a.startswith("OwnArtist") for a in artists), (
        f"менее точная разведка вытеснила богатый знакомый пул: {artists}"
    )


def test_flow_does_not_open_artist_catalog_after_one_play(client, db, monkeypatch):
    """Одно случайное прослушивание не превращает артиста в любимого."""
    user = create_user(db, username="single-play-user")
    played = Track(
        title="случайный трек",
        artist="AccidentalArtist",
        duration=100,
        source="local",
        file_path="minio://music/accidental.mp3",
    )
    db.add(played)
    db.commit()
    db.execute(
        user_track_plays.insert().values(
            user_id=user.id,
            track_id=played.id,
            play_count=1,
            last_played=datetime.now(timezone.utc),
        )
    )
    db.commit()

    requested_artists = []

    async def _favorite(request, artist):
        requested_artists.append(artist)
        return [_external(artist, "ещё один трек", "accidental-new")]

    monkeypatch.setattr("app.routers.flow._favorite_artist_pool", _favorite)

    resp = client.get(
        "/api/recommendations/flow?limit=5",
        headers=auth_headers(client, username="single-play-user"),
    )
    assert resp.status_code == 200, resp.text
    assert requested_artists == [], requested_artists


def test_imported_playlist_artist_is_reachable_but_not_trusted(
    client, db, monkeypatch
):
    """Импорт открывает КАТАЛОГ артиста, но не доверие к нему.

    Порог _PLAYLIST_ARTIST_MIN_TRACKS раньше закрывал и то и другое разом, и
    артист с одним импортированным треком не доходил до потока ни одним
    генератором: в catalog_artists его нет, в trusted_artist_keys нет, его
    собственные треки исключены как «уже в коллекции», а в artist_weight он есть
    — поэтому и новым не считается. Каталог доступен с первого трека; вкусовой
    байпас (curated / trusted) — по-прежнему только начиная с порога.
    """
    user = create_user(db, username="imported-playlist-user")
    _imported_playlist(db, user, [("ImportedArtist", "imported song")])

    requested_artists = []

    async def _favorite(request, artist):
        requested_artists.append(artist)
        return [_external(artist, "трек из каталога", "imported-one-track")]

    monkeypatch.setattr("app.routers.flow._favorite_artist_pool", _favorite)

    resp = client.get(
        "/api/recommendations/flow?limit=5",
        headers=auth_headers(client, username="imported-playlist-user"),
    )
    assert resp.status_code == 200, resp.text
    assert "ImportedArtist" in requested_artists, requested_artists
    delivered = {track.get("external_id") for track in resp.json()}
    assert "imported-one-track" in delivered, delivered

    profile = _taste_profile(db, user.id)
    key = "importedartist"
    assert profile["artist_weight"].get(key), profile["artist_weight"]
    assert key not in profile["curated_artist_keys"], profile["curated_artist_keys"]
    assert key not in profile["trusted_artist_keys"], profile["trusted_artist_keys"]


def test_standard_flow_uses_imported_playlist_artists(client, db, monkeypatch):
    """Trusted imported playlist artists contribute to the main flow."""
    user = create_user(db, username="imported-standard-flow-user")
    _imported_playlist(
        db,
        user,
        [("ImportedArtist", f"imported song {i}") for i in range(3)],
    )

    requested_artists = []

    async def _favorite(request, artist):
        requested_artists.append(artist)
        return [_external(artist, "fresh catalog song", "imported-favorite")]

    monkeypatch.setattr("app.routers.flow._favorite_artist_pool", _favorite)

    resp = client.get(
        "/api/recommendations/flow?limit=15",
        headers=auth_headers(client, username="imported-standard-flow-user"),
    )
    assert resp.status_code == 200, resp.text
    assert "ImportedArtist" in requested_artists
    assert any(
        track.get("external_id") == "imported-favorite" for track in resp.json()
    )


def _imported_playlist(db, user, tracks, name="Imported"):
    """Импортированный плейлист: (артист, название) → треки в коллекции юзера."""
    playlist = Playlist(
        name=name,
        description="Импортировано из SoundCloud",
        is_public=False,
        owner_id=user.id,
    )
    db.add(playlist)
    db.commit()
    db.refresh(playlist)
    for position, (artist, title) in enumerate(tracks):
        track = Track(
            title=title,
            artist=artist,
            duration=100,
            source="local",
            file_path=f"minio://music/{artist}-{position}.mp3",
        )
        db.add(track)
        db.commit()
        db.execute(
            playlist_tracks.insert().values(
                playlist_id=playlist.id, track_id=track.id, position=position
            )
        )
    db.commit()
    return playlist


def test_flow_needs_three_playlist_tracks_to_call_an_artist_favorite(db):
    """Один трек из импорта любимым артиста не делает, три — делают.

    Импорт приводит сотни имён одним движением, и каждое становилось любимым с
    первого же трека: любимый проходит вкусовой фильтр в обход всех проверок и
    открывает внешний каталог этого имени. Порог — по числу треков артиста в
    собственных плейлистах (_PLAYLIST_ARTIST_MIN_TRACKS).
    """
    from app.routers.flow import _taste_profile

    user = create_user(db, username="import-threshold-user")
    _imported_playlist(
        db,
        user,
        [("RealFavorite", f"песня {i}") for i in range(3)]
        + [("PassingBy", "единственная песня"), ("AlsoPassing", "тоже одна")],
    )

    profile = _taste_profile(db, user.id)
    curated = set(profile["curated_artist_keys"])
    assert "realfavorite" in curated
    assert curated.isdisjoint({"passingby", "alsopassing"}), curated
    # Каталог провайдера открываем только для достаточно подтверждённых имён.
    assert [a.lower() for a in profile["playlist_artists"]] == ["realfavorite"]
    # Но их треки остаются СВОЕЙ библиотекой: артист не выпадает из скоупа,
    # иначе локальный пул перестал бы видеть остальной каталог этих имён.
    assert {"passingby", "alsopassing"} <= set(profile["artist_weight"])


def test_flow_keeps_import_only_library_out_of_global_top(client, db):
    """Библиотека из одиночных импортов не включает холодный старт.

    Ни один артист порога любимого не набирает, но вкус у юзера есть — чужой
    глобальный топ по play_count ему тем более противопоказан (см. регрессию в
    test_flow_ignores_other_users_library).
    """
    user = create_user(db, username="import-only-user")
    _imported_playlist(db, user, [("MineArtist", "своя песня")])
    # Второй трек того же артиста НЕ в плейлисте — иначе выдача пуста по
    # постороннему поводу (плейлистные треки исключаются как «уже в коллекции»)
    # и тест прошёл бы, ничего не проверив.
    mine_fresh = Track(
        title="ещё своя песня",
        artist="MineArtist",
        duration=100,
        source="local",
        file_path="minio://music/mine-fresh.mp3",
    )
    db.add(mine_fresh)
    db.commit()

    stranger = create_user(db, username="stranger")
    stranger_pl = Playlist(name="Импорт", is_public=False, owner_id=stranger.id)
    db.add(stranger_pl)
    db.commit()
    db.refresh(stranger_pl)
    loud = [
        Track(
            title=f"Чужой хит {i}",
            artist=f"StrangerArtist{i}",
            duration=100,
            source="local",
            file_path=f"minio://music/stranger{i}.mp3",
            play_count=900 + i,
        )
        for i in range(10)
    ]
    db.add_all(loud)
    db.commit()
    for position, track in enumerate(loud):
        db.execute(
            playlist_tracks.insert().values(
                playlist_id=stranger_pl.id, track_id=track.id, position=position
            )
        )
    db.commit()

    resp = client.get(
        "/api/recommendations/flow?limit=10",
        headers=auth_headers(client, username="import-only-user"),
    )
    assert resp.status_code == 200, resp.text
    artists = {t["artist"] for t in resp.json()}
    leaked = {a for a in artists if a.startswith("Stranger")}
    assert not leaked, f"в волну протекла чужая библиотека: {leaked}"
    assert "MineArtist" in artists, f"своя библиотека тоже пропала: {artists}"


def test_flow_searches_explicit_genres(client, db, monkeypatch):
    """Выбранный жанр создаёт внешний пул, а не остаётся слабым фильтром."""
    user = create_user(db, username="genre-user")
    user.preferred_genres = ["phonk"]
    db.commit()

    queries = []

    async def _genre_search(request, query):
        queries.append(query)
        return [
            _external(f"PhonkArtist{i}", f"phonk track {i}", f"phonk{i}")
            for i in range(6)
        ]

    monkeypatch.setattr("app.routers.flow._tag_pool", _genre_search)

    resp = client.get(
        "/api/recommendations/flow?limit=5",
        headers=auth_headers(client, username="genre-user"),
    )
    assert resp.status_code == 200, resp.text
    assert any("phonk" in query for query in queries), queries
    mix = resp.json()
    assert len(mix) == 5, mix
    assert all("phonk" in track["title"].lower() for track in mix), mix


def test_tag_search_requires_the_searched_words_not_just_the_language(
    client, db, monkeypatch
):
    """Теговый поиск — единственный пул без родословной, и язык ему не сигнал.

    make_relevance_check доходит до языкового прокси раньше ключевых слов (жанр
    у внешнего трека пуст), поэтому у юзера с кириллической библиотекой ЛЮБОЙ
    русскоязычный трек из сырого полнотекстового поиска проходил как «в духе
    вкуса», а найденное строго по теме, но латиницей — отбраковывалось. Именно
    так в поток попадали новые артисты, не имеющие к вкусу отношения.
    """
    user = create_user(db, username="tag-leak-user")
    _liked(db, user, artist="Кровосток", title="Дно")
    user.preferred_genres = ["phonk"]
    db.commit()

    captured = []

    async def _tag(request, query):
        captured.append(query)
        word = query.split()[0]
        return [
            _external("Тематический", f"{word} трек", "tag-on-topic"),
            _external("Посторонний", "случайная русская песня", "tag-off-topic"),
        ]

    monkeypatch.setattr("app.routers.flow._tag_pool", _tag)

    resp = client.get(
        "/api/recommendations/flow?limit=5",
        headers=auth_headers(client, username="tag-leak-user"),
    )
    assert resp.status_code == 200, resp.text
    assert captured, "теговая разведка не запускалась"
    delivered = {track.get("external_id") for track in resp.json()}
    assert "tag-on-topic" in delivered, delivered
    assert "tag-off-topic" not in delivered, delivered


def test_flow_sparse_pool_keeps_relevant_repeats(client, db, monkeypatch):
    """Мягкая диверсификация не делает бедный пул искусственно коротким."""
    user = create_user(db, username="discovery-cap-user")
    _liked(db, user)

    async def _similar(artist):
        return [_external("Solo", f"track {i}", f"solo-cap-{i}") for i in range(10)]

    monkeypatch.setattr("app.routers.flow._similar_pool", _similar)

    resp = client.get(
        "/api/recommendations/flow?limit=8",
        headers=auth_headers(client, username="discovery-cap-user"),
    )
    assert resp.status_code == 200, resp.text
    artists = [track["artist"] for track in resp.json()]
    assert len(artists) == 8, artists
    assert artists.count("Solo") > 4, artists


def test_excluded_detected_artist_stays_out_of_taste_profile(client, db):
    """Артист, убранный из автоопределения, не возвращается из истории."""
    user = create_user(db, username="excluded-detected-user")
    user.excluded_artists = ["DetectedArtist"]
    track = Track(
        title="detected track",
        artist="DetectedArtist",
        duration=100,
        source="local",
        file_path="minio://music/detected.mp3",
    )
    db.add(track)
    db.commit()
    db.execute(
        user_track_plays.insert().values(
            user_id=user.id,
            track_id=track.id,
            play_count=3,
            last_played=datetime.now(timezone.utc),
        )
    )
    db.commit()

    response = client.get(
        "/api/users/me/taste",
        headers=auth_headers(client, username="excluded-detected-user"),
    )
    assert response.status_code == 200, response.text
    assert "DetectedArtist" not in response.json()["artists"]


def test_preferences_persist_detected_artist_exclusion_and_explicit_override(client, db):
    user = create_user(db, username="excluded-preferences-user")
    headers = auth_headers(client, username="excluded-preferences-user")

    saved = client.put(
        "/api/users/me/preferences",
        headers=headers,
        json={
            "preferred_genres": [],
            "preferred_artists": [],
            "excluded_artists": ["AutoArtist", "AutoArtist"],
        },
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["excluded_artists"] == ["AutoArtist"]

    explicit = client.put(
        "/api/users/me/preferences",
        headers=headers,
        json={
            "preferred_genres": [],
            "preferred_artists": ["AutoArtist"],
            "excluded_artists": ["AutoArtist"],
        },
    )
    assert explicit.status_code == 200, explicit.text
    assert explicit.json()["preferred_artists"] == ["AutoArtist"]
    assert explicit.json()["excluded_artists"] == []


def _popular(artist, index, play_count):
    """Внешний трек с метрикой прослушиваний СВОЕЙ площадки."""
    track = _external(artist, f"трек {index}", f"cat{index}")
    track.play_count = play_count
    return track


def test_unproven_artist_contributes_only_his_popular_tracks(client, db, monkeypatch):
    """Артист, ещё не доказавший «любимость», представлен популярным.

    Популярность — метрика площадки, с которой трек подтянулся (play_count у
    ExternalTrackResponse), а не порядок выдачи провайдера: один лайк открывает
    каталог, но выбирать из него глубину рано.
    """
    user = create_user(db, username="unproven-artist-user")
    _liked(db, user, artist="OneLikeArtist")

    catalog = [_popular("OneLikeArtist", i, count) for i, count in enumerate(
        [3, 40, 900, 7, 700, 0, 800, 12, 500, 1, 600, 25]
    )]

    async def _favorite(request, artist):
        assert artist == "OneLikeArtist"
        return catalog

    monkeypatch.setattr("app.routers.flow._favorite_artist_pool", _favorite)
    # Порядок пула должен решать сам: общая модель иначе перебивает выбор
    # источника своими признаками (свежесть, акустика, контекст).
    monkeypatch.setattr("app.routers.flow.score_track", lambda item, **kwargs: 1.0)

    resp = client.get(
        "/api/recommendations/flow?limit=5",
        headers=auth_headers(client, username="unproven-artist-user"),
    )
    assert resp.status_code == 200, resp.text
    delivered = {track["external_id"] for track in resp.json()}
    top_five = {
        track.external_id
        for track in sorted(catalog, key=lambda t: -t.play_count)[:5]
    }
    assert delivered == top_five, delivered


def test_proven_artist_contributes_any_track_from_his_catalog(client, db, monkeypatch):
    """Доказавший «любимость» артист отдаёт любой трек, а не свой хит-парад.

    Три импортированных трека — вес выше порога _ARTIST_PROVEN_WEIGHT, поэтому
    выбор идёт по всей глубине каталога: иначе волна крутит одну и ту же
    верхушку, сколько бы артист ни был любим.
    """
    user = create_user(db, username="proven-artist-user")
    _imported_playlist(
        db, user, [("ProvenArtist", f"импорт {i}") for i in range(3)]
    )

    # Монотонная метрика: популярный хвост каталога отличить от головы легко.
    catalog = [_popular("ProvenArtist", i, 1000 - i * 10) for i in range(20)]

    async def _favorite(request, artist):
        return catalog

    monkeypatch.setattr("app.routers.flow._favorite_artist_pool", _favorite)
    monkeypatch.setattr("app.routers.flow.score_track", lambda item, **kwargs: 1.0)

    resp = client.get(
        "/api/recommendations/flow?limit=5",
        headers=auth_headers(client, username="proven-artist-user"),
    )
    assert resp.status_code == 200, resp.text
    delivered = [track["external_id"] for track in resp.json()]
    assert delivered, resp.text
    assert set(delivered) <= {track.external_id for track in catalog}, delivered
    top_five = [track.external_id for track in catalog[:5]]
    assert set(delivered) != set(top_five), delivered
    # Хотя бы один трек — из глубины каталога, а не из его популярной половины.
    assert any(
        int(external_id.removeprefix("cat")) >= 10 for external_id in delivered
    ), delivered


def test_similar_artist_pool_leads_with_popular_tracks():
    """От похожего артиста в очередь идёт его популярный трек.

    И соседи обходятся по кругу: иначе «следующим» всегда оказывался бы весь
    каталог первого похожего имени.
    """
    from app.routers.flow import _neighbour_popular_mix

    pools = [
        [
            _popular("NeighbourA", 0, 10),
            _popular("NeighbourA", 1, 900),
            _popular("NeighbourA", 2, 50),
        ],
        [
            _popular("NeighbourB", 3, 5),
            _popular("NeighbourB", 4, 700),
        ],
    ]

    result = _neighbour_popular_mix(pools, "seedartist")
    assert [track.external_id for track in result] == [
        "cat1",  # самый популярный у A
        "cat4",  # самый популярный у B
        "cat2",
        "cat3",
        "cat0",
    ], [track.external_id for track in result]


def test_similar_pool_drops_the_seed_artist_own_tracks():
    """Свои треки сид-артиста в «похожее» не попадают даже после сортировки."""
    from app.routers.flow import _neighbour_popular_mix

    pools = [[_popular("SeedArtist", 0, 900), _popular("Neighbour", 1, 10)]]

    result = _neighbour_popular_mix(pools, "seedartist")
    assert [track.external_id for track in result] == ["cat1"]


def test_service_popularity_falls_back_to_provider_order():
    """Провайдер прислал не всё: без метрики порядок остаётся его."""
    from app.routers.flow import _by_service_popularity

    pool = [
        _popular("Artist", 0, 0),
        _popular("Artist", 1, 0),
        _popular("Artist", 2, 5),
    ]
    assert [t.external_id for t in _by_service_popularity(pool)] == [
        "cat2",
        "cat0",
        "cat1",
    ]


def _bulk_imported_playlist(db, user, tracks, name="Imported"):
    """Импортированный плейлист с явными added_at: (артист, название, added_at)."""
    playlist = Playlist(
        name=name,
        description="Импортировано из SoundCloud",
        origin="imported",
        is_public=False,
        owner_id=user.id,
    )
    db.add(playlist)
    db.commit()
    db.refresh(playlist)
    rows = [
        Track(title=title, artist=artist, duration=100, source="local")
        for artist, title, _added_at in tracks
    ]
    db.add_all(rows)
    db.commit()
    db.execute(
        playlist_tracks.insert(),
        [
            {
                "playlist_id": playlist.id,
                "track_id": row.id,
                "position": position,
                "added_at": added_at,
            }
            for position, (row, (_artist, _title, added_at)) in enumerate(
                zip(rows, tracks)
            )
        ],
    )
    db.commit()
    return playlist


def test_imported_playlist_makes_an_artist_favorite_outside_the_taste_window(db):
    """Импорт определяет любимых артистов числом треков, а не попаданием в окно.

    Импорт приносит сотни треков разом, а вкусовые сигналы читаются окном
    _TASTE_QUERY_LIMIT по свежести. Счётчик треков артиста собирался из этого же
    окна — поэтому у большой импортированной коллекции порог
    _PLAYLIST_ARTIST_MIN_TRACKS не брал никто: в окно попадала произвольная её
    часть, и артист с пятью треками в плейлисте не встречался там ни разу.
    """
    from app.artist_utils import artist_key
    from app.routers.flow import _TASTE_QUERY_LIMIT

    user = create_user(db, username="imported-window-user")
    fresh = datetime.now(timezone.utc)
    old = fresh - timedelta(days=1)
    # Свежая часть импорта забивает окно целиком, каждый артист по одному треку.
    rows = [
        (f"FillerArtist{i}", f"филлер {i}", fresh) for i in range(_TASTE_QUERY_LIMIT)
    ]
    # Более старая часть в окно уже не попадает — но треков артиста в ней пять.
    rows += [("ImportedFav", f"импорт {i}", old) for i in range(5)]
    _bulk_imported_playlist(db, user, rows)

    profile = _taste_profile(db, user.id)
    key = artist_key("ImportedFav")
    assert key in profile["curated_artist_keys"], "импортированный артист не любимый"
    assert "ImportedFav" in profile["playlist_artists"], profile["playlist_artists"][:5]
    assert "ImportedFav" in profile["catalog_artists"], profile["catalog_artists"][:5]
    # Артисты с одним треком в импорте любимыми не становятся — порог тот же.
    assert artist_key("FillerArtist0") not in profile["curated_artist_keys"]


def _long_ago_liked(db, user, artist, titles):
    """Лайки давностью в три месяца: артист знакомый, но вес почти истлел.

    Именно такой артист самый частый в реальной библиотеке — лайкнут когда-то,
    его хиты давно в коллекции, а из потока он не должен исчезать.
    """
    playlist = Playlist(
        name="Понравившиеся", is_public=False, is_liked=True, owner_id=user.id
    )
    db.add(playlist)
    db.commit()
    db.refresh(playlist)
    added_at = datetime.now(timezone.utc) - timedelta(days=90)
    for position, title in enumerate(titles):
        track = Track(title=title, artist=artist, duration=100, source="local")
        db.add(track)
        db.commit()
        db.execute(
            playlist_tracks.insert().values(
                playlist_id=playlist.id,
                track_id=track.id,
                position=position,
                added_at=added_at,
            )
        )
    db.commit()
    return playlist


def test_favorite_artist_survives_a_collection_full_of_his_hits(client, db, monkeypatch):
    """Знакомый артист доходит до выдачи, когда его хиты уже в коллекции.

    Треки коллекции из волны исключаются, а «популярное» у знакомого артиста —
    ровно то, что пользователь когда-то лайкнул. Окно «что артист отдаёт
    ранкеру» поэтому нельзя обрезать ДО исключений: иначе от такого артиста не
    остаётся ничего, и лайкнутые имена пропадают из потока целиком.
    """
    user = create_user(db, username="hits-already-liked-user")
    hit_titles = [f"хит {i}" for i in range(10)]
    _long_ago_liked(db, user, "FavArtist", hit_titles)

    # Пул артиста: сверху его хиты (они же в коллекции), глубже — незнакомое.
    hits = [
        _popular("FavArtist", i, 1000 - i) for i in range(10)
    ]
    for track, title in zip(hits, hit_titles):
        track.title = title
    deep = [_popular("FavArtist", 100 + i, 10 - i) for i in range(10)]

    async def _favorite(request, artist):
        return hits + deep

    monkeypatch.setattr("app.routers.flow._favorite_artist_pool", _favorite)
    monkeypatch.setattr("app.routers.flow.score_track", lambda item, **kwargs: 1.0)

    resp = client.get(
        "/api/recommendations/flow?limit=5",
        headers=auth_headers(client, username="hits-already-liked-user"),
    )
    assert resp.status_code == 200, resp.text
    delivered = {track["external_id"] for track in resp.json()}
    assert delivered, "знакомый артист исчез из выдачи целиком"
    assert delivered <= {track.external_id for track in deep}, delivered


def _dislike_event(db, user, external_id, *, event_type="dislike", surface="flow",
                   artist="SeedArtist", title=None, minutes_ago=0):
    """Событие дизлайка/снятия из плеера — путь ДО материализации трека."""
    db.execute(
        recommendation_events.insert().values(
            user_id=user.id,
            source="ytmusic",
            external_id=external_id,
            artist=artist,
            title=title if title is not None else f"трек {external_id}",
            event_type=event_type,
            surface=surface,
            request_id=f"req-{external_id}-{event_type}",
            occurred_at=datetime.now(timezone.utc) - timedelta(minutes=minutes_ago),
        )
    )
    db.commit()


def test_dislike_is_not_squeezed_out_of_the_taste_window(db):
    """Дизлайк исключает трек и после сотен свежих скипов.

    Скипы пишутся автоматически (фронт шлёт их при <25% прослушивания) и
    набегают сотнями, а вкусовые сигналы читаются окном _TASTE_QUERY_LIMIT.
    Дизлайк сидел в том же окне — и через _TASTE_QUERY_LIMIT скипов трек,
    которому пользователь сказал «больше не показывать», возвращался в волну.
    """
    from app.routers.flow import _TASTE_QUERY_LIMIT

    user = create_user(db, username="dislike-window-user")
    hated = Track(
        title="ненавистный", artist="HatedArtist", duration=100, source="local"
    )
    db.add(hated)
    db.commit()
    db.refresh(hated)
    db.execute(
        user_track_skips.insert().values(
            user_id=user.id,
            track_id=hated.id,
            skip_count=1,
            disliked=True,
            last_skipped=datetime.now(timezone.utc) - timedelta(days=30),
        )
    )

    # Окно вкусовых сигналов забиваем доверху более свежими скипами.
    filler = [
        Track(title=f"скип {i}", artist=f"SkipArtist{i}", duration=100, source="local")
        for i in range(_TASTE_QUERY_LIMIT)
    ]
    db.add_all(filler)
    db.commit()
    db.execute(
        user_track_skips.insert(),
        [
            {
                "user_id": user.id,
                "track_id": track.id,
                "skip_count": 1,
                "disliked": False,
                "last_skipped": datetime.now(timezone.utc),
            }
            for track in filler
        ],
    )
    db.commit()

    profile = _taste_profile(db, user.id)
    assert hated.id in profile["recent_ids"], "дизлайкнутый трек обязан быть исключён"


def test_external_dislike_keeps_the_track_out_of_the_flow(client, db, monkeypatch):
    """Дизлайк внешнего трека действует и без материализации.

    Фронт отправляет событие ДО импорта трека в каталог, и импорт может не
    успеть или упасть — тогда строки в user_track_skips нет вовсе. Поверхность
    события не важна: «не показывать» относится к треку, а не к экрану.
    """
    user = create_user(db, username="external-dislike-user")
    _liked(db, user, artist="SeedArtist")
    catalog = [_popular("SeedArtist", 0, 900), _popular("SeedArtist", 1, 800)]
    _dislike_event(db, user, "cat0", surface="recommendations")

    async def _favorite(request, artist):
        return catalog

    monkeypatch.setattr("app.routers.flow._favorite_artist_pool", _favorite)
    monkeypatch.setattr("app.routers.flow.score_track", lambda item, **kwargs: 1.0)

    resp = client.get(
        "/api/recommendations/flow?limit=5",
        headers=auth_headers(client, username="external-dislike-user"),
    )
    assert resp.status_code == 200, resp.text
    delivered = {track["external_id"] for track in resp.json()}
    assert "cat0" not in delivered, delivered
    assert "cat1" in delivered, delivered


def test_undislike_lets_the_track_back_into_the_flow(client, db, monkeypatch):
    """Снятый дизлайк не банит трек навсегда.

    В user_track_skips снятие удаляет строку целиком, а журнал событий помнит
    оба нажатия — поэтому решает более позднее.
    """
    user = create_user(db, username="undislike-user")
    _liked(db, user, artist="SeedArtist")
    catalog = [_popular("SeedArtist", 0, 900)]
    _dislike_event(db, user, "cat0", minutes_ago=10)
    _dislike_event(db, user, "cat0", event_type="undislike", minutes_ago=1)

    async def _favorite(request, artist):
        return catalog

    monkeypatch.setattr("app.routers.flow._favorite_artist_pool", _favorite)
    monkeypatch.setattr("app.routers.flow.score_track", lambda item, **kwargs: 1.0)

    resp = client.get(
        "/api/recommendations/flow?limit=5",
        headers=auth_headers(client, username="undislike-user"),
    )
    assert resp.status_code == 200, resp.text
    delivered = {track["external_id"] for track in resp.json()}
    assert "cat0" in delivered, delivered

