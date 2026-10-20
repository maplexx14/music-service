"""push_subscriptions и app_secrets: Web Push

Revision ID: 0032_push_subscriptions
Revises: 0031_user_last_user_agent
"""

import sqlalchemy as sa
from alembic import op


revision = "0032_push_subscriptions"
down_revision = "0031_user_last_user_agent"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Таблицы уже есть, если БД поднималась через create_all (DEBUG).
    bind = op.get_bind()
    tables = set(sa.inspect(bind).get_table_names())
    if "push_subscriptions" not in tables:
        op.create_table(
            "push_subscriptions",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("endpoint", sa.Text(), nullable=False, unique=True),
            sa.Column("p256dh", sa.String(256), nullable=False),
            sa.Column("auth", sa.String(64), nullable=False),
            sa.Column("user_agent", sa.String(512), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.Column("last_success_at", sa.DateTime(timezone=True), nullable=True),
        )
        op.create_index("ix_push_subscriptions_user_id", "push_subscriptions", ["user_id"])
    if "app_secrets" not in tables:
        op.create_table(
            "app_secrets",
            sa.Column("name", sa.String(64), primary_key=True),
            sa.Column("value", sa.Text(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        )


def downgrade() -> None:
    op.drop_table("app_secrets")
    op.drop_index("ix_push_subscriptions_user_id", table_name="push_subscriptions")
    op.drop_table("push_subscriptions")
