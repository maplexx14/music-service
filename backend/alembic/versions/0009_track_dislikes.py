"""Явный дизлайк трека: флаг disliked в user_track_skips

Дизлайк — тот же негативный сигнал, что скип, но осознанный: трек исключается
из выдачи (это уже даёт само наличие строки в user_track_skips), а артист
получает более сильный штраф без затухания по времени.

Revision ID: 0009
Revises: 0008
Create Date: 2026-07-27

"""
from alembic import op
import sqlalchemy as sa

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = [col['name'] for col in inspector.get_columns('user_track_skips')]

    if 'disliked' not in columns:
        op.add_column(
            "user_track_skips",
            sa.Column(
                "disliked",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            ),
        )


def downgrade() -> None:
    op.drop_column("user_track_skips", "disliked")
