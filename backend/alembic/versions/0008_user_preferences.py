"""Явные музыкальные предпочтения пользователя (жанры и артисты)

Добавляет две JSON-колонки в таблицу users:
- preferred_genres  — список ключей жанров (из GENRE_KEYWORDS),
- preferred_artists — список имён любимых артистов.

Выбираются при онбординге после регистрации и меняются в настройках.
Используются как позитивный сигнал в рекомендациях (см. app/routers/flow.py),
в т.ч. для «холодного старта» новых пользователей.

Revision ID: 0008
Revises: 0007
Create Date: 2026-07-14

"""
from alembic import op
import sqlalchemy as sa

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = [col['name'] for col in inspector.get_columns('users')]

    if 'preferred_genres' not in columns:
        op.add_column(
            "users",
            sa.Column(
                "preferred_genres",
                sa.JSON(),
                nullable=False,
                server_default="[]",
            ),
        )
    if 'preferred_artists' not in columns:
        op.add_column(
            "users",
            sa.Column(
                "preferred_artists",
                sa.JSON(),
                nullable=False,
                server_default="[]",
            ),
        )


def downgrade() -> None:
    op.drop_column("users", "preferred_artists")
    op.drop_column("users", "preferred_genres")
