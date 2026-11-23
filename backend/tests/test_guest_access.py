import pytest

from app.models import Playlist, Track
from tests.conftest import auth_headers, create_user


@pytest.mark.parametrize("method,path", [
    ("get", "/api/tracks/"),
    ("get", "/api/tracks/12345678-1234-1234-1234-123456789abc"),
    ("get", "/api/tracks/me/liked"),
    ("get", "/api/tracks/me/history"),
    ("get", "/api/playlists/"),
    ("get", "/api/recommendations/flow"),
    ("get", "/api/home/releases"),
    ("get", "/api/artists?name=Muse"),
    ("get", "/api/albums/ytmusic/album"),
    ("get", "/api/soundcloud/playlists/1"),
    ("get", "/api/spotify/album/1"),
    ("get", "/api/import/listen?url=https://open.spotify.com/track/1"),
    ("get", "/api/lyrics?artist=Muse&title=Uprising"),
    ("get", "/api/users/me"),
    ("post", "/api/tracks/import"),
    ("post", "/api/tracks/12345678-1234-1234-1234-123456789abc/like"),
    ("post", "/api/playlists/"),
    ("post", "/api/tracks/upload"),
])
def test_guest_cannot_use_other_features(client, method, path):
    response = getattr(client, method)(path)
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


def test_guest_can_find_public_playlist_summaries_but_cannot_open_them(client, db):
    user = create_user(db)
    track = Track(title="Guest test song", artist="Muse", duration=180)
    playlist = Playlist(name="Guest test playlist", owner_id=user.id, is_public=True)
    db.add_all([track, playlist])
    db.commit()
    response = client.get("/api/search/", params={"q": "Guest test"})
    assert response.status_code == 200
    assert [item["id"] for item in response.json()["tracks"]] == [track.id]
    assert [item["id"] for item in response.json()["playlists"]] == [playlist.id]
    assert "tracks" not in response.json()["playlists"][0]
    assert client.get(f"/api/playlists/{playlist.id}").status_code == 401

    member = client.get("/api/search/", params={"q": "Guest test"}, headers=auth_headers(client))
    assert member.status_code == 200
    assert [item["id"] for item in member.json()["playlists"]] == [playlist.id]


@pytest.mark.parametrize("path", [
    "/api/tracks/12345678-1234-1234-1234-123456789abc/stream",
    "/api/tracks/cover/missing.jpg",
])
def test_guest_audio_and_artwork_routes_remain_public(client, path):
    # A missing resource is a 404, rather than a registration requirement.
    assert client.get(path).status_code == 404


def test_member_keeps_library_access(client, db):
    create_user(db)
    assert client.get("/api/tracks/", headers=auth_headers(client)).status_code == 200
    assert client.get("/api/playlists/", headers=auth_headers(client)).status_code == 200


def test_guest_provider_search_is_public(client, monkeypatch):
    async def empty(*args, **kwargs):
        return []
    monkeypatch.setattr("app.routers.importer._provider_search", empty)
    monkeypatch.setattr("app.routers.importer.get_cache_async", empty_cache)
    assert client.get("/api/import/search/deezer", params={"q": "Guest search"}).json() == []


async def empty_cache(*args, **kwargs):
    return None
