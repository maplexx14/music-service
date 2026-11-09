"""Replace integer primary and foreign keys with UUID v4 identifiers.

Existing relationships and IDs embedded in player snapshots/telemetry are
remapped in the same transaction. Run with application writers stopped; table
locks also prevent writes from racing the ID mapping. Fresh installations
already have UUID columns because the initial migration uses model metadata.

This migration is intentionally one-way: restoring integer IDs requires the
pre-migration database backup, since the temporary mapping is not retained.
"""

import re

from alembic import op
import sqlalchemy as sa


revision = "0037_uuid_identifiers"
down_revision = "0036_user_onboarding"
branch_labels = None
depends_on = None


_ID_TABLES = (
    "users", "tracks", "playlists", "censor_overrides", "developer_messages",
    "service_ratings", "user_play_events", "playback_events",
    "recommendation_impressions", "recommendation_events",
    "user_trusted_devices", "push_subscriptions",
)
_JSON_COLUMNS = (
    ("user_player_states", "user_id", "state"),
    ("playback_events", "id", "metadata"),
    ("recommendation_events", "id", "metadata"),
    ("recommendation_impressions", "id", "features"),
    ("developer_messages", "id", "context"),
)
_ID_FIELDS = {
    "userId": "users", "user_id": "users", "owner_id": "users",
    "trackId": "tracks", "track_id": "tracks", "db_id": "tracks",
    "track_ids": "tracks", "playlistId": "playlists", "playlist_id": "playlists",
    "playlist_ids": "playlists",
}
_PATH = re.compile(r"(^/(?:api/)?|/api/)(tracks|track|playlists)/(\d+)(?=[/?#]|$)")


def _rewrite_json(value, mappings, field=""):
    """Only rewrite local references; provider IDs and numeric metrics stay intact."""
    if isinstance(value, dict):
        is_track = field in {"queue", "currentTrack", "track"} or (
            "title" in value and "artist" in value
        )
        return {
            key: _rewrite_json(item, mappings, "track_id" if key == "id" and is_track else key)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_rewrite_json(item, mappings, field) for item in value]
    table = _ID_FIELDS.get(field)
    if table and isinstance(value, (int, str)) and not isinstance(value, bool):
        return mappings.get(table, {}).get(str(value), value)
    if isinstance(value, str):
        if field in {"identity", "ids", "track_key", "track_keys"} and value.startswith(("local:", "db:")):
            prefix, old_id = value.split(":", 1)
            new_id = mappings.get("tracks", {}).get(old_id)
            if new_id:
                return f"{prefix}:{new_id}"
        if field in {"path", "pathname", "url", "href", "stream_url"}:
            def replace(match):
                table = "playlists" if match[2] == "playlists" else "tracks"
                new_id = mappings.get(table, {}).get(match[3], match[3])
                return f"{match[1]}{match[2]}/{new_id}"
            return _PATH.sub(replace, value)
    return value


