"""Onboarding belongs to the account, including a completion with no choices."""

import importlib.util
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

from tests.conftest import auth_headers, create_user


@pytest.mark.parametrize("path", ["/api/auth/me", "/api/users/me"])
def test_new_account_has_not_completed_onboarding(client, db, path):
    create_user(db)
    response = client.get(path, headers=auth_headers(client))
    assert response.status_code == 200
    assert response.json()["onboarding_completed"] is False


def test_skip_is_persisted_for_a_login_from_another_browser(client, db, monkeypatch):
    user = create_user(db)
    response = client.post("/api/users/me/onboarding/complete", headers=auth_headers(client))
    assert response.status_code == 200, response.text
    assert response.json()["onboarding_completed"] is True
    assert response.json()["preferred_genres"] == []
    assert response.json()["preferred_artists"] == []
    db.expire_all()
    assert user.onboarding_completed is True

    codes = []

    def capture_code(to_email, username, code, purpose):
        codes.append(code)
        return True

    monkeypatch.setattr("app.routers.auth.send_email_code", capture_code)
    login = client.post(
        "/api/auth/login",
        data={"username": "alice", "password": "password123"},
        headers={"User-Agent": "Another browser"},
    ).json()
    assert login["mfa_required"] is True
    token_response = client.post(
        "/api/auth/mfa/verify", json={"mfa_token": login["mfa_token"], "code": codes[-1]},
    )
    assert token_response.status_code == 200, token_response.text
    token = token_response.json()["access_token"]
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200
    assert me.json()["onboarding_completed"] is True


def test_completion_is_idempotent_and_preserves_preferences_and_other_accounts(client, db):
    alice = create_user(db)
    bob = create_user(db, "bob")
    alice.preferred_genres = ["rock"]
    alice.preferred_artists = ["Radiohead"]
    alice.excluded_artists = ["Other artist"]
    alice.discovery_ratio = 0.7
    alice.flow_tuning = {"liked": 0.8}
    db.commit()

    for _ in range(2):
        response = client.post("/api/users/me/onboarding/complete", headers=auth_headers(client))
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["onboarding_completed"] is True
        assert body["preferred_genres"] == ["rock"]
        assert body["preferred_artists"] == ["Radiohead"]
        assert body["excluded_artists"] == ["Other artist"]
        assert body["discovery_ratio"] == 0.7
        assert body["flow_tuning"] == {"liked": 0.8}
    db.refresh(bob)
    assert bob.onboarding_completed is False


def test_completion_requires_authentication(client):
    assert client.post("/api/users/me/onboarding/complete").status_code == 401


def test_preferences_do_not_complete_onboarding_or_reset_its_completion(client, db):
    create_user(db)
    headers = auth_headers(client)
    for genres in ([], ["rock"]):
        response = client.put(
            "/api/users/me/preferences", json={"preferred_genres": genres}, headers=headers,
        )
        assert response.status_code == 200, response.text
        assert response.json()["preferred_genres"] == genres
        assert response.json()["onboarding_completed"] is False

    completed = client.post("/api/users/me/onboarding/complete", headers=headers)
    assert completed.status_code == 200, completed.text
    assert completed.json()["onboarding_completed"] is True
    cleared = client.put("/api/users/me/preferences", json={"preferred_genres": []}, headers=headers)
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["onboarding_completed"] is True


def _migration():
    path = Path(__file__).resolve().parents[1] / "alembic/versions/0036_user_onboarding.py"
    spec = importlib.util.spec_from_file_location("user_onboarding_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_migration_keeps_existing_accounts_out_but_new_and_unverified_accounts_pending():
    engine = sa.create_engine("sqlite://")
    migration = _migration()
    with engine.begin() as connection:
        connection.execute(sa.text(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, email_verified BOOLEAN NOT NULL)"
        ))
        connection.execute(sa.text("INSERT INTO users VALUES (1, true), (2, false)"))
        with Operations.context(MigrationContext.configure(connection)):
            migration.upgrade()
            connection.execute(sa.text("INSERT INTO users (id, email_verified) VALUES (3, true)"))
            # An idempotent rerun must not complete accounts created since the migration.
            migration.upgrade()
            rows = connection.execute(sa.text(
                "SELECT id, onboarding_completed FROM users ORDER BY id"
            )).all()
            assert rows == [(1, True), (2, False), (3, False)]
            migration.downgrade()
            assert "onboarding_completed" not in {
                column["name"] for column in sa.inspect(connection).get_columns("users")
            }
    engine.dispose()


def test_migration_preserves_pending_users_when_create_all_already_added_the_column():
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(sa.text(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, email_verified BOOLEAN NOT NULL, "
            "onboarding_completed BOOLEAN NOT NULL DEFAULT false)"
        ))
        connection.execute(sa.text("INSERT INTO users (id, email_verified) VALUES (1, true)"))
        with Operations.context(MigrationContext.configure(connection)):
            _migration().upgrade()
        assert not connection.execute(sa.text("SELECT onboarding_completed FROM users")).scalar_one()
    engine.dispose()
