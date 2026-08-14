"""Подтверждение почты: блокировка входа, одноразовость ссылки, повторная отправка."""
import pytest

from app.email_verification import (
    consume_token,
    get_pending_registration,
    issue_token,
    reissue_pending_token,
)
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


def _token_for(username):
    """Свежая ссылка для временной заявки, ещё не попавшей в users."""
    pending = get_pending_registration(username)
    assert pending is not None
    return reissue_pending_token(pending)


def test_register_does_not_create_user_before_confirmation(client, db):
    resp = _register(client)
    assert resp.status_code == 201, resp.text
    assert resp.json()["email_verified"] is False
    assert db.query(User).filter(User.username == "bob").first() is None


def test_login_fails_until_user_is_created_by_confirmation(client, db):
    _register(client)
    resp = client.post(
        "/api/auth/login", data={"username": "bob", "password": "password123"}
    )
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Incorrect username or password"


def test_wrong_password_on_unverified_user_says_password(client, db):
    """Проверка пароля идёт раньше проверки почты: иначе по разнице ответов
    можно перебирать существующие имена."""
    _register(client)
    resp = client.post("/api/auth/login", data={"username": "bob", "password": "wrong"})
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Incorrect username or password"


def test_verify_email_unlocks_login(client, db):
    _register(client)
    token = _token_for("bob")

    resp = client.post("/api/auth/verify-email", json={"token": token})
    assert resp.status_code == 200, resp.text
    assert resp.json()["email_verified"] is True
    assert resp.json()["access_token"]

    me = client.get(
        "/api/auth/me",
        headers={"Authorization": f"Bearer {resp.json()['access_token']}"},
    )
    assert me.status_code == 200
    assert me.json()["username"] == "bob"

    user = db.query(User).filter(User.username == "bob").first()
    assert user is not None
    assert user.email_verified is True

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
    token = _token_for("bob")

    assert client.post("/api/auth/verify-email", json={"token": token}).status_code == 200
    second = client.post("/api/auth/verify-email", json={"token": token})
    assert second.status_code == 400
    assert second.json()["detail"] == "Invalid or expired verification link"


def test_legacy_verification_link_does_not_bypass_login(client, db):
    user = create_user(db, username="legacy", email_verified=False)
    token = issue_token(user.id)

    resp = client.post("/api/auth/verify-email", json={"token": token})

    assert resp.status_code == 200
    assert resp.json()["email_verified"] is True
    assert resp.json()["access_token"] is None


def test_garbage_token_rejected(client, db):
    resp = client.post("/api/auth/verify-email", json={"token": "not-a-real-token"})
    assert resp.status_code == 400


def test_resend_invalidates_previous_token(client, db):
    """Утёкшая первая ссылка не должна переживать повторную отправку."""
    _register(client)
    first = _token_for("bob")
    second = _token_for("bob")

    assert client.post("/api/auth/verify-email", json={"token": first}).status_code == 400
    assert client.post("/api/auth/verify-email", json={"token": second}).status_code == 200


def test_pending_username_and_email_are_reserved(client, db):
    assert _register(client, username="bob", email="bob@example.com").status_code == 201

    same_username = _register(client, username="bob", email="other@example.com")
    same_email = _register(client, username="other", email="bob@example.com")

    assert same_username.status_code == 400
    assert same_email.status_code == 400
    assert db.query(User).count() == 0


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
