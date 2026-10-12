"""«Связь с разработчиком»: POST /feedback от юзера, чтение в админке."""

from tests.conftest import auth_headers, create_user


def test_user_sends_message_and_admin_reads_it(client, db):
    create_user(db, "listener")
    create_user(db, "boss", is_admin=True)

    resp = client.post(
        "/api/feedback",
        json={"message": "  Не играет трек  ", "context": {"build": "abc"}},
        headers=auth_headers(client, "listener"),
    )
    assert resp.status_code == 201, resp.text
    message_id = resp.json()["id"]

    admin = auth_headers(client, "boss")
    items = client.get("/api/feedback", headers=admin).json()
    assert len(items) == 1
    assert items[0]["message"] == "Не играет трек"
    assert items[0]["context"] == {"build": "abc"}
    assert items[0]["user"]["username"] == "listener"
    assert items[0]["is_read"] is False

    resp = client.post(f"/api/feedback/{message_id}/read", headers=admin)
    assert resp.status_code == 200, resp.text
    assert resp.json()["is_read"] is True


def test_empty_message_rejected(client, db):
    create_user(db, "listener")
    resp = client.post(
        "/api/feedback", json={"message": "   "}, headers=auth_headers(client, "listener")
    )
    assert resp.status_code == 422


def test_non_admin_cannot_list(client, db):
    create_user(db, "listener")
    resp = client.get("/api/feedback", headers=auth_headers(client, "listener"))
    assert resp.status_code == 403


def test_anonymous_cannot_send(client, db):
    resp = client.post("/api/feedback", json={"message": "hi"})
    assert resp.status_code == 401
