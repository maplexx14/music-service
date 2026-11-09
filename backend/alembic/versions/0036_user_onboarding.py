"""Remember completed or skipped onboarding across browsers.

Revision ID: 0036_user_onboarding
Revises: 0035_playback_events
"""

import sqlalchemy as sa
from alembic import op


revision = "0036_user_onboarding"
down_revision = "0035_playback_events"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # DEBUG and the initial migration also create columns from the ORM model.
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("users")}
    if "onboarding_completed" in columns:
        return
    op.add_column(
        "users",
        sa.Column("onboarding_completed", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    # Previously, skipping was recorded only in the browser. We cannot recover
    # that choice, so do not prompt existing verified accounts again. Future
    # registrations (and accounts still awaiting verification) start at false.
    op.execute("UPDATE users SET onboarding_completed = true WHERE email_verified = true")


def downgrade() -> None:
    op.drop_column("users", "onboarding_completed")
