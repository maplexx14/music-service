"""users.flow_tuning: тонкая настройка волны

Revision ID: 0034_user_flow_tuning
Revises: 0033_service_ratings
"""

import sqlalchemy as sa
from alembic import op


revision = "0034_user_flow_tuning"
down_revision = "0033_service_ratings"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Колонка уже есть, если БД поднималась через create_all (DEBUG).
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("users")}
    if "flow_tuning" in columns:
        return
    op.add_column(
        "users",
        sa.Column("flow_tuning", sa.JSON(), nullable=False, server_default="{}"),
    )


def downgrade() -> None:
    op.drop_column("users", "flow_tuning")
