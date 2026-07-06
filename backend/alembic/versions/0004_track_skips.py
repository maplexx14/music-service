"""user_track_skips: скипы как негативный сигнал для рекомендаций

Revision ID: 0004
Revises: 0003
Create Date: 2026-07-06

"""
from alembic import op
import sqlalchemy as sa

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "user_track_skips" not in insp.get_table_names():
        op.create_table(
            "user_track_skips",
            sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), primary_key=True),
            sa.Column("track_id", sa.Integer(), sa.ForeignKey("tracks.id"), primary_key=True),
            sa.Column("skip_count", sa.Integer(), server_default="1"),
            sa.Column(
                "last_skipped",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
            ),
        )


def downgrade() -> None:
    op.drop_table("user_track_skips")
