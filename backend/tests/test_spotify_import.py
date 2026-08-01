"""Импорт из Spotify: разбор ссылок, пагинация метаданных, поведение без ключей."""

import asyncio

import pytest
from fastapi import HTTPException

from app.routers import importer, spotify
from tests.conftest import auth_headers, create_user


def _track_obj(track_id: str, name: str, artist: str = "Artist", **extra) -> dict:
    obj = {
        "id": track_id,
        "name": name,
        "type": "track",
        "artists": [{"name": artist}],
        "duration_ms": 200_000,
        "album": {"name": "Album", "images": [{"url": f"https://i.scdn.co/{track_id}", "width": 640}]},
    }
    obj.update(extra)
    return obj


# ─── Разбор ссылок ───


@pytest.mark.parametrize(
    "url,expected",
    [
        ("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M", ("playlist", "37i9dQZF1DXcBWIGoYBM5M")),
        ("https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3?si=abc", ("album", "1DFixLWuPkv3KT3TnV35m3")),
        ("https://open.spotify.com/intl-ru/track/4cOdK2wGLETKBW3PvgPWqT", ("track", "4cOdK2wGLETKBW3PvgPWqT")),
        ("http://open.spotify.com/artist/0OdUWJ0sBjDrqHygGUXeCF", ("artist", "0OdUWJ0sBjDrqHygGUXeCF")),
        ("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M", ("playlist", "37i9dQZF1DXcBWIGoYBM5M")),
        ("spotify:track:4cOdK2wGLETKBW3PvgPWqT", ("track", "4cOdK2wGLETKBW3PvgPWqT")),
    ],
)
def test_parse_url_extracts_kind_and_id(url, expected):
    assert spotify.parse_url(url) == expected


@pytest.mark.parametrize(
    "url",
    [
        "",
        "https://soundcloud.com/user/track",
        "https://music.yandex.ru/album/123",
        "https://open.spotify.com/user/someone",  # профили не поддерживаем
    ],
)
def test_parse_url_returns_none_for_non_spotify(url):
    assert spotify.parse_url(url) is None


def test_detect_recognizes_spotify_web_and_uri():
    assert importer._detect("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M") == (
        "spotify",
        "playlist",
    )
    # URI не имеет netloc — разбор по хосту его бы не увидел.
    assert importer._detect("spotify:album:1DFixLWuPkv3KT3TnV35m3") == ("spotify", "album")


def test_detect_still_rejects_unknown_hosts():
    with pytest.raises(HTTPException) as exc:
        importer._detect("https://example.com/playlist/1")
    assert exc.value.status_code == 400
    assert "Spotify" in exc.value.detail


def test_short_link_detection():
    assert spotify.is_short_link("https://spotify.link/abc123")
    assert spotify.is_short_link("https://spotify.app.link/abc123")
    assert not spotify.is_short_link("https://open.spotify.com/track/abc")


def test_normalize_url_resolves_short_link(monkeypatch):
    async def fake_resolve(url):
        assert url == "https://spotify.link/abc123"
        return "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT"

    monkeypatch.setattr(spotify, "resolve_short_link", fake_resolve)
    resolved = asyncio.run(importer._normalize_url(" https://spotify.link/abc123 "))
    assert importer._detect(resolved) == ("spotify", "track")


def test_normalize_url_leaves_other_links_untouched():
    url = "https://soundcloud.com/user/sets/playlist"
    assert asyncio.run(importer._normalize_url(f"  {url}  ")) == url


# ─── Нормализация треков ───


def test_track_from_object_maps_fields():
    track = spotify._track_from_object(
        _track_obj("t1", "Song", "A", artists=[{"name": "A"}, {"name": "B"}], external_ids={"isrc": "US1234567890"})
    )
    assert track.id == "t1"
    assert track.title == "Song"
    assert track.artist == "A, B"
    assert track.album == "Album"
    assert track.duration == 200  # duration_ms → секунды
    assert track.cover_url == "https://i.scdn.co/t1"
    assert track.isrc == "US1234567890"


@pytest.mark.parametrize(
    "obj",
    [
        None,
        {},
        {"type": "episode", "id": "e1", "name": "Podcast"},          # подкаст — не музыка
        {"type": "track", "id": None, "name": "Local file"},          # is_local без id
        {"type": "track", "id": "t1", "name": None},
    ],
)
def test_track_from_object_skips_unplayable(obj):
    assert spotify._track_from_object(obj) is None


