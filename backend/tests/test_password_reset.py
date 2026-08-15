from app.auth import verify_password
from app.models import user_trusted_devices
from app.password_reset import consume_reset_token, issue_reset_token
from tests.conftest import create_user, trust_device


def test_forgot_password_does_not_reveal_unknown_email(client):
    response = client.post(
        "/api/auth/forgot-password", json={"email": "unknown@example.com"}
    )
    assert response.status_code == 200
    assert "Если аккаунт" in response.json()["message"]


def test_reset_password_changes_password_and_revokes_devices(client, db):
    user = create_user(db, username="reset-user", password="old-password")
    trust_device(db, user.id)
    token = issue_reset_token(user.id)

    response = client.post(
        "/api/auth/reset-password",
        json={"token": token, "new_password": "new-password"},
    )

    assert response.status_code == 200, response.text
    db.refresh(user)
    assert verify_password("new-password", user.hashed_password)
    assert not verify_password("old-password", user.hashed_password)
    assert db.execute(
        user_trusted_devices.select().where(user_trusted_devices.c.user_id == user.id)
    ).first() is None

    reused = client.post(
        "/api/auth/reset-password",
        json={"token": token, "new_password": "another-password"},
    )
    assert reused.status_code == 400


def test_issuing_new_token_invalidates_previous_one(db):
    user = create_user(db, username="second-link")
    first = issue_reset_token(user.id)
    second = issue_reset_token(user.id)

    assert consume_reset_token(first) is None
    assert consume_reset_token(second) == user.id
