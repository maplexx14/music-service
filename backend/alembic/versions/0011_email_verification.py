"""Подтверждение почты: флаг на юзере

Добавляет в users:
- email_verified — почта подтверждена переходом по ссылке из письма.

Существующим юзерам ставим true: они регистрировались до появления
подтверждения, и default=false заблокировал бы им вход. Новые строки
получают false через server_default.

Сами токены подтверждения в БД не хранятся — они лежат в Redis
(email_verification.py) с TTL 24 ч, потому что это одноразовый расходник,
а не состояние юзера.

Revision ID: 0011
Revises: 0010
Create Date: 2026-08-11

"""
from alembic import op
import sqlalchemy as sa

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = [col['name'] for col in inspector.get_columns('users')]

    if 'email_verified' not in columns:
        op.add_column(
            "users",
            sa.Column(
                "email_verified", sa.Boolean(), nullable=False, server_default=sa.false()
            ),
        )
        # Разовый backfill: все, кто уже зарегистрирован, считаются
        # подтверждёнными. Только для существующих строк — server_default
        # оставляет false для будущих регистраций.
        op.execute("UPDATE users SET email_verified = true")


def downgrade() -> None:
    op.drop_column("users", "email_verified")
