"""Exercise the data migration against PostgreSQL, including existing relations."""

import importlib.util
import os
from pathlib import Path
from uuid import UUID, uuid4

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

from app.database import Base
from app.cooccurrence import pair_scores, similar_track_ids


_path = Path(__file__).parents[1] / "alembic/versions/0037_uuid_identifiers.py"
_spec = importlib.util.spec_from_file_location("uuid_migration", _path)
migration = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(migration)


@pytest.fixture
def postgres():
    url = os.getenv("UUID_MIGRATION_TEST_DATABASE_URL")
    if not url:
        pytest.skip("UUID_MIGRATION_TEST_DATABASE_URL is required for PostgreSQL migration tests")
    engine = sa.create_engine(url)
    schema = f"uuid_test_{uuid4().hex}"
    with engine.connect() as connection:
        connection.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
        connection.execute(sa.text(f'SET search_path TO "{schema}"'))
        connection.commit()
        try:
            yield connection
        finally:
            connection.rollback()
            connection.execute(sa.text("SET search_path TO public"))
            connection.execute(sa.text(f'DROP SCHEMA "{schema}" CASCADE'))
            connection.commit()
    engine.dispose()


def _upgrade(connection):
    with Operations.context(MigrationContext.configure(connection)):
        migration.upgrade()


def _legacy_metadata():
    metadata = sa.MetaData()
    for table in Base.metadata.sorted_tables:
        table.to_metadata(metadata)
    for table in metadata.tables.values():
        for column in table.c:
            if isinstance(column.type, sa.Uuid):
                column.type = sa.Integer()
                column.default = None
                column.server_default = None
    return metadata


def _seed_legacy(connection, metadata):
    def insert(table, **values):
        connection.execute(metadata.tables[table].insert().values(**values))

    insert("users", id=1, username="owner", email="owner@example.com", hashed_password="hash")
    insert("users", id=2, username="other", email="other@example.com", hashed_password="hash")
    for track_id in (10, 11):
        insert("tracks", id=track_id, title=f"Track {track_id}", artist="Artist", duration=180,
               source="soundcloud", external_id=str(track_id), play_count=10)
    insert("playlists", id=20, owner_id=1, name="Liked", is_liked=True, is_public=False)
    # Legacy likes with tied positions/timestamps relied on their integer IDs.
    for track_id in (10, 11):
        insert("playlist_tracks", playlist_id=20, track_id=track_id, position=0)
    insert("user_liked_tracks", user_id=1, track_id=10)
    insert("user_track_plays", user_id=1, track_id=10, play_count=7)
    insert("user_track_skips", user_id=1, track_id=11, skip_count=2, disliked=True)
    insert("user_play_events", id=30, user_id=1, track_id=10, completion=0.75)
    insert("playback_events", id=31, user_id=1, event_type="play_click",
           metadata={"track_id": "10", "position": 10, "context": {"path": "/playlists/20"}})
    insert("rec_impressions", user_id=1, track_id=10, shown_count=3)
    insert("recommendation_impressions", id=32, user_id=1, track_id=10, position=1,
           source="soundcloud", external_id="10", features={"identity": "local:10", "score": 10})
    insert("recommendation_events", id=33, user_id=1, track_id=10, event_type="like",
           metadata={"track_id": 10, "external_id": "10"})
    insert("recommendation_events", id=34, user_id=2, track_id=None, event_type="skip",
           source="soundcloud", external_id="10")
    insert("track_cooccurrence", track_id=10, other_track_id=11, score=0.7, common_users=4)
    insert("user_trusted_devices", id=35, user_id=1, token_hash="device-hash", label="Phone")
    insert("push_subscriptions", id=36, user_id=1, endpoint="https://example.com/push",
           p256dh="key", auth="auth")
    insert("censor_overrides", id=37, created_by=1, source="ytmusic", external_id="10",
           censored_title="Edited", censored_artist="Artist", censored_key="artist|edited",
           original_id="11", original_permalink="https://soundcloud.com/artist/original",
           original_title="Original", original_artist="Artist")
    insert("developer_messages", id=38, user_id=1, message="Feedback",
           context={"pathname": "/track/10", "userId": 1})
    insert("service_ratings", id=39, user_id=1, score=5, comment="Great")
    insert("user_player_states", user_id=1, saved_at=100,
           state={"userId": 1, "currentIndex": 0, "position": 10,
                  "queue": [{"id": 10, "title": "Track 10", "artist": "Artist"},
                            {"id": "soundcloud:11", "db_id": 11, "external_id": "11"}],
                  "playContext": {"path": "/playlists/20"},
                  "queuePager": {"url": "/playlists/20", "total": 10}})
    insert("app_secrets", name="test-key", value="unchanged")


