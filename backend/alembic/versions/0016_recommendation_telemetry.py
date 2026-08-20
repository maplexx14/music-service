"""recommendation delivery and feedback telemetry

Revision ID: 0016_recommendation_telemetry
Revises: 0015
"""

from alembic import op
import sqlalchemy as sa

revision = "0016_recommendation_telemetry"
down_revision = "0015"
branch_labels = None
depends_on = None


def upgrade():
    existing = set(sa.inspect(op.get_bind()).get_table_names())
    if "recommendation_impressions" not in existing:
        op.create_table(
            "recommendation_impressions",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("track_id", sa.Integer(), sa.ForeignKey("tracks.id", ondelete="SET NULL"), nullable=True),
            sa.Column("source", sa.String(), nullable=True),
            sa.Column("external_id", sa.String(), nullable=True),
            sa.Column("title", sa.String(), nullable=True),
            sa.Column("artist", sa.String(), nullable=True),
            sa.Column("surface", sa.String(), nullable=False, server_default="library"),
            sa.Column("position", sa.Integer(), nullable=False),
            sa.Column("score", sa.Float(), nullable=True),
            sa.Column("algorithm_version", sa.String(), nullable=False, server_default="hybrid-v4"),
            sa.Column("request_id", sa.String(), nullable=True),
            sa.Column("session_id", sa.String(), nullable=True),
            sa.Column("shown_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.Column("visible", sa.Boolean(), nullable=False, server_default=sa.false()),
        )
        op.create_index("ix_recommendation_impressions_user_id", "recommendation_impressions", ["user_id"])
        op.create_index("ix_recommendation_impressions_track_id", "recommendation_impressions", ["track_id"])
        op.create_index("ix_recommendation_impressions_request_id", "recommendation_impressions", ["request_id"])
        op.create_index("ix_recommendation_impressions_session_id", "recommendation_impressions", ["session_id"])
        op.create_index("ix_recommendation_impressions_shown_at", "recommendation_impressions", ["shown_at"])

    if "recommendation_events" not in existing:
        op.create_table(
            "recommendation_events",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("track_id", sa.Integer(), sa.ForeignKey("tracks.id", ondelete="SET NULL"), nullable=True),
            sa.Column("source", sa.String(), nullable=True),
            sa.Column("external_id", sa.String(), nullable=True),
            sa.Column("title", sa.String(), nullable=True),
            sa.Column("artist", sa.String(), nullable=True),
            sa.Column("event_type", sa.String(), nullable=False),
            sa.Column("value", sa.Float(), nullable=True),
            sa.Column("surface", sa.String(), nullable=True),
            sa.Column("position", sa.Integer(), nullable=True),
            sa.Column("algorithm_version", sa.String(), nullable=False, server_default="hybrid-v4"),
            sa.Column("request_id", sa.String(), nullable=True),
            sa.Column("client_hour", sa.Integer(), nullable=True),
            sa.Column("metadata", sa.JSON(), nullable=True),
            sa.Column("occurred_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        )
        op.create_index("ix_recommendation_events_user_id", "recommendation_events", ["user_id"])
        op.create_index("ix_recommendation_events_track_id", "recommendation_events", ["track_id"])
        op.create_index("ix_recommendation_events_event_type", "recommendation_events", ["event_type"])
        op.create_index("ix_recommendation_events_request_id", "recommendation_events", ["request_id"])
        op.create_index("ix_recommendation_events_occurred_at", "recommendation_events", ["occurred_at"])


def downgrade():
    op.drop_table("recommendation_events")
    op.drop_table("recommendation_impressions")
