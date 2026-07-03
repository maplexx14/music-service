from tests.conftest import create_user


def test_register_and_login(client):
    resp = client.post("/api/auth/register", json={
        "username": "bob",
        "email": "bob@example.com",
        "password": "secret123",
    })
    assert resp.status_code == 201
    body = resp.json()
    assert body["username"] == "bob"
    assert body["is_admin"] is False
    assert "hashed_password" not in body

    resp = client.post("/api/auth/login", data={"username": "bob", "password": "secret123"})
    assert resp.status_code == 200
    assert resp.json()["access_token"]


def test_register_duplicate(client, db):
    create_user(db, "bob")
    resp = client.post("/api/auth/register", json={
        "username": "bob",
        "email": "bob@example.com",
        "password": "secret123",
    })
    assert resp.status_code == 400


def test_login_wrong_password(client, db):
    create_user(db, "bob")
    resp = client.post("/api/auth/login", data={"username": "bob", "password": "wrong"})
    assert resp.status_code == 401


def test_me_requires_auth(client):
    assert client.get("/api/auth/me").status_code == 401
