"""Импорт из Yandex Music: разбор ссылок, публичный путь без токена, профили."""

import asyncio

import pytest

from app.routers import importer
from app.routers import yandex_music as ym
from tests.conftest import auth_headers, create_user


def _web_track(track_id: str, title: str, artist: str = "A", **extra) -> dict:
    obj = {
        "id": track_id,
        "title": title,
        "durationMs": 200_000,
        "artists": [{"name": artist}],
        "albums": [{"title": "Alb", "coverUri": "avatars.yandex.net/alb/%%"}],
    }
    obj.update(extra)
    return obj


# ─── Разбор ссылок ───


@pytest.mark.parametrize(
    "url,expected",
    [
        ("https://music.yandex.ru/album/5307899", ("album", {"album_id": "5307899"})),
        (
            "https://music.yandex.ru/album/5307899/track/41007503",
            ("track", {"track_id": "41007503", "album_id": "5307899"}),
        ),
        ("https://music.yandex.ru/track/41007503", ("track", {"track_id": "41007503"})),
        ("https://music.yandex.ru/artist/9262/tracks", ("artist", {"artist_id": "9262"})),
        ("https://music.yandex.com/artist/9262", ("artist", {"artist_id": "9262"})),
        (
            "https://music.yandex.ru/users/123456/likes/tracks",
            ("likes", {"owner": "123456"}),
        ),
        (
            "https://music.yandex.ru/users/123456/playlists/1003",
            ("playlist", {"owner": "123456", "kind": "1003"}),
        ),
        # Владелец плейлиста — логин, а не число: раньше такие ссылки не разбирались.
        (
            "https://music.yandex.ru/users/music-blog/playlists/2136",
            ("playlist", {"owner": "music-blog", "kind": "2136"}),
        ),
        # Новый сайт: плейлист (и «Мне нравится») по uuid.
        (
            "https://music.yandex.ru/playlists/ea7570c7-d248-83ef-cb5b-a5586bfd81d3",
            ("playlist", {"uuid": "ea7570c7-d248-83ef-cb5b-a5586bfd81d3"}),
        ),
        (
            "https://music.yandex.ru/playlists/lk.b133eab3-42b6-498b-8855-18aafa130456",
            ("playlist", {"uuid": "lk.b133eab3-42b6-498b-8855-18aafa130456"}),
        ),
        # Профиль: без номера плейлиста.
        ("https://music.yandex.ru/users/music-blog", ("profile", {"owner": "music-blog"})),
        (
            "https://music.yandex.ru/users/music-blog/playlists/",
            ("profile", {"owner": "music-blog"}),
        ),
    ],
)
def test_parse_url_extracts_kind_and_ids(url, expected):
    assert ym.parse_url(url) == expected


def test_parse_url_returns_none_for_other_hosts():
    assert ym.parse_url("https://open.spotify.com/playlist/pl1") is None
    assert ym.parse_url("") is None


def test_detect_uses_yandex_parser():
    assert importer._detect("https://music.yandex.ru/album/5307899") == ("yandex", "album")
    assert importer._detect("https://music.yandex.ru/users/music-blog/playlists/2136") == (
        "yandex", "playlist",
    )
    assert importer._detect("https://music.yandex.ru/users/123456/likes/tracks") == (
        "yandex", "likes",
    )
    assert importer._detect("https://music.yandex.ru/users/music-blog") == (
        "yandex", "profile",
    )
    # Неразобранная ссылка Yandex всё равно уходит в импорт (дальше yt-dlp).
    assert importer._detect("https://music.yandex.ru/something/else") == ("yandex", "playlist")


# ─── Разбор ответов API ───


