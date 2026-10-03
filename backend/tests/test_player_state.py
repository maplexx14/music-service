"""Состояние плеера на сервере: GET/PUT /users/me/player-state.

Клиент (services/playerPersist.js) шлёт снимок как есть; сервер хранит
последний на юзера и отдаёт его на другом устройстве.
"""

from app.routers.users import PLAYER_STATE_MAX_BYTES

from tests.conftest import auth_headers, create_user


def _snapshot(title="Song", position=42.5):
    return {
        "queue": [{"id": 1, "title": title, "artist": "A", "source": "local"}],
        "currentIndex": 0,
        "isShuffle": False,
        "position": position,
    }


def test_player_state_empty_by_default(client, db):
    create_user(db, "listener")
    resp = client.get("/api/users/me/player-state", headers=auth_headers(client, "listener"))
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"state": None, "saved_at": None}


def test_player_state_roundtrip_and_overwrite(client, db):
    create_user(db, "listener")
    headers = auth_headers(client, "listener")

    resp = client.put(
        "/api/users/me/player-state",
        json={"state": _snapshot(), "saved_at": 1000},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    resp = client.put(
        "/api/users/me/player-state",
        json={"state": _snapshot("Other", 7), "saved_at": 2000},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text

    body = client.get("/api/users/me/player-state", headers=headers).json()
    assert body["saved_at"] == 2000
    assert body["state"]["queue"][0]["title"] == "Other"
    assert body["state"]["position"] == 7


def test_player_state_is_per_user(client, db):
    create_user(db, "alice")
    create_user(db, "bob")
    client.put(
        "/api/users/me/player-state",
        json={"state": _snapshot(), "saved_at": 1000},
        headers=auth_headers(client, "alice"),
    )
    body = client.get("/api/users/me/player-state", headers=auth_headers(client, "bob")).json()
    assert body["state"] is None


def test_player_state_rejects_oversized(client, db):
    create_user(db, "listener")
    state = {"blob": "x" * (PLAYER_STATE_MAX_BYTES + 1)}
    resp = client.put(
        "/api/users/me/player-state",
        json={"state": state, "saved_at": 1},
        headers=auth_headers(client, "listener"),
    )
    assert resp.status_code == 413


def test_player_state_requires_auth(client):
    assert client.get("/api/users/me/player-state").status_code == 401


def test_player_state_expires_after_48_hours(client, db):
    from datetime import datetime, timedelta, timezone

    from app.models import UserPlayerState

    user = create_user(db, "listener")
    headers = auth_headers(client, "listener")
    client.put(
        "/api/users/me/player-state",
        json={"state": _snapshot(), "saved_at": 1000},
        headers=headers,
    )
    row = db.get(UserPlayerState, user.id)
    row.updated_at = datetime.now(timezone.utc) - timedelta(hours=47)
    db.commit()
    assert client.get("/api/users/me/player-state", headers=headers).json()["saved_at"] == 1000

    row.updated_at = datetime.now(timezone.utc) - timedelta(hours=49)
    db.commit()
    body = client.get("/api/users/me/player-state", headers=headers).json()
    assert body == {"state": None, "saved_at": None}
    db.expire_all()
    assert db.get(UserPlayerState, user.id) is None


def test_player_state_delete(client, db):
    create_user(db, "listener")
    headers = auth_headers(client, "listener")
    client.put(
        "/api/users/me/player-state",
        json={"state": _snapshot(), "saved_at": 1000},
        headers=headers,
    )
    assert client.delete("/api/users/me/player-state", headers=headers).status_code == 200
    assert client.get("/api/users/me/player-state", headers=headers).json()["state"] is None
    # Повторное удаление пустого — не ошибка.
    assert client.delete("/api/users/me/player-state", headers=headers).status_code == 200
