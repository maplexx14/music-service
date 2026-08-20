"""recommendation population and co-occurrence confidence

Revision ID: 0017_recommendation_population
Revises: 0016_recommendation_telemetry
"""

from alembic import op
import sqlalchemy as sa


revision = "0017_recommendation_population"
down_revision = "0016_recommendation_telemetry"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    track_columns = {column["name"] for column in inspector.get_columns("tracks")}
    if "unique_listener_count" not in track_columns:
        op.add_column(
            "tracks",
            sa.Column(
                "unique_listener_count",
                sa.Integer(),
                nullable=False,
                server_default="0",
            ),
        )
        op.create_index(
            "ix_tracks_unique_listener_count",
            "tracks",
            ["unique_listener_count"],
        )

    op.execute(
        sa.text(
            """
            UPDATE tracks
            SET unique_listener_count = (
                SELECT COUNT(*)
                FROM user_track_plays
                WHERE user_track_plays.track_id = tracks.id
            )
            """
        )
    )

    cooccurrence_columns = {
        column["name"] for column in inspector.get_columns("track_cooccurrence")
    }
    if "common_users" not in cooccurrence_columns:
        op.add_column(
            "track_cooccurrence",
            sa.Column("common_users", sa.Integer(), nullable=False, server_default="0"),
        )


def downgrade():
    op.drop_column("track_cooccurrence", "common_users")
    op.drop_index("ix_tracks_unique_listener_count", table_name="tracks")
    op.drop_column("tracks", "unique_listener_count")