def test_cover_url_substitutes_size_template():
    # Yandex отдаёт шаблон с `%%`; пакет yandex-music иногда `{size}`.
    assert ym._cover_url("avatars.yandex.net/x/%%") == "https://avatars.yandex.net/x/400x400"
    assert ym._cover_url("avatars.yandex.net/x/{size}") == "https://avatars.yandex.net/x/400x400"
    assert ym._cover_url("https://avatars.yandex.net/x/%%", "200x200").endswith("/200x200")
    assert ym._cover_url(None) is None


def test_track_from_web_maps_fields():
    track = ym._track_from_web(
        _web_track("123", "Song", version="remix", artists=[{"name": "A"}, {"name": "B"}])
    )
    assert track.id == "123"
    # Версия трека — часть названия, иначе ремиксы схлопнутся в оригинал.
    assert track.title == "Song (remix)"
    assert track.artist == "A, B"
    assert track.album == "Alb"
    assert track.duration == 200
    assert track.cover_url == "https://avatars.yandex.net/alb/400x400"


def test_track_from_web_skips_stubs():
    # Недоступные в регионе треки приходят без названия.
    assert ym._track_from_web({"id": "1"}) is None
    assert ym._track_from_web({"title": "no id"}) is None
    assert ym._track_from_web("not a dict") is None


def test_track_from_web_without_artists():
    assert ym._track_from_web({"id": "1", "title": "T"}).artist == "Unknown Artist"


def test_tracks_from_web_unwraps_entries():
    # Плейлисты отдают треки как есть, библиотека — обёрнутыми в {"track": ...}.
    tracks = ym._tracks_from_web([{"track": _web_track("1", "One")}, _web_track("2", "Two")])
    assert [t.id for t in tracks] == ["1", "2"]


def test_web_cover_handles_mosaic():
    assert ym._web_cover({"cover": {"type": "pic", "uri": "c/%%"}}) == "https://c/400x400"
    mosaic = {"cover": {"type": "mosaic", "itemsUri": ["a/%%", "b/%%"]}}
    assert ym._web_cover(mosaic) == "https://a/400x400"
    assert ym._web_cover({}) is None


# ─── Публичный путь (без токена) ───


def _no_token(monkeypatch):
    """Отключает путь по OAuth-токену."""
    monkeypatch.setattr(ym, "_get_client", lambda: None)


def _fake_api(routes):
    """Подмена ym._api: путь → ответ (callable получает params и data)."""
    calls = []

    async def fake(path, params=None, data=None):
        calls.append(path)
        if path not in routes:
            return None
        route = routes[path]
        return route(params, data) if callable(route) else route

    return fake, calls


def test_public_playlist_maps_response(monkeypatch):
    fake, _ = _fake_api({
        "users/music-blog/playlists/2136": {
            "title": "Свежее",
            "cover": {"type": "pic", "uri": "cov/%%"},
            "tracks": [{"id": 1, "track": _web_track("1", "One")}, {"id": 2, "track": {"id": "2"}}],
        },
    })
    monkeypatch.setattr(ym, "_api", fake)

    title, cover, tracks = asyncio.run(ym._public_playlist("music-blog", "2136"))
    assert title == "Свежее"
    assert cover == "https://cov/400x400"
    assert [t.id for t in tracks] == ["1"]


def test_public_playlist_resolves_short_entries(monkeypatch):
    """Большие плейлисты могут прийти без объектов треков — дотягиваем по id."""

    def tracks(params, data):
        assert data["track-ids"] == "1:10,2"
        return [_web_track("1", "One"), _web_track("2", "Two")]

    fake, calls = _fake_api({
        "playlist/lk.abc": {"title": "Мне нравится", "tracks": [{"id": 1, "albumId": 10}, {"id": 2}]},
        "tracks": tracks,
    })
    monkeypatch.setattr(ym, "_api", fake)

    title, _, result = asyncio.run(ym._public_playlist_uuid("lk.abc"))
    assert title == "Мне нравится"
    assert [t.id for t in result] == ["1", "2"]
    assert calls == ["playlist/lk.abc", "tracks"]


