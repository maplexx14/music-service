"""Treat imported playlist tracks as completed listens.

Revision ID: 0019_imported_playlist_plays
Revises: 0018_rec_quality_indexes
"""

from collections import Counter

from alembic import op
import sqlalchemy as sa


revision = "0019_imported_playlist_plays"
down_revision = "0018_rec_quality_indexes"
branch_labels = None
depends_on = None


def _chunks(values, size=400):
    for offset in range(0, len(values), size):
        yield values[offset : offset + size]


def upgrade():
    bind = op.get_bind()
    metadata = sa.MetaData()
    playlists = sa.Table("playlists", metadata, autoload_with=bind)
    playlist_tracks = sa.Table("playlist_tracks", metadata, autoload_with=bind)
    user_track_plays = sa.Table("user_track_plays", metadata, autoload_with=bind)
    user_play_events = sa.Table("user_play_events", metadata, autoload_with=bind)
    tracks = sa.Table("tracks", metadata, autoload_with=bind)

    imported_rows = bind.execute(
        sa.select(
            playlists.c.owner_id,
            playlist_tracks.c.track_id,
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
            playlists.c.description.like("Импортировано из %"),
        )
        .group_by(playlists.c.owner_id, playlist_tracks.c.track_id)
    ).all()
    if not imported_rows:
        return

    pairs = [(row.owner_id, row.track_id) for row in imported_rows]
    existing_pairs = set()
    for chunk in _chunks(pairs):
        existing_pairs.update(
            tuple(row)
            for row in bind.execute(
                sa.select(user_track_plays.c.user_id, user_track_plays.c.track_id).where(
                    sa.tuple_(
                        user_track_plays.c.user_id,
                        user_track_plays.c.track_id,
                    ).in_(chunk)
                )
            ).all()
        )

    new_rows = [
        row for row in imported_rows if (row.owner_id, row.track_id) not in existing_pairs
    ]
    if not new_rows:
        return

    bind.execute(
        user_track_plays.insert(),
        [
            {
                "user_id": row.owner_id,
                "track_id": row.track_id,
                "play_count": 1,
                "last_played": row.added_at,
            }
            for row in new_rows
        ],
    )
    bind.execute(
        user_play_events.insert(),
        [
            {
                "user_id": row.owner_id,
                "track_id": row.track_id,
                "played_at": row.added_at,
                "completion": 1.0,
                "client_hour": None,
            }
            for row in new_rows
        ],
    )

    new_listeners_by_track = Counter(row.track_id for row in new_rows)
    for track_id, count in new_listeners_by_track.items():
        bind.execute(
            tracks.update()
            .where(tracks.c.id == track_id)
            .values(
                play_count=tracks.c.play_count + count,
                unique_listener_count=tracks.c.unique_listener_count + count,
            )
        )


def downgrade():
    # The backfilled rows are intentionally indistinguishable from normal
    # listening history. Removing them could erase genuine user plays that
    # happened after this migration, so the data migration is irreversible.
    pass
