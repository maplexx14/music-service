"""service_ratings: оценка довольства сервисом из настроек

Revision ID: 0033_service_ratings
Revises: 0032_push_subscriptions
"""

import sqlalchemy as sa
from alembic import op


revision = "0033_service_ratings"
down_revision = "0032_push_subscriptions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Таблица уже есть, если БД поднималась через create_all (DEBUG).
    bind = op.get_bind()
    if "service_ratings" in sa.inspect(bind).get_table_names():
        return
    op.create_table(
        "service_ratings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, unique=True),
        sa.Column("score", sa.Integer(), nullable=False),
        sa.Column("comment", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_service_ratings_updated_at", "service_ratings", ["updated_at"])


def downgrade() -> None:
    op.drop_index("ix_service_ratings_updated_at", table_name="service_ratings")
    op.drop_table("service_ratings")