def test_public_album_flattens_volumes(monkeypatch):
    fake, _ = _fake_api({
        "albums/5307899/with-tracks": {
            "title": "The Album",
            "coverUri": "cov/%%",
            "volumes": [[_web_track("1", "One")], [_web_track("2", "Two")]],
        },
    })
    monkeypatch.setattr(ym, "_api", fake)

    title, cover, tracks = asyncio.run(ym._public_album("5307899"))
    assert (title, cover) == ("The Album", "https://cov/400x400")
    assert [t.id for t in tracks] == ["1", "2"]


def test_public_artist_pages_tracks(monkeypatch):
    def page(params, data):
        n = params["page"]
        return {
            "pager": {"total": ym._ARTIST_PAGE + 1},
            "tracks": [_web_track(str(n), f"T{n}")],
        }

    fake, calls = _fake_api({
        "artists/9/brief-info": {"artist": {"name": "Band", "cover": {"uri": "a/%%"}}},
        "artists/9/tracks": page,
    })
    monkeypatch.setattr(ym, "_api", fake)

    name, cover, tracks = asyncio.run(ym._public_artist("9"))
    assert (name, cover) == ("Band", "https://a/400x400")
    assert [t.id for t in tracks] == ["0", "1"]
    assert calls.count("artists/9/tracks") == 2


def test_public_likes_resolves_track_ids(monkeypatch):
    def tracks(params, data):
        assert data["track-ids"] == "1:10,2:20"
        return [_web_track("1", "One"), _web_track("2", "Two")]

    fake, calls = _fake_api({
        # Библиотека отдаёт только id и albumId.
        "users/someone/likes/tracks": {
            "library": {"tracks": [{"id": "1", "albumId": "10"}, {"id": "2", "albumId": "20"}]},
        },
        "tracks": tracks,
    })
    monkeypatch.setattr(ym, "_api", fake)

    title, _, result = asyncio.run(ym._public_likes("someone"))
    assert "someone" in title
    assert [t.id for t in result] == ["1", "2"]
    assert calls == ["users/someone/likes/tracks", "tracks"]


def test_public_paths_return_none_when_unavailable(monkeypatch):
    """Приватное/404/сеть — это не ошибка, а сигнал к фолбэку."""
    fake, _ = _fake_api({})
    monkeypatch.setattr(ym, "_api", fake)
    assert asyncio.run(ym._public_album("1")) is None
    assert asyncio.run(ym._public_playlist("o", "1")) is None
    assert asyncio.run(ym._public_playlist_uuid("u")) is None
    assert asyncio.run(ym._public_likes("o")) is None
    assert asyncio.run(ym._public_artist("1")) is None
    assert asyncio.run(ym.fetch_profile("o")) is None


# ─── Профиль ───


def _profile_api(monkeypatch, likes=True):
    playlist = lambda kind, title, count: {  # noqa: E731
        "kind": kind,
        "title": title,
        "trackCount": count,
        "owner": {"login": "someone", "name": "Кто-то"},
        "cover": {"uri": f"c{kind}/%%"},
    }
    routes = {
        "users/someone/playlists/list": [
            playlist(1003, "Дорога", 2),
            playlist(1004, "Пустой", 0),
        ],
        "users/someone/playlists/1003": {
            "title": "Дорога",
            "tracks": [{"id": 1, "track": _web_track("1", "One")}, {"id": 2, "track": _web_track("2", "Two")}],
        },
        "tracks": lambda params, data: [_web_track("1", "One"), _web_track("3", "Three")],
    }
    if likes:
        routes["users/someone/likes/tracks"] = {
            "library": {"tracks": [{"id": "1", "albumId": "10"}, {"id": "3", "albumId": "30"}]},
        }
    fake, calls = _fake_api(routes)
    monkeypatch.setattr(ym, "_api", fake)
    return calls


