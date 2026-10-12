"""developer_messages: сообщения разработчику из настроек

Revision ID: 0030_developer_messages
Revises: 0029_tracks_lower_artist_index
"""

import sqlalchemy as sa
from alembic import op


revision = "0030_developer_messages"
down_revision = "0029_tracks_lower_artist_index"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Таблица уже есть, если БД поднималась через create_all (DEBUG).
    bind = op.get_bind()
    if "developer_messages" in sa.inspect(bind).get_table_names():
        return
    op.create_table(
        "developer_messages",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("context", sa.JSON(), nullable=True),
        sa.Column("is_read", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_developer_messages_user_id", "developer_messages", ["user_id"])
    op.create_index("ix_developer_messages_created_at", "developer_messages", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_developer_messages_created_at", table_name="developer_messages")
    op.drop_index("ix_developer_messages_user_id", table_name="developer_messages")
    op.drop_table("developer_messages")
