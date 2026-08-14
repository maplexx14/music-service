from app.email_verification import get_pending_registration, reissue_pending_token
from app.models import User
from app.trusted_devices import DEVICE_TOKEN_HEADER
from tests.conftest import create_user, trust_device


def test_register_and_login(client, db):
    resp = client.post("/api/auth/register", json={
        "username": "bob",
        "email": "bob@example.com",
        "password": "secret123",
    })
    assert resp.status_code == 201
    body = resp.json()
    assert body["username"] == "bob"
    assert body["email_verified"] is False

    # Регистрация больше не даёт вход — сначала подтверждение почты.
    # Отдельно это покрыто в tests/test_email_verification.py.
    assert db.query(User).filter(User.username == "bob").first() is None
    pending = get_pending_registration("bob")
    assert pending is not None
    token = reissue_pending_token(pending)
    assert client.post("/api/auth/verify-email", json={"token": token}).status_code == 200

    user = db.query(User).filter(User.username == "bob").first()
    assert user is not None

    resp = client.post(
        "/api/auth/login",
        data={"username": "bob", "password": "secret123"},
        # Вход с незнакомого устройства просит код на почту — это отдельная
        # проверка (tests/test_trusted_devices.py). Здесь нужен сам вход,
        # поэтому устройство сразу доверенное.
        headers={DEVICE_TOKEN_HEADER: trust_device(db, user.id)},
    )
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