def test_fetch_profile_lists_likes_and_playlists(monkeypatch):
    _profile_api(monkeypatch)
    name, collections = asyncio.run(ym.fetch_profile("someone"))
    assert name == "Кто-то"
    # Пустые плейлисты пропускаем, «Мне нравится» — первым.
    assert [(c.key, c.track_count) for c in collections] == [("likes", 2), ("playlist:1003", 2)]
    assert collections[1].params == {"owner": "someone", "kind": "1003"}
    assert collections[1].cover_url == "https://c1003/400x400"


def test_fetch_profile_without_public_likes(monkeypatch):
    _profile_api(monkeypatch, likes=False)
    _, collections = asyncio.run(ym.fetch_profile("someone"))
    assert [c.key for c in collections] == ["playlist:1003"]


def _ytmusic_echo(monkeypatch):
    """ytmusic «находит» трек с тем же названием — id матча = название."""

    async def fake_search(_request, query, limit=3):
        title = query.split()[-1]
        return [importer.ExternalTrackImport(
            source="ytmusic",
            external_id=f"yt-{title}",
            title=title,
            artist="A",
            duration=200,
            stream_url=f"https://example.test/stream/{title}",
        )]

    monkeypatch.setattr(importer.ytdlp, "search_ytmusic", fake_search)


