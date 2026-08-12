"""TOTP-двухфакторка: секрет, флаг включения и резервные коды

Добавляет в users:
- totp_secret          — секрет провижининга (BASE32); хранится и до enable,
                         потому что QR сканируется между setup и enable;
- totp_enabled         — флаг: секрет стал рабочим фактором входа;
- totp_recovery_codes  — bcrypt-хэши резервных кодов; использованный удаляется.

Revision ID: 0010
Revises: 0009
Create Date: 2026-08-11

"""
from alembic import op
import sqlalchemy as sa

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = [col['name'] for col in inspector.get_columns('users')]

    if 'totp_secret' not in columns:
        op.add_column("users", sa.Column("totp_secret", sa.String(), nullable=True))
    if 'totp_enabled' not in columns:
        op.add_column(
            "users",
            sa.Column("totp_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        )
    if 'totp_recovery_codes' not in columns:
        op.add_column(
            "users",
            sa.Column("totp_recovery_codes", sa.JSON(), nullable=False, server_default="[]"),
        )


def downgrade() -> None:
    op.drop_column("users", "totp_recovery_codes")
    op.drop_column("users", "totp_enabled")
    op.drop_column("users", "totp_secret")