def test_existing_data_relations_and_player_snapshot_survive(postgres):
    legacy = _legacy_metadata()
    with postgres.begin():
        legacy.create_all(postgres)
        _seed_legacy(postgres, legacy)
        counts = {name: postgres.scalar(sa.select(sa.func.count()).select_from(table))
                  for name, table in legacy.tables.items()}
        _upgrade(postgres)

        tables = Base.metadata.tables
        user_id = postgres.scalar(sa.select(tables["users"].c.id).where(tables["users"].c.username == "owner"))
        tracks = dict(postgres.execute(sa.select(tables["tracks"].c.external_id, tables["tracks"].c.id)).all())
        playlist_id = postgres.scalar(sa.select(tables["playlists"].c.id))
        assert UUID(user_id).version == UUID(playlist_id).version == 4
        for name, table in tables.items():
            assert postgres.scalar(sa.select(sa.func.count()).select_from(table)) == counts[name]
            columns = {c["name"]: c for c in sa.inspect(postgres).get_columns(name)}
            for column in table.c:
                if isinstance(column.type, sa.Uuid):
                    assert isinstance(columns[column.name]["type"], sa.Uuid), (name, column.name)
        members = postgres.execute(sa.select(tables["playlist_tracks"]).order_by(
            tables["playlist_tracks"].c.position)).mappings().all()
        assert [(row["playlist_id"], row["track_id"]) for row in members] == [
            (playlist_id, tracks["10"]), (playlist_id, tracks["11"])]
        assert postgres.scalar(sa.select(tables["user_track_plays"].c.play_count)) == 7
        pair = postgres.execute(sa.select(tables["track_cooccurrence"])).mappings().one()
        assert (pair["track_id"], pair["other_track_id"], pair["common_users"]) == (tracks["10"], tracks["11"], 4)
        assert similar_track_ids(postgres, [tracks["10"]]) == [(tracks["11"], 0.7)]
        assert pair_scores(postgres, list(tracks.values())) == {
            (tracks["10"], tracks["11"]): 1.0, (tracks["11"], tracks["10"]): 1.0,
        }
        state_row = postgres.execute(sa.select(tables["user_player_states"])).mappings().one()
        state = state_row["state"]
        assert state_row["user_id"] == state["userId"] == user_id
        assert state["queue"][0]["id"] == tracks["10"]
        assert state["queue"][1] == {"id": "soundcloud:11", "db_id": tracks["11"], "external_id": "11"}
        assert state["playContext"]["path"] == state["queuePager"]["url"] == f"/playlists/{playlist_id}"
        assert state["position"] == state["queuePager"]["total"] == 10
        click = postgres.scalar(sa.select(tables["playback_events"].c.metadata))
        assert click == {"track_id": tracks["10"], "position": 10, "context": {"path": f"/playlists/{playlist_id}"}}
        impression = postgres.execute(sa.select(tables["recommendation_impressions"])).mappings().one()
        assert impression["track_id"] == tracks["10"]
        assert impression["external_id"] == "10"
        assert impression["features"] == {"identity": f"local:{tracks['10']}", "score": 10}
        assert postgres.scalar(sa.select(tables["censor_overrides"].c.created_by)) == user_id
        assert postgres.scalar(sa.select(tables["censor_overrides"].c.original_id)) == "11"
        assert postgres.scalar(sa.select(tables["app_secrets"].c.value)) == "unchanged"

        # Direct SQL must generate UUIDs too, without SQLAlchemy's Python default.
        generated = postgres.scalar(sa.text(
            "INSERT INTO users (username, email, hashed_password) "
            "VALUES ('new', 'new@example.com', 'hash') RETURNING id"
        ))
        assert generated.version == 4
        assert postgres.scalar(sa.text("SELECT count(*) FROM pg_sequences WHERE schemaname = current_schema()")) == 0
        # FK actions and unique constraints still work after ALTER TYPE.
        with pytest.raises(sa.exc.IntegrityError), postgres.begin_nested():
            postgres.execute(tables["user_track_plays"].insert().values(user_id=str(uuid4()), track_id=tracks["10"]))
        with pytest.raises(sa.exc.IntegrityError), postgres.begin_nested():
            postgres.execute(tables["playlists"].insert().values(owner_id=user_id, name="duplicate", is_liked=True))
        other_id = postgres.scalar(sa.select(tables["users"].c.id).where(tables["users"].c.username == "other"))
        postgres.execute(tables["users"].delete().where(tables["users"].c.id == other_id))
        assert postgres.scalar(sa.select(sa.func.count()).select_from(tables["recommendation_events"])) == 1
        _upgrade(postgres)  # Safe on an already converted schema.


def test_fresh_uuid_schema_is_unchanged(postgres):
    with postgres.begin():
        Base.metadata.create_all(postgres)
        users = Base.metadata.tables["users"]
        before = postgres.execute(users.insert().values(
            username="fresh", email="fresh@example.com", hashed_password="hash"
        ).returning(users.c.id)).scalar_one()
        _upgrade(postgres)
        assert postgres.scalar(sa.select(users.c.id)) == before
