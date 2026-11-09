"""Мобильные ссылки SoundCloud и импорт приватного плейлиста по секретной ссылке."""

import asyncio

import httpx
import pytest
from fastapi import HTTPException, Request

from app.models import Playlist, Track, playlist_tracks
from app.routers import importer, soundcloud
from tests.conftest import auth_headers, create_user


SHORT_URL = "https://on.soundcloud.com/mobileShare"
PRIVATE_URL = "https://soundcloud.com/listener/sets/mix/s-privateToken?ref=clipboard&p=i"


@pytest.fixture
def short_http(monkeypatch):
    routes = {}
    calls = []

    def handle(request):
        url = str(request.url)
        calls.append(url)
        result = routes[url]
        if isinstance(result, Exception):
            raise result
        return result

    client = httpx.AsyncClient(transport=httpx.MockTransport(handle), follow_redirects=True)
    monkeypatch.setattr(soundcloud, "_api_v2_client", lambda: client)
    yield routes, calls
    asyncio.run(client.aclose())


@pytest.mark.parametrize(
    "short_url,target,kind",
    [
        (SHORT_URL, PRIVATE_URL, "playlist"),
        (SHORT_URL, "https://soundcloud.com/listener/sets/mix?si=share", "playlist"),
        (SHORT_URL, "https://soundcloud.com/artist/song", "track"),
        (SHORT_URL, "https://soundcloud.com/artist", "user"),
        ("https://soundcloud.app.goo.gl/legacyShare", PRIVATE_URL, "playlist"),
    ],
)
def test_normalize_mobile_link_before_detecting_kind(short_http, short_url, target, kind):
    routes, calls = short_http
    routes[short_url] = httpx.Response(302, headers={"Location": target})

    result = asyncio.run(importer._normalize_url(f"  {short_url}  "))

    assert result == target  # /s-... и query остаются на месте.
    assert importer._detect(result) == ("soundcloud", kind)
    assert calls == [short_url]  # Конечная HTML-страница не нужна.


def test_short_link_follows_relative_and_legacy_redirects(short_http):
    routes, calls = short_http
    legacy = "https://soundcloud.app.goo.gl/legacyShare"
    routes[legacy] = httpx.Response(302, headers={"Location": SHORT_URL})
    routes[SHORT_URL] = httpx.Response(307, headers={"Location": "/next"})
    routes["https://on.soundcloud.com/next"] = httpx.Response(
        302, headers={"Location": PRIVATE_URL}
    )

    assert asyncio.run(importer._normalize_url(legacy)) == PRIVATE_URL
    assert calls == [legacy, SHORT_URL, "https://on.soundcloud.com/next"]


@pytest.mark.parametrize(
    "url",
    [
        PRIVATE_URL,
        "https://on.soundcloud.com.example.org/share",
        "https://example.org/?url=https://on.soundcloud.com/share",
        "ftp://on.soundcloud.com/share",
    ],
)
def test_short_link_detection_requires_soundcloud_host(url):
    assert not soundcloud.is_short_link(url)


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(200, text="Open in app"),
        httpx.Response(404),
        httpx.Response(302),
        httpx.Response(302, headers={"Location": "https://example.org/sets/mix"}),
        httpx.Response(302, headers={"Location": "soundcloud://playlists/42"}),
        httpx.Response(302, headers={"Location": SHORT_URL}),
        httpx.ConnectTimeout("unreachable"),
    ],
)
def test_unresolved_short_link_has_actionable_error(short_http, response):
    routes, calls = short_http
    routes[SHORT_URL] = response

    with pytest.raises(HTTPException) as exc:
        asyncio.run(importer._normalize_url(SHORT_URL))

    assert exc.value.status_code == 502
    assert "SoundCloud" in exc.value.detail
    assert "полную ссылку" in exc.value.detail
    assert 1 <= len(calls) <= 5
    assert set(calls) == {SHORT_URL}


