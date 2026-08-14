"""Store artists dismissed from the automatically detected taste profile."""

from alembic import op
import sqlalchemy as sa


revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {column["name"] for column in inspector.get_columns("users")}
    if "excluded_artists" not in columns:
        op.add_column(
            "users",
            sa.Column(
                "excluded_artists",
                sa.JSON(),
                nullable=False,
                server_default="[]",
            ),
        )


def downgrade() -> None:
    op.drop_column("users", "excluded_artists")
