"""Add users.is_admin

Revision ID: 0002
Revises: 0001
Create Date: 2026-07-03

"""
from alembic import op
import sqlalchemy as sa

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    cols = [c["name"] for c in sa.inspect(bind).get_columns("users")]
    if "is_admin" not in cols:
        op.add_column(
            "users",
            sa.Column("is_admin", sa.Boolean(), nullable=False, server_default=sa.false()),
        )


def downgrade() -> None:
    op.drop_column("users", "is_admin")