def test_preview_yandex_profile_lists_collections(client, db, monkeypatch):
    create_user(db)
    headers = auth_headers(client)
    _no_token(monkeypatch)
    _profile_api(monkeypatch)

    resp = client.post(
        "/api/import/preview",
        json={"url": "https://music.yandex.ru/users/someone"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["kind"] == "profile"
    assert body["title"] == "Кто-то"
    assert body["track_count"] == 4
    assert [c["key"] for c in body["collections"]] == ["likes", "playlist:1003"]


def test_import_yandex_profile_creates_playlist_per_collection(client, db, monkeypatch):
    create_user(db)
    headers = auth_headers(client)
    _no_token(monkeypatch)
    _profile_api(monkeypatch)
    _ytmusic_echo(monkeypatch)

    resp = client.post(
        "/api/import",
        json={"url": "https://music.yandex.ru/users/someone/playlists"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    names = [p["name"] for p in body["playlists"]]
    assert names == ["Мне нравится — Кто-то", "Дорога"]
    assert body["playlist"]["name"] == "Мне нравится — Кто-то"
    assert body["playlists"][0]["description"] == "Импортировано из Yandex Music (избранное)"
    assert body["imported"] == 4


def test_import_yandex_profile_respects_selection(client, db, monkeypatch):
    create_user(db)
    headers = auth_headers(client)
    _no_token(monkeypatch)
    _profile_api(monkeypatch)
    _ytmusic_echo(monkeypatch)

    resp = client.post(
        "/api/import",
        json={"url": "https://music.yandex.ru/users/someone", "collections": ["playlist:1003"]},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    assert [p["name"] for p in resp.json()["playlists"]] == ["Дорога"]

    resp = client.post(
        "/api/import",
        json={"url": "https://music.yandex.ru/users/someone", "collections": []},
        headers=headers,
    )
    assert resp.status_code == 400


def test_import_yandex_profile_unavailable(client, db, monkeypatch):
    create_user(db)
    headers = auth_headers(client)
    _no_token(monkeypatch)
    fake, _ = _fake_api({})
    monkeypatch.setattr(ym, "_api", fake)

    resp = client.post(
        "/api/import/preview",
        json={"url": "https://music.yandex.ru/users/ghost"},
        headers=headers,
    )
    assert resp.status_code == 502
    assert "приватности" in resp.json()["detail"]


def test_fetch_by_url_falls_back_to_public(monkeypatch):
    _no_token(monkeypatch)

    async def fake_public(kind, params):
        assert params == {"album_id": "123"}
        return kind, None, [ym.YandexMusicTrack(id="1", title="T", artist="A")]

    monkeypatch.setattr(ym, "_fetch_public", fake_public)

    result = asyncio.run(ym.fetch_by_url(None, "https://music.yandex.ru/album/123"))
    assert result[0] == "album"


def test_fetch_by_url_prefers_token_when_available(monkeypatch):
    async def with_token(request, kind, params):
        return "from token", None, [ym.YandexMusicTrack(id="1", title="T", artist="A")]

    async def public(kind, params):
        raise AssertionError("публичный путь не должен вызываться")

    monkeypatch.setattr(ym, "_fetch_with_token", with_token)
    monkeypatch.setattr(ym, "_fetch_public", public)

    result = asyncio.run(ym.fetch_by_url(None, "https://music.yandex.ru/album/123"))
    assert result[0] == "from token"


def test_fetch_by_url_returns_none_for_unparsed(monkeypatch):
    assert asyncio.run(ym.fetch_by_url(None, "https://example.com/x")) is None


def test_status_reports_keyless(client):
    resp = client.get("/api/yandex/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["configured"] is False
    assert body["keyless"] is True


# ─── Импорт ───


def test_extract_yandex_native_builds_entries(monkeypatch):
    async def fake_fetch(request, url):
        return (
            "Свежее",
            "https://cov/400x400",
            [ym.YandexMusicTrack(
                id="1", title="One", artist="A", album="Alb",
                duration=200, cover_url="https://cov/1",
            )],
        )

    monkeypatch.setattr(ym, "fetch_by_url", fake_fetch)

    title, cover, entries = asyncio.run(
        importer._extract_yandex_native(None, "https://music.yandex.ru/album/1", "album")
    )
    assert (title, cover) == ("Свежее", "https://cov/400x400")
    assert entries == [{
        "title": "One",
        "artists": ["A"],
        "album": "Alb",
        "duration": 200,
        "thumbnails": [{"url": "https://cov/1"}],
        "id": "1",
        # у Yandex-треков флага explicit нет — всегда False (см. _tracks_to_entries)
        "explicit": False,
    }]


def test_extract_yandex_native_returns_none_when_unavailable(monkeypatch):
    async def fake_fetch(request, url):
        return None

    monkeypatch.setattr(ym, "fetch_by_url", fake_fetch)
    assert asyncio.run(
        importer._extract_yandex_native(None, "https://music.yandex.ru/album/1", "album")
    ) is None


def test_import_yandex_without_token_matches_in_ytmusic(client, db, monkeypatch):
    """Без токена метаданные берутся из анонимного API, аудио — из ytmusic."""
    create_user(db)
    headers = auth_headers(client)
    _no_token(monkeypatch)

    async def fake_public(kind, params):
        assert kind == "playlist"
        return (
            "Свежее",
            "https://cov/400x400",
            [ym.YandexMusicTrack(id="1", title="One", artist="A", duration=200)],
        )

    async def fake_search(_request, query, limit=3):
        return [importer.ExternalTrackImport(
            source="ytmusic",
            external_id="yt1",
            title="One",
            artist="A",
            duration=200,
            stream_url="https://example.test/stream/yt1",
        )]

    monkeypatch.setattr(ym, "_fetch_public", fake_public)
    monkeypatch.setattr(importer.ytdlp, "search_ytmusic", fake_search)

    resp = client.post(
        "/api/import",
        json={"url": "https://music.yandex.ru/users/music-blog/playlists/2136"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["imported"] == 1
    assert body["matched"] == 1
    assert body["playlist"]["name"] == "Свежее"
    assert body["playlist"]["description"] == "Импортировано из Yandex Music"


def test_import_error_shows_real_yandex_reason(client, db, monkeypatch):
    """Отказ API доходит до юзера как есть, а не общим списком догадок."""
    create_user(db)
    headers = auth_headers(client)
    _no_token(monkeypatch)

    class _Resp:
        status_code = 451
        headers = {"content-type": "text/html"}

        def json(self):
            raise ValueError

    class _Client:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def get(self, *args, **kwargs):
            return _Resp()

    def ytdlp_fails(url, cookies_file=None):
        raise RuntimeError("yt-dlp: unsupported")

    monkeypatch.setattr(ym.httpx, "AsyncClient", _Client)
    monkeypatch.setattr(importer, "_extract_blocking", ytdlp_fails)

    resp = client.post(
        "/api/import/preview",
        json={"url": "https://music.yandex.ru/playlists/a1a55745-6175-e5b7-bee5-f622bfd70222"},
        headers=headers,
    )
    assert resp.status_code == 502
    detail = resp.json()["detail"]
    assert "YANDEX_MUSIC_PROXY" in detail
    assert "HTTP 451" in detail


def test_failure_hint_by_status():
    assert "приватности" in importer._yandex_failure_hint(["Yandex API p → HTTP 404 playlist-not-found"])
    assert "YANDEX_MUSIC_TOKEN" in importer._yandex_failure_hint(["Yandex API p → HTTP 403 "])
    assert "публичная" in importer._yandex_failure_hint([])


def test_fetch_entity_caches_between_preview_and_import(monkeypatch):
    """Превью и импорт тянут одну коллекцию — второй раз Yandex не спрашиваем."""
    _no_token(monkeypatch)
    calls = []

    async def fake_public(kind, params):
        calls.append(kind)
        return "T", None, [ym.YandexMusicTrack(id="1", title="One", artist="A")]

    monkeypatch.setattr(ym, "_fetch_public", fake_public)

    first = asyncio.run(ym.fetch_entity(None, "album", {"album_id": "7"}))
    second = asyncio.run(ym.fetch_entity(None, "album", {"album_id": "7"}))
    assert first == second
    assert calls == ["album"]


def test_fetch_entity_does_not_cache_failures(monkeypatch):
    _no_token(monkeypatch)
    calls = []

    async def fake_public(kind, params):
        calls.append(kind)
        return None

    monkeypatch.setattr(ym, "_fetch_public", fake_public)

    assert asyncio.run(ym.fetch_entity(None, "album", {"album_id": "8"})) is None
    assert asyncio.run(ym.fetch_entity(None, "album", {"album_id": "8"})) is None
    assert calls == ["album", "album"]


def test_fetch_profile_is_cached(monkeypatch):
    calls = _profile_api(monkeypatch)
    first = asyncio.run(ym.fetch_profile("someone"))
    n = len(calls)
    second = asyncio.run(ym.fetch_profile("someone"))
    assert first == second
    assert len(calls) == n


# ─── Прокси ───


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("http://u:p@h:1", "http://u:p@h:1"),
        ("socks5://h:1080", "socks5://h:1080"),
        ("h.example:8000", "http://h.example:8000"),
        # Формат пула proxy-pool/proxies.list.
        ("1.2.3.4:11455:user_a:secret|100GB", "http://user_a:secret@1.2.3.4:11455"),
        ("# comment", None),
        ("", None),
        ("garbage", None),
    ],
)
def test_parse_proxy(raw, expected):
    assert ym._parse_proxy(raw) == expected


def test_mask_proxy_hides_credentials():
    assert ym._mask_proxy("http://user:secret@1.2.3.4:8000") == "http://1.2.3.4:8000"
    assert ym._mask_proxy("1.2.3.4:8000:user:secret") == "1.2.3.4:8000"
    assert ym._mask_proxy(None) == "direct"


def _proxies(monkeypatch, value):
    monkeypatch.setattr(ym, "_PROXY_STATIC", value)
    monkeypatch.setattr(ym, "_PROXY_FILE", "")
    monkeypatch.setattr(ym, "_proxy_down", {})
    monkeypatch.setattr(ym, "_proxy_turn", __import__("itertools").count())


def test_proxy_order_rotates_and_demotes_failed(monkeypatch):
    _proxies(monkeypatch, "h1:1, h2:2")
    assert ym._proxy_order() == ["http://h1:1", "http://h2:2"]
    assert ym._proxy_order() == ["http://h2:2", "http://h1:1"]
    ym._mark_down("http://h2:2")
    assert ym._proxy_order() == ["http://h1:1", "http://h2:2"]
    assert ym._proxy_order() == ["http://h1:1", "http://h2:2"]


def test_proxy_order_without_proxies_is_direct(monkeypatch):
    _proxies(monkeypatch, "")
    assert ym._proxy_order() == [None]


def test_proxy_file_is_read(monkeypatch, tmp_path):
    path = tmp_path / "yandex.proxies"
    path.write_text("# выходы\nh1:1:u:p\n\nsocks5://h2:2\n", encoding="utf-8")
    _proxies(monkeypatch, "h3:3")
    monkeypatch.setattr(ym, "_PROXY_FILE", str(path))
    monkeypatch.setattr(ym, "_proxy_file_cache", (-1.0, []))
    assert ym.yandex_proxies() == ["http://u:p@h1:1", "socks5://h2:2", "http://h3:3"]


class _FakeResp:
    def __init__(self, status, payload):
        self.status_code = status
        self._payload = payload

    def json(self):
        if self._payload is None:
            raise ValueError
        return self._payload


def _fake_client(monkeypatch, by_proxy):
    """httpx.AsyncClient, отвечающий по прокси; фиксирует порядок попыток."""
    tried = []

    class _Client:
        def __init__(self, *args, proxy=None, **kwargs):
            self.proxy = proxy

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def get(self, *args, **kwargs):
            tried.append(self.proxy)
            answer = by_proxy[self.proxy]
            if isinstance(answer, Exception):
                raise answer
            return answer

    monkeypatch.setattr(ym.httpx, "AsyncClient", _Client)
    return tried


def test_api_fails_over_to_next_proxy_on_451(monkeypatch):
    _proxies(monkeypatch, "h1:1,h2:2")
    tried = _fake_client(monkeypatch, {
        "http://h1:1": _FakeResp(451, {"error": {"name": "Unavailable For Legal Reasons"}}),
        "http://h2:2": _FakeResp(200, {"result": {"ok": True}}),
    })
    errors = ym.track_errors()

    assert asyncio.run(ym._api("playlist/x")) == {"ok": True}
    assert tried == ["http://h1:1", "http://h2:2"]
    assert "http://h1:1" in ym._proxy_down
    # В сообщении для юзера — адрес прокси без пароля.
    assert "через http://h1:1" in errors[0]


def test_api_fails_over_on_network_error_without_leaking_password(monkeypatch):
    _proxies(monkeypatch, "http://u:secret@h1:1,h2:2")
    _fake_client(monkeypatch, {
        "http://u:secret@h1:1": ym.httpx.ProxyError("boom http://u:secret@h1:1"),
        "http://h2:2": _FakeResp(200, {"result": 1}),
    })
    errors = ym.track_errors()

    assert asyncio.run(ym._api("x")) == 1
    assert "secret" not in errors[0]


def test_api_does_not_retry_content_errors(monkeypatch):
    """404/403 — про саму коллекцию: другой прокси ответ не изменит."""
    _proxies(monkeypatch, "h1:1,h2:2")
    tried = _fake_client(monkeypatch, {
        "http://h1:1": _FakeResp(404, {"error": {"name": "playlist-not-found"}}),
        "http://h2:2": _FakeResp(200, {"result": 1}),
    })
    assert asyncio.run(ym._api("x")) is None
    assert tried == ["http://h1:1"]
    assert ym._proxy_down == {}


def test_failure_hint_when_proxies_refused():
    hint = importer._yandex_failure_hint(["Yandex API x через http://h:1 → HTTP 451 "])
    assert "YANDEX_MUSIC_PROXY" in hint and "не пускает прокси" in hint


# ─── Кэш подбора и прогресс ───


def test_match_is_cached_by_source_track_id(monkeypatch):
    calls = []

    async def fake_search(_request, query, limit=3):
        calls.append(query)
        return [importer.ExternalTrackImport(
            source="ytmusic", external_id="yt1", title="One", artist="A",
            duration=200, stream_url="https://example.test/stream/yt1",
        )]

    monkeypatch.setattr(importer.ytdlp, "search_ytmusic", fake_search)
    entry = {"id": "42", "title": "One", "artists": ["A"], "duration": 200}

    first = asyncio.run(importer._entry_to_import(None, "yandex", entry))
    second = asyncio.run(importer._entry_to_import(None, "yandex", dict(entry)))
    assert first[0].external_id == second[0].external_id == "yt1"
    assert second[1] is True
    assert len(calls) == 1
    # Тот же id из другого источника — другой трек, кэш не общий.
    asyncio.run(importer._entry_to_import(None, "spotify", dict(entry)))
    assert len(calls) == 2


def test_match_miss_is_cached_but_search_failure_is_not(monkeypatch):
    calls = []

    async def not_found(_request, query, limit=3):
        calls.append(query)
        return []

    monkeypatch.setattr(importer.ytdlp, "search_ytmusic", not_found)
    entry = {"id": "7", "title": "Nothing", "artists": ["Nobody"]}
    assert asyncio.run(importer._entry_to_import(None, "yandex", entry)) == (None, True)
    n = len(calls)
    assert asyncio.run(importer._entry_to_import(None, "yandex", dict(entry))) == (None, True)
    assert len(calls) == n

    async def broken(_request, query, limit=3):
        calls.append(query)
        raise RuntimeError("ytmusic down")

    monkeypatch.setattr(importer.ytdlp, "search_ytmusic", broken)
    entry = {"id": "8", "title": "Other", "artists": ["X"]}
    assert asyncio.run(importer._entry_to_import(None, "yandex", entry)) == (None, False)
    assert asyncio.run(importer._entry_to_import(None, "yandex", dict(entry))) == (None, False)
    assert len(calls) == n + 2


def test_import_reports_progress(client, db, monkeypatch):
    create_user(db)
    headers = auth_headers(client)
    _no_token(monkeypatch)
    _profile_api(monkeypatch)
    _ytmusic_echo(monkeypatch)

    resp = client.post(
        "/api/import",
        json={"url": "https://music.yandex.ru/users/someone", "import_id": "imp-12345678"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text

    progress = client.get("/api/import/progress/imp-12345678", headers=headers)
    assert progress.status_code == 200
    state = progress.json()
    assert state["stage"] == "done"
    assert state["done"] == state["total"] == 4
    assert state["collections_done"] == state["collections_total"] == 2


def test_import_progress_records_error(client, db, monkeypatch):
    create_user(db)
    headers = auth_headers(client)
    _no_token(monkeypatch)
    fake, _ = _fake_api({})
    monkeypatch.setattr(ym, "_api", fake)

    resp = client.post(
        "/api/import",
        json={"url": "https://music.yandex.ru/users/ghost", "import_id": "imp-err-0001"},
        headers=headers,
    )
    assert resp.status_code == 502
    state = client.get("/api/import/progress/imp-err-0001", headers=headers).json()
    assert state["stage"] == "error"
    assert "приватности" in state["error"]


def test_import_progress_is_per_user(client, db):
    create_user(db)
    create_user(db, "bob")
    from app.cache import set_cache

    set_cache("import:progress:1:imp-12345678", {"stage": "matching"}, expire=60)
    mine = client.get("/api/import/progress/imp-12345678", headers=auth_headers(client))
    assert mine.status_code == 200
    other = client.get("/api/import/progress/imp-12345678", headers=auth_headers(client, "bob"))
    assert other.status_code == 404
    bad = client.get("/api/import/progress/x", headers=auth_headers(client))
    assert bad.status_code == 422
