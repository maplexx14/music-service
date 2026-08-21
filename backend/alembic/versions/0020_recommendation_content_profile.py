"""Store acoustic content profiles and playlist provenance.

Revision ID: 0020_content_profile
Revises: 0019_imported_playlist_plays
"""

from collections import Counter

from alembic import op
import sqlalchemy as sa


revision = "0020_content_profile"
down_revision = "0019_imported_playlist_plays"
branch_labels = None
depends_on = None


_IMPORTED_DESCRIPTION_MARKERS = (
    "Импортировано из %",
    "Ð˜Ð¼Ð¿Ð¾Ñ€Ñ‚Ð¸Ñ€Ð¾Ð²Ð°Ð½Ð¾ Ð¸Ð· %",
    "Imported from %",
)


def _chunks(values, size=400):
    for offset in range(0, len(values), size):
        yield values[offset : offset + size]


def _remove_synthetic_import_plays(bind):
    """Undo only rows that migration 0019 can identify unambiguously.

    Real later plays change either the aggregate count or its timestamp and are
    therefore preserved.  The matching completion event is required as an
    additional guard before global counters are decremented.
    """
    metadata = sa.MetaData()
    playlists = sa.Table("playlists", metadata, autoload_with=bind)
    playlist_tracks = sa.Table("playlist_tracks", metadata, autoload_with=bind)
    user_track_plays = sa.Table("user_track_plays", metadata, autoload_with=bind)
    user_play_events = sa.Table("user_play_events", metadata, autoload_with=bind)
    tracks = sa.Table("tracks", metadata, autoload_with=bind)

    imported = (
        sa.select(
            playlists.c.owner_id.label("user_id"),
            playlist_tracks.c.track_id.label("track_id"),
            sa.func.max(playlist_tracks.c.added_at).label("added_at"),
        )
        .select_from(
            playlists.join(
                playlist_tracks,
                playlist_tracks.c.playlist_id == playlists.c.id,
            )
        )
        .where(
            playlists.c.is_liked.is_(False),
            sa.or_(
                playlists.c.origin == "imported",
                *(
                    playlists.c.description.like(marker)
                    for marker in _IMPORTED_DESCRIPTION_MARKERS
                ),
            ),
        )
        .group_by(playlists.c.owner_id, playlist_tracks.c.track_id)
        .subquery()
    )

    rows = bind.execute(
        sa.select(
            imported.c.user_id,
            imported.c.track_id,
            user_play_events.c.id.label("event_id"),
        )
        .select_from(
            imported.join(
                user_track_plays,
                sa.and_(
                    user_track_plays.c.user_id == imported.c.user_id,
                    user_track_plays.c.track_id == imported.c.track_id,
                ),
            ).join(
                user_play_events,
                sa.and_(
                    user_play_events.c.user_id == imported.c.user_id,
                    user_play_events.c.track_id == imported.c.track_id,
                ),
            )
        )
        .where(
            user_track_plays.c.play_count == 1,
            user_track_plays.c.last_played == imported.c.added_at,
            user_play_events.c.played_at == imported.c.added_at,
            user_play_events.c.completion == 1.0,
            user_play_events.c.client_hour.is_(None),
        )
    ).all()
    if not rows:
        return

    event_ids = sorted({row.event_id for row in rows})
    pairs = sorted({(row.user_id, row.track_id) for row in rows})
    for chunk in _chunks(event_ids):
        bind.execute(
            user_play_events.delete().where(user_play_events.c.id.in_(chunk))
        )
    for chunk in _chunks(pairs):
        bind.execute(
            user_track_plays.delete().where(
                sa.tuple_(
                    user_track_plays.c.user_id,
                    user_track_plays.c.track_id,
                ).in_(chunk)
            )
        )

    removed_by_track = Counter(track_id for _user_id, track_id in pairs)
    for track_id, count in removed_by_track.items():
        play_count = sa.func.coalesce(tracks.c.play_count, 0)
        listener_count = sa.func.coalesce(tracks.c.unique_listener_count, 0)
        bind.execute(
            tracks.update()
            .where(tracks.c.id == track_id)
            .values(
                play_count=sa.case(
                    (play_count >= count, play_count - count), else_=0
                ),
                unique_listener_count=sa.case(
                    (listener_count >= count, listener_count - count), else_=0
                ),
            )
        )


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    track_columns = {column["name"] for column in inspector.get_columns("tracks")}
    additions = (
        ("acoustic_features", sa.JSON()),
        ("acoustic_analyzed_at", sa.DateTime(timezone=True)),
        ("acoustic_analyzer_version", sa.String(length=32)),
    )
    for name, column in additions:
        if name not in track_columns:
            op.add_column("tracks", sa.Column(name, column, nullable=True))

    playlist_columns = {
        column["name"] for column in inspector.get_columns("playlists")
    }
    if "origin" not in playlist_columns:
        op.add_column(
            "playlists",
            sa.Column(
                "origin",
                sa.String(length=16),
                nullable=False,
                server_default="manual",
            ),
        )

    existing_indexes = {
        index["name"] for index in inspector.get_indexes("tracks")
    }
    if "ix_tracks_acoustic_analyzer_version" not in existing_indexes:
        op.create_index(
            "ix_tracks_acoustic_analyzer_version",
            "tracks",
            ["acoustic_analyzer_version"],
        )

    existing_indexes = {
        index["name"] for index in inspector.get_indexes("playlists")
    }
    if "ix_playlists_origin" not in existing_indexes:
        op.create_index("ix_playlists_origin", "playlists", ["origin"])

    # Older imports only carried a human-readable description. Match both
    # valid UTF-8 and the mojibake value produced by some older deployments.
    for marker in _IMPORTED_DESCRIPTION_MARKERS:
        op.execute(
            sa.text(
                "UPDATE playlists SET origin = 'imported' "
                "WHERE origin = 'manual' AND description LIKE :marker"
            ).bindparams(marker=marker)
        )

    # The preceding migration treated imported collection membership as a
    # completed listen.  Playlist curation is now a separate, lower-confidence
    # signal, so remove only the rows that still exactly match that backfill.
    _remove_synthetic_import_plays(bind)


def downgrade():
    op.drop_index("ix_playlists_origin", table_name="playlists")
    op.drop_index("ix_tracks_acoustic_analyzer_version", table_name="tracks")
    op.drop_column("playlists", "origin")
    op.drop_column("tracks", "acoustic_analyzer_version")
    op.drop_column("tracks", "acoustic_analyzed_at")
    op.drop_column("tracks", "acoustic_features")
