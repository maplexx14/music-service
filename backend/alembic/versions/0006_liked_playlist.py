"""Понравившиеся как обычный плейлист, свой для каждого юзера

Раньше лайки жили в отдельной таблице user_liked_tracks, отдельно от Playlist.
Теперь у каждого юзера есть скрытый (is_liked=true) Playlist, а треки лежат
в playlist_tracks — единая модель для лайков и обычных плейлистов.

Revision ID: 0006
Revises: 0005
Create Date: 2026-07-10

"""
from alembic import op
import sqlalchemy as sa

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Check if column already exists (idempotent)
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = [col['name'] for col in inspector.get_columns('playlists')]

    if 'is_liked' not in columns:
        op.add_column(
            "playlists",
            sa.Column("is_liked", sa.Boolean(), nullable=False, server_default="false"),
        )
        op.create_index("ix_playlists_is_liked", "playlists", ["is_liked"])

    bind = op.get_bind()
    metadata = sa.MetaData()
    playlists = sa.Table("playlists", metadata, autoload_with=bind)
    playlist_tracks = sa.Table("playlist_tracks", metadata, autoload_with=bind)
    user_liked_tracks = sa.Table("user_liked_tracks", metadata, autoload_with=bind)

    user_ids = [
        row[0]
        for row in bind.execute(
            sa.select(user_liked_tracks.c.user_id).distinct()
        )
    ]

    for user_id in user_ids:
        existing = bind.execute(
            sa.select(playlists.c.id).where(
                playlists.c.owner_id == user_id, playlists.c.is_liked == True
            )
        ).first()
        if existing:
            playlist_id = existing[0]
        else:
            result = bind.execute(
                playlists.insert().values(
                    name="Понравившиеся",
                    is_public=False,
                    is_liked=True,
                    owner_id=user_id,
                ).returning(playlists.c.id)
            )
            playlist_id = result.scalar()

        liked_rows = bind.execute(
            sa.select(user_liked_tracks.c.track_id, user_liked_tracks.c.liked_at)
            .where(user_liked_tracks.c.user_id == user_id)
            .order_by(user_liked_tracks.c.liked_at.asc())
        ).all()

        for position, (track_id, liked_at) in enumerate(liked_rows):
            already = bind.execute(
                sa.select(playlist_tracks.c.track_id).where(
                    playlist_tracks.c.playlist_id == playlist_id,
                    playlist_tracks.c.track_id == track_id,
                )
            ).first()
            if already:
                continue
            bind.execute(
                playlist_tracks.insert().values(
                    playlist_id=playlist_id,
                    track_id=track_id,
                    position=position,
                    added_at=liked_at,
                )
            )


def downgrade() -> None:
    op.drop_index("ix_playlists_is_liked", table_name="playlists")
    op.drop_column("playlists", "is_liked")