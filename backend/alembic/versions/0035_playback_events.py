"""Persistent playback diagnostics, independent of listening history.

Revision ID: 0035_playback_events
Revises: 0034_user_flow_tuning
"""

import sqlalchemy as sa
from alembic import op


revision = "0035_playback_events"
down_revision = "0034_user_flow_tuning"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # DEBUG installs the same schema through Base.metadata.create_all.
    if sa.inspect(op.get_bind()).has_table("playback_events"):
        return
    op.create_table(
        "playback_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("event_type", sa.String(32), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("metadata", sa.JSON(), nullable=False),
    )
    op.create_index("ix_playback_events_user_time", "playback_events", ["user_id", "occurred_at"])


def downgrade() -> None:
    op.drop_index("ix_playback_events_user_time", table_name="playback_events")
    op.drop_table("playback_events")
