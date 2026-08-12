"""Подтверждение почты: блокировка входа, одноразовость ссылки, повторная отправка."""
import pytest

from app.email_verification import consume_token, issue_token
from app.models import User
from app.trusted_devices import DEVICE_TOKEN_HEADER
from tests.conftest import create_user, trust_device


def _register(client, username="bob", email=None, password="password123"):
    return client.post(
        "/api/auth/register",
        json={
            "username": username,
            "email": email or f"{username}@example.com",
            "password": password,
        },
    )


def _token_for(user_id):
    """Токен из Redis тем же путём, каким его выписывает register."""
    return issue_token(user_id)


def test_register_leaves_email_unverified(client, db):
    resp = _register(client)
    assert resp.status_code == 201, resp.text
    assert resp.json()["email_verified"] is False

    user = db.query(User).filter(User.username == "bob").first()
    assert user.email_verified is False


def test_login_blocked_until_verified(client, db):
    _register(client)
    resp = client.post(
        "/api/auth/login", data={"username": "bob", "password": "password123"}
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "Email not verified"


def test_wrong_password_on_unverified_user_says_password(client, db):
    """Проверка пароля идёт раньше проверки почты: иначе по разнице ответов
    можно перебирать существующие имена."""
    _register(client)
    resp = client.post("/api/auth/login", data={"username": "bob", "password": "wrong"})
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Incorrect username or password"


def test_verify_email_unlocks_login(client, db):
    _register(client)
    user = db.query(User).filter(User.username == "bob").first()
    token = _token_for(user.id)

    resp = client.post("/api/auth/verify-email", json={"token": token})
    assert resp.status_code == 200, resp.text
    assert resp.json()["email_verified"] is True

    login = client.post(
        "/api/auth/login",
        data={"username": "bob", "password": "password123"},
        # Устройство доверенное: проверяем, что подтверждение почты снимает
        # 403, а не второй фактор нового устройства (см. test_trusted_devices).
        headers={DEVICE_TOKEN_HEADER: trust_device(db, user.id)},
    )
    assert login.status_code == 200
    assert login.json()["access_token"]


def test_token_is_single_use(client, db):
    _register(client)
    user = db.query(User).filter(User.username == "bob").first()
    token = _token_for(user.id)

    assert client.post("/api/auth/verify-email", json={"token": token}).status_code == 200
    second = client.post("/api/auth/verify-email", json={"token": token})
    assert second.status_code == 400
    assert second.json()["detail"] == "Invalid or expired verification link"


def test_garbage_token_rejected(client, db):
    resp = client.post("/api/auth/verify-email", json={"token": "not-a-real-token"})
    assert resp.status_code == 400


def test_resend_invalidates_previous_token(client, db):
    """Утёкшая первая ссылка не должна переживать повторную отправку."""
    _register(client)
    user = db.query(User).filter(User.username == "bob").first()
    first = _token_for(user.id)
    second = _token_for(user.id)

    assert client.post("/api/auth/verify-email", json={"token": first}).status_code == 400
    assert client.post("/api/auth/verify-email", json={"token": second}).status_code == 200


def test_resend_requires_correct_password(client, db):
    _register(client)
    resp = client.post(
        "/api/auth/resend-verification",
        json={"username": "bob", "password": "wrong"},
    )
    assert resp.status_code == 401


def test_resend_rejected_when_already_verified(client, db):
    create_user(db, username="carol", email_verified=True)
    resp = client.post(
        "/api/auth/resend-verification",
        json={"username": "carol", "password": "password123"},
    )
    assert resp.status_code == 400
    assert resp.json()["detail"] == "Email already verified"


def test_resend_succeeds_for_unverified(client, db):
    _register(client)
    resp = client.post(
        "/api/auth/resend-verification",
        json={"username": "bob", "password": "password123"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["email_verified"] is False


def test_consume_token_returns_user_id_once():
    """Уровень модуля: getdel гасит ключ, второй вызов пустой."""
    token = issue_token(4242)
    assert consume_token(token) == 4242
    assert consume_token(token) is None
