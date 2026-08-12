"""Двухфакторка по почте: флаг на юзере

Добавляет в users:
- email_2fa_enabled — вход требует 6-значный код, высланный письмом.

Второй независимый фактор рядом с TOTP (0010). Включён по умолчанию не
бывает: включение — осознанное действие в настройках, поэтому false и для
существующих строк, и для новых.

Сами коды в БД не хранятся: это одноразовый расходник со сроком годности,
он живёт в Redis (см. app/email_2fa.py) в виде bcrypt-хэша.

Revision ID: 0012
Revises: 0011
Create Date: 2026-08-11

"""
from alembic import op
import sqlalchemy as sa

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = [col['name'] for col in inspector.get_columns('users')]

    if 'email_2fa_enabled' not in columns:
        op.add_column(
            "users",
            sa.Column(
                "email_2fa_enabled", sa.Boolean(), nullable=False, server_default=sa.false()
            ),
        )


def downgrade() -> None:
    op.drop_column("users", "email_2fa_enabled")
