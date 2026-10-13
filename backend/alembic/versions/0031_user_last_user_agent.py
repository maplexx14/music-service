"""users.last_user_agent: последнее устройство для админки

Revision ID: 0031_user_last_user_agent
Revises: 0030_developer_messages
"""

import sqlalchemy as sa
from alembic import op


revision = "0031_user_last_user_agent"
down_revision = "0030_developer_messages"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Колонка уже есть, если БД поднималась через create_all (DEBUG).
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("users")}
    if "last_user_agent" in columns:
        return
    op.add_column("users", sa.Column("last_user_agent", sa.String(512), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "last_user_agent")
