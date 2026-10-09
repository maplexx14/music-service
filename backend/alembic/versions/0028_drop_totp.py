"""drop TOTP 2FA columns

Приложение-аутентификатор убрано целиком: вход подтверждается только кодом
на почту. Секреты и резервные коды больше ничем не читаются — сносим.

Revision ID: 0028_drop_totp
Revises: 0027_user_player_states
"""

from alembic import op
import sqlalchemy as sa


revision = "0028_drop_totp"
down_revision = "0027_user_player_states"
branch_labels = None
depends_on = None

_COLUMNS = ("totp_recovery_codes", "totp_enabled", "totp_secret")


def upgrade() -> None:
    columns = {col["name"] for col in sa.inspect(op.get_bind()).get_columns("users")}
    for name in _COLUMNS:
        if name in columns:
            op.drop_column("users", name)


def downgrade() -> None:
    op.add_column("users", sa.Column("totp_secret", sa.String(), nullable=True))
    op.add_column(
        "users",
        sa.Column("totp_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "users",
        sa.Column("totp_recovery_codes", sa.JSON(), nullable=False, server_default="[]"),
    )