def _rewrite_snapshots(bind, existing):
    mappings = {}
    for table, old_id, new_id in bind.execute(sa.text(
        "SELECT table_name, old_id, new_id::text FROM _uuid_id_map "
        "WHERE table_name IN ('users', 'tracks', 'playlists')"
    )):
        mappings.setdefault(table, {})[str(old_id)] = new_id
    for name, key, column in _JSON_COLUMNS:
        if name not in existing:
            continue
        table = sa.table(name, sa.column(key, sa.Uuid(as_uuid=False)), sa.column(column, sa.JSON()))
        rows = bind.execute(
            sa.select(table.c[key], table.c[column])
            .where(table.c[column].is_not(None))
            .execution_options(stream_results=True)
        )
        statement = table.update().where(table.c[key] == sa.bindparam("_row_id")).values(
            {column: sa.bindparam("_payload")}
        )
        while batch := rows.fetchmany(500):
            updates = []
            for row_id, payload in batch:
                rewritten = _rewrite_json(payload, mappings)
                if rewritten != payload:
                    updates.append({"_row_id": row_id, "_payload": rewritten})
            if updates:
                bind.execute(statement, updates)
        rows.close()


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = set(inspector.get_table_names())
    roots = {
        name for name in _ID_TABLES if name in existing
        and any(c["name"] == "id" and isinstance(c["type"], sa.Integer)
                for c in inspector.get_columns(name))
    }
    if not roots:
        return
    if bind.dialect.name != "postgresql":
        raise RuntimeError("Migrating existing integer IDs requires PostgreSQL")

    columns = {name: {"id": name} for name in roots}
    foreign_keys = []
    for name in sorted(existing):
        for fk in inspector.get_foreign_keys(name):
            if fk["referred_table"] in roots and fk["referred_columns"] == ["id"]:
                columns.setdefault(name, {})[fk["constrained_columns"][0]] = fk["referred_table"]
                foreign_keys.append((name, fk))

    quote = bind.dialect.identifier_preparer.quote
    # Lock before constructing mappings, including snapshots without foreign
    # references to tracks/playlists. PostgreSQL releases these at commit.
    locked = set(columns) | {name for name, _, _ in _JSON_COLUMNS if name in existing}
    op.execute("LOCK TABLE " + ", ".join(quote(name) for name in sorted(locked))
               + " IN ACCESS EXCLUSIVE MODE")
    # Older likes could share position=0 and relied on the increasing track ID
    # to break timestamp ties. Preserve that order before randomizing the IDs.
    if "tracks" in roots and {"playlist_tracks", "playlists"} <= existing:
        op.execute("""
            WITH positions AS (
                SELECT pt.playlist_id, pt.track_id,
                       row_number() OVER (
                           PARTITION BY pt.playlist_id
                           ORDER BY pt.position, pt.added_at, pt.track_id
                       ) - 1 AS position
                FROM playlist_tracks pt JOIN playlists p ON p.id = pt.playlist_id
                WHERE p.is_liked IS TRUE
            )
            UPDATE playlist_tracks pt SET position = positions.position
            FROM positions
            WHERE pt.playlist_id = positions.playlist_id AND pt.track_id = positions.track_id
        """)
    op.execute("""
        CREATE TEMPORARY TABLE _uuid_id_map (
            table_name text NOT NULL,
            old_id bigint NOT NULL,
            new_id uuid NOT NULL DEFAULT gen_random_uuid(),
            PRIMARY KEY (table_name, old_id)
        ) ON COMMIT DROP
    """)
    for name in sorted(roots):
        bind.execute(sa.text(
            f"INSERT INTO _uuid_id_map (table_name, old_id) SELECT :name, id FROM {quote(name)}"
        ), {"name": name})
    op.execute("""
        CREATE FUNCTION pg_temp._mapped_uuid(entity text, previous_id bigint)
        RETURNS uuid LANGUAGE sql STABLE STRICT AS $$
            SELECT new_id FROM _uuid_id_map
            WHERE table_name = entity AND old_id = previous_id
        $$
    """)

    sequences = []
    for name in sorted(roots):
        sequence = bind.execute(sa.text("SELECT pg_get_serial_sequence(:name, 'id')"),
                                {"name": name}).scalar()
        if sequence:
            sequences.append(sequence)
    for name, fk in foreign_keys:
        op.drop_constraint(fk["name"], name, type_="foreignkey")
    for name, fields in sorted(columns.items()):
        changes = []
        for column, entity in fields.items():
            changes.append(f"ALTER COLUMN {quote(column)} DROP DEFAULT")
            changes.append(
                f"ALTER COLUMN {quote(column)} TYPE uuid "
                f"USING pg_temp._mapped_uuid('{entity}', {quote(column)})"
            )
            if column == "id":
                changes.append(f"ALTER COLUMN {quote(column)} SET DEFAULT gen_random_uuid()")
        op.execute(f"ALTER TABLE {quote(name)} " + ", ".join(changes))
    for name, fk in foreign_keys:
        op.create_foreign_key(
            fk["name"], name, fk["referred_table"],
            fk["constrained_columns"], fk["referred_columns"],
            referent_schema=fk.get("referred_schema"), **fk.get("options", {}),
        )
    _rewrite_snapshots(bind, existing)
    # Sequence names come from PostgreSQL's already-quoted regclass output.
    for sequence in sequences:
        op.execute(f"DROP SEQUENCE {sequence}")
    op.execute("DROP FUNCTION pg_temp._mapped_uuid(text, bigint)")


def downgrade() -> None:
    raise RuntimeError("UUID migration is one-way; restore the pre-migration backup to recover integer IDs")
