"""Ссылки Deezer и «послушать ссылку» без импорта (GET /api/import/listen)."""

import asyncio
import uuid

import pytest
from fastapi import HTTPException

from app import deezer_links
from app.routers import importer, spotify
from tests.conftest import auth_headers, create_user


@pytest.mark.parametrize(
    "url,expected",
    [
        ("https://www.deezer.com/track/3135556", ("track", "3135556")),
        ("https://www.deezer.com/ru/album/302127", ("album", "302127")),
        ("https://deezer.com/en-gb/playlist/908622995?utm=x", ("playlist", "908622995")),
        ("https://www.deezer.com/fr/artist/27", ("artist", "27")),
    ],
)
def test_deezer_parse_url(url, expected):
    assert deezer_links.parse_url(url) == expected
    assert importer._detect(url) == ("deezer", expected[0])


@pytest.mark.parametrize(
    "url",
    ["", "https://www.deezer.com/ru/profile/123", "https://open.spotify.com/track/abc"],
)
def test_deezer_parse_url_rejects_others(url):
    assert deezer_links.parse_url(url) is None


def test_deezer_short_links_are_normalized(monkeypatch):
    async def fake_resolve(url):
        return "https://www.deezer.com/ru/playlist/42"

    monkeypatch.setattr(deezer_links, "resolve_short_link", fake_resolve)
    assert deezer_links.is_short_link("https://link.deezer.com/s/30abcd")
    assert deezer_links.is_short_link("https://deezer.page.link/xyz")
    url = asyncio.run(importer._normalize_url("https://link.deezer.com/s/30abcd"))
    assert importer._detect(url) == ("deezer", "playlist")


def test_deezer_playlist_follows_pages(monkeypatch):
    pages = {
        0: {"data": [{"id": 1, "title": "One", "artist": {"name": "A"}, "duration": 200,
                      "explicit_lyrics": True, "album": {"title": "Al", "cover_xl": "c1"}}],
            "next": "https://api.deezer.com/playlist/9/tracks?index=1"},
        1: {"data": [{"id": 2, "title": "Two", "artist": {"name": "B"}, "duration": 100},
                     {"id": None, "title": "broken"}]},
    }

    async def fake_get(_client, path, params=None):
        if path == "/playlist/9":
            return {"title": "Mix", "picture_xl": "pl-cover"}
        return pages[params["index"]]

    monkeypatch.setattr(deezer_links, "_get", fake_get)
    title, cover, tracks = asyncio.run(deezer_links.fetch_entity("playlist", "9"))
    assert (title, cover) == ("Mix", "pl-cover")
    assert [(t.id, t.title, t.artist, t.explicit) for t in tracks] == [
        ("1", "One", "A", True),
        ("2", "Two", "B", False),
    ]
    assert tracks[0].cover_url == "c1"


def test_deezer_album_tracks_take_album_cover(monkeypatch):
    async def fake_get(_client, path, params=None):
        if path == "/album/5":
            return {"title": "LP", "cover_xl": "lp-cover"}
        return {"data": [{"id": 7, "title": "Song", "artist": {"name": "C"}, "duration": 90}]}

    monkeypatch.setattr(deezer_links, "_get", fake_get)
    title, cover, tracks = asyncio.run(deezer_links.fetch_entity("album", "5"))
    assert (title, cover) == ("LP", "lp-cover")
    assert tracks[0].album == "LP"
    assert tracks[0].cover_url == "lp-cover"


def _fake_ytmusic(monkeypatch, missing=()):
    async def fake_search(_request, query, limit=3):
        if any(m in query for m in missing):
            return []
        vid = query.split()[-1]
        return [
            importer.ExternalTrackImport(
                source="ytmusic", external_id=f"yt-{vid}", title=vid, artist="A",
                duration=200, stream_url="https://stale.host/stream",
            )
        ]

    monkeypatch.setattr(importer.ytdlp, "search_ytmusic", fake_search)


