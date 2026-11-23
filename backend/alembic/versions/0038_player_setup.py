"""Remember the player unboxing after music onboarding.

Revision ID: 0038_player_setup
Revises: 0037_uuid_identifiers
"""

import sqlalchemy as sa
from alembic import op

revision = "0038_player_setup"
down_revision = "0037_uuid_identifiers"
branch_labels = None
depends_on = None


def upgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("users")}
    if "player_setup_completed" in columns:
        return
    op.add_column(
        "users",
        sa.Column("player_setup_completed", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    # Existing listeners already use their player; first-time setup is for new
    # accounts and people who have not yet finished their musical onboarding.
    op.execute("UPDATE users SET player_setup_completed = true WHERE onboarding_completed = true")


def downgrade() -> None:
    op.drop_column("users", "player_setup_completed")
