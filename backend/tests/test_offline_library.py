from app.models import Playlist, Track
from tests.conftest import auth_headers, create_user


def test_offline_library_returns_only_requested_tracks_in_own_collections(client, db):
    user = create_user(db)
    other = create_user(db, username="other")
    downloaded = Track(title="Downloaded", artist="Artist", duration=180, file_path="/music/a.mp3")
    missing = Track(title="Not downloaded", artist="Artist", duration=180, file_path="/music/b.mp3")
    playlist = Playlist(name="My mix", owner_id=user.id, tracks=[downloaded, missing])
    foreign = Playlist(name="Foreign private mix", owner_id=other.id, is_public=False, tracks=[downloaded])
    db.add_all([downloaded, missing, playlist, foreign])
    db.commit()
    headers = auth_headers(client)
    assert client.post(f"/api/tracks/{downloaded.id}/like", headers=headers).status_code == 200
    response = client.post("/api/playlists/me/offline-library", json={"tracks": [{"id": downloaded.id}]}, headers=headers)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["likedKeys"] == [downloaded.id]
    assert len(data["playlists"]) == 1
    assert data["playlists"][0]["id"] == playlist.id
    assert data["playlists"][0]["track_keys"] == [downloaded.id]
    assert foreign.id not in str(data)
    assert missing.id not in str(data)


def test_provider_aliases_resolve_downloads_after_materialization(client, db):
    user = create_user(db)
    track = Track(title="External", artist="Artist", duration=180, file_path="", source="ytmusic", external_id="video-a")
    playlist = Playlist(name="External mix", owner_id=user.id, tracks=[track])
    db.add_all([track, playlist])
    db.commit()
    response = client.post("/api/playlists/me/offline-library", json={"tracks": [
        {"id": "ytmusic:video-a", "source": "ytmusic", "external_id": "video-a"},
        {"id": track.id},
    ]}, headers=auth_headers(client))
    assert response.status_code == 200, response.text
    assert response.json()["playlists"][0]["track_keys"] == ["ytmusic:video-a"]


def test_offline_library_requires_an_account_and_empty_library_has_no_memberships(client, db):
    assert client.post("/api/playlists/me/offline-library", json={"tracks": []}).status_code == 401
    create_user(db)
    response = client.post("/api/playlists/me/offline-library", json={"tracks": []}, headers=auth_headers(client))
    assert response.status_code == 200
    assert response.json() == {"playlists": [], "likedKeys": []}