def test_track_without_artists_falls_back_to_unknown():
    track = spotify._track_from_object({"type": "track", "id": "t1", "name": "Song", "artists": []})
    assert track.artist == "Unknown Artist"


def test_biggest_image_picks_widest():
    images = [
        {"url": "small", "width": 64},
        {"url": "big", "width": 640},
        {"url": "mid", "width": 300},
    ]
    assert spotify._biggest_image(images) == "big"
    # width=null (мозаичные обложки плейлистов) — берём первую с url.
    assert spotify._biggest_image([{"url": "only", "width": None}]) == "only"
    assert spotify._biggest_image([]) is None
    assert spotify._biggest_image(None) is None


# ─── Пагинация ───


def test_playlist_tracks_follows_next_and_skips_bad_items(monkeypatch):
    calls = []

    async def fake_api_get(path, params=None):
        calls.append(path)
        if path == "/playlists/pl1":
            return {"name": "My Mix", "images": [{"url": "cover", "width": 640}]}
        if path == "/playlists/pl1/tracks":
            return {
                "items": [
                    {"track": _track_obj("t1", "One")},
                    {"track": None},  # удалённый/локальный трек
                ],
                "next": "https://api.spotify.com/v1/playlists/pl1/tracks?offset=2",
            }
        return {"items": [{"track": _track_obj("t2", "Two")}], "next": None}

    monkeypatch.setattr(spotify, "_api_get", fake_api_get)

    title, cover, tracks = asyncio.run(spotify.get_playlist_tracks("pl1"))

    assert (title, cover) == ("My Mix", "cover")
    assert [t.id for t in tracks] == ["t1", "t2"]
    assert calls[-1] == "https://api.spotify.com/v1/playlists/pl1/tracks?offset=2"


def test_album_tracks_use_album_cover_and_first_page_inline(monkeypatch):
    calls = []

    async def fake_api_get(path, params=None):
        calls.append(path)
        if path == "/albums/al1":
            return {
                "name": "The Album",
                "images": [{"url": "album-cover", "width": 640}],
                "tracks": {
                    # У треков внутри альбома нет ни album, ни images.
                    "items": [{"type": "track", "id": "t1", "name": "One", "artists": [{"name": "A"}],
                               "duration_ms": 60_000}],
                    "next": None,
                },
            }
        raise AssertionError(f"unexpected request: {path}")

    monkeypatch.setattr(spotify, "_api_get", fake_api_get)

    title, cover, tracks = asyncio.run(spotify.get_album_tracks("al1"))

    assert (title, cover) == ("The Album", "album-cover")
    assert len(tracks) == 1
    assert tracks[0].album == "The Album"
    assert tracks[0].cover_url == "album-cover"
    # Первая страница треков пришла внутри альбома — второго запроса нет.
    assert calls == ["/albums/al1"]


def test_artist_tracks_return_top_tracks(monkeypatch):
    async def fake_api_get(path, params=None):
        if path == "/artists/ar1":
            return {"name": "Artist", "images": [{"url": "photo", "width": 640}]}
        if path == "/artists/ar1/top-tracks":
            assert params and params.get("market")  # market обязателен для top-tracks
            return {"tracks": [_track_obj("t1", "Hit")]}
        raise AssertionError(f"unexpected request: {path}")

    monkeypatch.setattr(spotify, "_api_get", fake_api_get)

    name, cover, tracks = asyncio.run(spotify.get_artist_tracks("ar1"))
    assert (name, cover) == ("Artist", "photo")
    assert [t.title for t in tracks] == ["Hit"]


def test_fetch_by_url_dispatches_by_kind(monkeypatch):
    async def playlist(entity_id):
        return f"playlist:{entity_id}", None, []

    monkeypatch.setattr(spotify, "get_playlist_tracks", playlist)
    title, _, _ = asyncio.run(
        spotify.fetch_by_url("https://open.spotify.com/playlist/pl1?si=x")
    )
    assert title == "playlist:pl1"