def _track(track_id):
    return {
        "id": track_id,
        "title": f"Song {track_id}",
        "permalink_url": f"https://soundcloud.com/artist/song-{track_id}",
        "duration": 180_000,
        "user": {"username": "Artist"},
    }


def _playlist():
    return {
        "id": 42,
        "kind": "playlist",
        "title": "Mobile mix",
        "sharing": "private",
        "secret_token": "s-privateToken",
        "permalink_url": "https://soundcloud.com/listener/sets/mix",
        "artwork_url": "https://i1.sndcdn.com/mix-large.jpg",
        "user": {"username": "Listener"},
        "track_count": 3,
        "tracks": [_track(11), {"id": 22}, {"id": 33}],
    }


@pytest.mark.parametrize("url", [SHORT_URL, PRIVATE_URL])
def test_preview_and_import_private_playlist(client, db, monkeypatch, short_http, url):
    routes, _ = short_http
    routes[SHORT_URL] = httpx.Response(302, headers={"Location": PRIVATE_URL})
    create_user(db)
    headers = auth_headers(client)
    api_calls = []

    async def api_get(path, params):
        api_calls.append((path, params))
        if path == "/resolve":
            assert params == {"url": PRIVATE_URL}
            return _playlist()
        if path == "/tracks":
            assert params == {"ids": "22,33"}
            return [_track(33), _track(22)]  # API не гарантирует порядок.
        raise AssertionError(f"Unexpected request: {path}")

    async def no_refresh(*args):
        pass

    monkeypatch.setattr(soundcloud, "_api_get", api_get)
    monkeypatch.setattr(importer, "_refresh_flow_after_import", no_refresh)
    monkeypatch.setattr("app.routers.tracks._link_archived_object", lambda *_: None)

    preview = client.post("/api/import/preview", json={"url": url}, headers=headers)
    assert preview.status_code == 200, preview.text
    body = preview.json()
    assert (body["source"], body["kind"], body["title"], body["track_count"]) == (
        "soundcloud", "playlist", "Mobile mix", 3
    )
    assert [t["title"] for t in body["tracks"]] == ["Song 11", "Song 22", "Song 33"]
    assert all(t["artist"] == "Artist" and t["duration"] == 180 for t in body["tracks"])
    assert db.query(Playlist).count() == 0
    assert db.query(Track).count() == 0

    imported = client.post("/api/import", json={"url": url}, headers=headers)
    assert imported.status_code == 200, imported.text
    body = imported.json()
    assert (body["imported"], body["matched"], body["skipped"]) == (3, 0, 0)
    assert body["playlist"]["name"] == "Mobile mix"
    assert body["playlist"]["cover_url"] == "https://i1.sndcdn.com/mix-t500x500.jpg"
    saved = db.get(Playlist, body["playlist"]["id"])
    assert not saved.is_public
    ordered = (
        db.query(Track)
        .join(playlist_tracks, playlist_tracks.c.track_id == Track.id)
        .filter(playlist_tracks.c.playlist_id == saved.id)
        .order_by(playlist_tracks.c.position)
        .all()
    )
    assert [t.external_id for t in ordered] == ["11", "22", "33"]
    assert all(t.source == "soundcloud" and "/api/soundcloud/stream/" in t.stream_url for t in ordered)
    assert [path for path, _ in api_calls] == ["/resolve", "/tracks", "/resolve", "/tracks"]


def test_public_playlist_by_id_still_loads_missing_tracks(monkeypatch):
    async def api_get(path, params):
        if path == "/playlists/42":
            data = _playlist()
            data["sharing"] = "public"
            data.pop("secret_token")
            return data
        assert path == "/tracks"
        assert params == {"ids": "22,33"}
        return [_track(33), _track(22)]

    monkeypatch.setattr(soundcloud, "_api_get", api_get)
    request = Request({
        "type": "http", "scheme": "http", "server": ("testserver", 80), "path": "/", "headers": []
    })
    meta, tracks = asyncio.run(soundcloud.get_playlist_tracks(request, "42"))
    assert meta.title == "Mobile mix"
    assert [t.external_id for t in tracks] == ["11", "22", "33"]
