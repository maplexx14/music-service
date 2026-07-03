import io

from app.models import Track
from tests.conftest import create_user, auth_headers


def make_track(db):
    track = Track(title="Song", artist="Artist", duration=120, file_path="/music_files/x.mp3")
    db.add(track)
    db.commit()
    db.refresh(track)
    return track


def test_upload_requires_auth(client):
    resp = client.post("/api/tracks/upload", files={"file": ("a.mp3", io.BytesIO(b"x"), "audio/mpeg")})
    assert resp.status_code == 401


def test_upload_rejects_bad_extension(client, db):
    create_user(db)
    headers = auth_headers(client)
    resp = client.post(
        "/api/tracks/upload",
        headers=headers,
        files={"file": ("evil.exe", io.BytesIO(b"MZ"), "application/octet-stream")},
        data={"title": "t", "artist": "a"},
    )
    assert resp.status_code == 400


def test_upload_rejects_invalid_audio_content(client, db):
    create_user(db)
    headers = auth_headers(client)
    resp = client.post(
        "/api/tracks/upload",
        headers=headers,
        files={"file": ("fake.mp3", io.BytesIO(b"not really audio"), "audio/mpeg")},
        data={"title": "t", "artist": "a"},
    )
    assert resp.status_code == 400
    assert "valid audio" in resp.json()["detail"]


def test_delete_track_requires_admin(client, db):
    create_user(db, "user1")
    track = make_track(db)
    headers = auth_headers(client, "user1")
    resp = client.delete(f"/api/tracks/{track.id}", headers=headers)
    assert resp.status_code == 403


def test_delete_track_as_admin(client, db):
    create_user(db, "admin1", is_admin=True)
    track = make_track(db)
    headers = auth_headers(client, "admin1")
    resp = client.delete(f"/api/tracks/{track.id}", headers=headers)
    assert resp.status_code == 200
    assert db.query(Track).count() == 0


def test_user_count_requires_admin(client, db):
    create_user(db, "user1")
    headers = auth_headers(client, "user1")
    assert client.get("/api/users/stats/count", headers=headers).status_code == 403