def test_listen_pages_matches_without_saving(client, db, monkeypatch):
    create_user(db)
    headers = auth_headers(client)
    # Уникальные id: кэш подбора и метаданных живёт в Redis между прогонами.
    tag = uuid.uuid4().hex[:8]
    calls = []

    async def fake_fetch(url):
        calls.append(url)
        return "Deezer Mix", "cover", [
            deezer_links.DeezerTrack(id=f"{tag}{i}", title=f"T{tag}{i}", artist="A", duration=200)
            for i in range(3)
        ]

    monkeypatch.setattr(deezer_links, "fetch_by_url", fake_fetch)
    _fake_ytmusic(monkeypatch, missing=(f"T{tag}1",))
    url = f"https://www.deezer.com/playlist/{int(tag, 16)}"

    first = client.get("/api/import/listen", params={"url": url, "limit": 2}, headers=headers)
    assert first.status_code == 200, first.text
    body = first.json()
    assert (body["source"], body["kind"], body["title"]) == ("deezer", "playlist", "Deezer Mix")
    assert body["total"] == 3
    assert first.headers["x-total-count"] == "3"
    assert body["next_offset"] == 2
    assert body["skipped"] == 1
    track = body["tracks"][0]
    assert track["id"] == f"ytmusic:yt-T{tag}0"
    # stream_url собирается от адреса запроса, а не из кэша подбора.
    assert track["stream_url"].endswith(f"/api/ytdlp/stream/yt-T{tag}0")
    assert "stale.host" not in track["stream_url"]

    second = client.get(
        "/api/import/listen", params={"url": url, "skip": 2, "limit": 2}, headers=headers
    )
    assert second.status_code == 200, second.text
    assert second.json()["next_offset"] is None
    assert [t["title"] for t in second.json()["tracks"]] == [f"T{tag}2"]
    # Вторая страница берёт метаданные из кэша, а не из Deezer заново.
    assert len(calls) == 1

    from app.models import Playlist, Track

    assert db.query(Playlist).count() == 0
    assert db.query(Track).filter(Track.external_id.like(f"yt-T{tag}%")).count() == 0


def test_listen_works_for_spotify(client, db, monkeypatch):
    create_user(db)
    headers = auth_headers(client)
    tag = uuid.uuid4().hex[:8]

    async def fake_fetch(url):
        return "Spotify Track", None, [
            spotify.SpotifyTrack(id=f"s{tag}", title=f"S{tag}", artist="A", duration=200)
        ]

    monkeypatch.setattr(spotify, "fetch_by_url", fake_fetch)
    _fake_ytmusic(monkeypatch)
    resp = client.get(
        "/api/import/listen",
        params={"url": f"https://open.spotify.com/track/{tag}"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["kind"] == "track"
    assert resp.json()["tracks"][0]["external_id"] == f"yt-S{tag}"


def test_listen_rejects_soundcloud(client, db):
    create_user(db)
    headers = auth_headers(client)
    resp = client.get(
        "/api/import/listen",
        params={"url": "https://soundcloud.com/user/sets/x"},
        headers=headers,
    )
    assert resp.status_code == 400


def test_deezer_missing_entity_is_404(monkeypatch):
    class Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"error": {"type": "DataException", "code": 800}}

    class Client:
        async def get(self, *_a, **_k):
            return Resp()

    with pytest.raises(HTTPException) as exc:
        asyncio.run(deezer_links._get(Client(), "/playlist/1"))
    assert exc.value.status_code == 404


def test_provider_search_shows_catalog_metadata_and_plays_match(client, db, monkeypatch):
    create_user(db)
    headers = auth_headers(client)
    tag = uuid.uuid4().hex[:8]

    async def fake_search(q, limit=20):
        return [
            deezer_links.DeezerTrack(id=f"{tag}a", title=f"Song{tag}", artist="Dz Artist",
                                     duration=180, cover_url="https://dz/cover.jpg", explicit=True),
            # Тот же трек ещё раз (другая редакция) — подберётся в ту же запись.
            deezer_links.DeezerTrack(id=f"{tag}b", title=f"Song{tag}", artist="Dz Artist", duration=181),
            deezer_links.DeezerTrack(id=f"{tag}c", title=f"Missing{tag}", artist="X", duration=100),
        ]

    async def fake_ytmusic(_request, query, limit=3):
        if "Missing" in query:
            return []
        return [
            importer.ExternalTrackImport(
                source="ytmusic", external_id=f"yt{tag}", title="yt title", artist="yt artist",
                duration=179, cover_url="https://yt/cover", stream_url="x",
            )
        ]

    monkeypatch.setattr(deezer_links, "search", fake_search)
    monkeypatch.setattr(importer.ytdlp, "search_ytmusic", fake_ytmusic)

    resp = client.get("/api/import/search/deezer", params={"q": f"song {tag}"}, headers=headers)
    assert resp.status_code == 200, resp.text
    tracks = resp.json()
    assert len(tracks) == 1
    track = tracks[0]
    assert track["provider"] == "deezer"
    assert (track["source"], track["external_id"]) == ("ytmusic", f"yt{tag}")
    assert (track["title"], track["artist"], track["cover_url"]) == (f"Song{tag}", "Dz Artist", "https://dz/cover.jpg")
    assert track["duration"] == 180
    assert track["is_explicit"] is True
    assert track["stream_url"].endswith(f"/api/ytdlp/stream/yt{tag}")


def test_provider_search_rejects_unknown_and_unconfigured_spotify(client, db, monkeypatch):
    create_user(db)
    headers = auth_headers(client)
    assert client.get("/api/import/search/tidal", params={"q": "x"}, headers=headers).status_code == 404
    monkeypatch.setattr(spotify, "is_configured", lambda: False)
    assert client.get("/api/import/search/spotify", params={"q": "x"}, headers=headers).status_code == 503
