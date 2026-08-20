"""Per-user share of unfamiliar artists in recommendations and the wave."""

from alembic import op
import sqlalchemy as sa


revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {column["name"] for column in inspector.get_columns("users")}
    if "discovery_ratio" not in columns:
        op.add_column(
            "users",
            sa.Column(
                # 0.2 — прежнее захардкоженное поведение обоих движков, поэтому
                # у существующих юзеров выдача после миграции не меняется.
                "discovery_ratio",
                sa.Float(),
                nullable=False,
                server_default="0.2",
            ),
        )


def downgrade() -> None:
    op.drop_column("users", "discovery_ratio")