def test_fetch_by_url_rejects_non_spotify():
    with pytest.raises(HTTPException) as exc:
        asyncio.run(spotify.fetch_by_url("https://example.com/x"))
    assert exc.value.status_code == 400


# ─── Без ключей ───


def test_search_returns_empty_when_unconfigured(monkeypatch):
    monkeypatch.setattr(spotify, "SPOTIFY_CLIENT_ID", "")
    monkeypatch.setattr(spotify, "SPOTIFY_CLIENT_SECRET", "")
    assert asyncio.run(spotify.search_spotify("anything")) == []


def test_api_get_without_credentials_raises_503(monkeypatch):
    monkeypatch.setattr(spotify, "SPOTIFY_CLIENT_ID", "")
    monkeypatch.setattr(spotify, "SPOTIFY_CLIENT_SECRET", "")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(spotify._api_get("/playlists/pl1"))
    assert exc.value.status_code == 503
    assert "SPOTIFY_CLIENT_ID" in exc.value.detail


def test_status_endpoint_reports_unconfigured(client):
    resp = client.get("/api/spotify/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["configured"] is False
    assert body["connected"] is False


# ─── Эндпоинты импорта ───


def test_import_preview_uses_spotify_metadata(client, db, monkeypatch):
    create_user(db)
    headers = auth_headers(client)

    async def fake_fetch(url):
        assert "pl1" in url
        return (
            "My Mix",
            "https://i.scdn.co/cover",
            [
                spotify.SpotifyTrack(
                    id="t1", title="One", artist="A", album="Album",
                    duration=200, cover_url="https://i.scdn.co/t1",
                )
            ],
        )

    monkeypatch.setattr(spotify, "fetch_by_url", fake_fetch)

    resp = client.post(
        "/api/import/preview",
        json={"url": "https://open.spotify.com/playlist/pl1"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["source"] == "spotify"
    assert body["kind"] == "playlist"
    assert body["title"] == "My Mix"
    assert body["track_count"] == 1
    assert body["tracks"][0] == {
        "title": "One",
        "artist": "A",
        "duration": 200,
        "cover_url": "https://i.scdn.co/t1",
        "source": "spotify",
    }


def test_import_preview_spotify_without_credentials_returns_503(client, db, monkeypatch):
    create_user(db)
    headers = auth_headers(client)
    monkeypatch.setattr(spotify, "SPOTIFY_CLIENT_ID", "")
    monkeypatch.setattr(spotify, "SPOTIFY_CLIENT_SECRET", "")

    resp = client.post(
        "/api/import/preview",
        json={"url": "https://open.spotify.com/playlist/pl1"},
        headers=headers,
    )
    assert resp.status_code == 503
    assert "SPOTIFY_CLIENT_ID" in resp.json()["detail"]


def test_import_spotify_matches_tracks_in_ytmusic(client, db, monkeypatch):
    """Spotify не даёт аудио — треки должны уходить в матчинг YouTube Music."""
    create_user(db)
    headers = auth_headers(client)

    async def fake_fetch(url):
        return (
            "My Mix",
            "https://i.scdn.co/cover",
            [
                spotify.SpotifyTrack(id="t1", title="One (Remix)", artist="A, B", duration=200),
                spotify.SpotifyTrack(id="t2", title="Two", artist="C", duration=100),
            ],
        )

    queries = []

    async def fake_search(_request, query, limit=3):
        queries.append(query)
        if "Two" in query:
            return []  # ничего не нашли — трек пропускается
        return [
            importer.ExternalTrackImport(
                source="ytmusic",
                external_id="yt1",
                title="One",
                artist="A",
                duration=200,
                stream_url="https://example.test/stream/yt1",
            )
        ]

    monkeypatch.setattr(spotify, "fetch_by_url", fake_fetch)
    monkeypatch.setattr(importer.ytdlp, "search_ytmusic", fake_search)

    resp = client.post(
        "/api/import",
        json={"url": "https://open.spotify.com/playlist/pl1"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["imported"] == 1
    assert body["matched"] == 1
    assert body["skipped"] == 1
    assert body["playlist"]["name"] == "My Mix"
    assert body["playlist"]["description"] == "Импортировано из Spotify"
    # Матчим по основному артисту и очищенному от «(Remix)» названию.
    assert queries[0] == "A One"
