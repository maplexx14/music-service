import importlib.util
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

from tests.conftest import auth_headers, create_user


def test_music_onboarding_finishes_before_player_setup(client, db):
    create_user(db)
    headers = auth_headers(client)
    me = client.get("/api/auth/me", headers=headers).json()
    assert me["player_setup_completed"] is False
    rejected = client.post("/api/users/me/player-setup/complete", headers=headers)
    assert rejected.status_code == 409
    music = client.post("/api/users/me/onboarding/complete", headers=headers).json()
    assert music["onboarding_completed"] is True
    assert music["player_setup_completed"] is False


def test_setup_completion_is_idempotent_persists_and_preserves_other_data(client, db):
    alice = create_user(db)
    bob = create_user(db, "bob")
    alice.onboarding_completed = True
    alice.preferred_genres = ["rock"]
    alice.preferred_artists = ["Radiohead"]
    db.commit()
    headers = auth_headers(client)
    for _ in range(2):
        response = client.post("/api/users/me/player-setup/complete", headers=headers)
        assert response.status_code == 200, response.text
        assert response.json()["player_setup_completed"] is True
        assert response.json()["preferred_genres"] == ["rock"]
        assert response.json()["preferred_artists"] == ["Radiohead"]
    db.expire_all()
    assert alice.player_setup_completed is True
    assert bob.player_setup_completed is False
    assert client.get("/api/auth/me", headers=headers).json()["player_setup_completed"] is True


def test_player_setup_requires_authentication(client):
    assert client.post("/api/users/me/player-setup/complete").status_code == 401


def migration():
    path = Path(__file__).resolve().parents[1] / "alembic/versions/0038_player_setup.py"
    spec = importlib.util.spec_from_file_location("player_setup_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_migration_keeps_existing_listeners_out_of_first_setup_and_new_accounts_pending():
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(sa.text("CREATE TABLE users (id INTEGER PRIMARY KEY, onboarding_completed BOOLEAN NOT NULL)"))
        connection.execute(sa.text("INSERT INTO users VALUES (1, true), (2, false)"))
        with Operations.context(MigrationContext.configure(connection)):
            migration().upgrade()
            connection.execute(sa.text("INSERT INTO users (id, onboarding_completed) VALUES (3, true)"))
            migration().upgrade()
            rows = connection.execute(sa.text("SELECT id, player_setup_completed FROM users ORDER BY id")).all()
            assert rows == [(1, True), (2, False), (3, False)]
            migration().downgrade()
            assert "player_setup_completed" not in {col["name"] for col in sa.inspect(connection).get_columns("users")}
    engine.dispose()


def test_migration_preserves_pending_setup_when_debug_create_all_already_added_the_column():
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(sa.text("CREATE TABLE users (id INTEGER PRIMARY KEY, onboarding_completed BOOLEAN NOT NULL, player_setup_completed BOOLEAN NOT NULL DEFAULT false)"))
        connection.execute(sa.text("INSERT INTO users (id, onboarding_completed) VALUES (1, true)"))
        with Operations.context(MigrationContext.configure(connection)):
            migration().upgrade()
        assert not connection.execute(sa.text("SELECT player_setup_completed FROM users")).scalar_one()
    engine.dispose()
