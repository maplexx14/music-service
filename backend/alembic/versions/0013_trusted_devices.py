"""Доверенные устройства: вход с нового устройства требует второй фактор

Добавляет таблицу user_trusted_devices:
- token_hash    — sha256 от токена устройства; сам токен живёт только в
                  localStorage клиента, в БД его нет (дамп не должен давать
                  готовый ключ «я знакомое устройство»);
- label         — подпись из User-Agent для списка в настройках;
- last_seen_at  — обновляется при входе, по нему видно заброшенные устройства.

Существующим юзерам таблица пустая, то есть их текущее устройство считается
новым и первый вход после релиза попросит код с почты. Это осознанно: доверять
устройству, которое мы никогда не проверяли, нельзя, а альтернатива —
пометить все существующие сессии доверенными и обесценить всю проверку.

Revision ID: 0013
Revises: 0012
Create Date: 2026-08-11

"""
from alembic import op
import sqlalchemy as sa

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if 'user_trusted_devices' in inspector.get_table_names():
        return

    op.create_table(
        "user_trusted_devices",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("token_hash", sa.String(), nullable=False),
        sa.Column("label", sa.String(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    # Уникальный: token_hash — то, по чему ищем устройство на каждом логине.
    op.create_index(
        "ix_user_trusted_devices_token_hash", "user_trusted_devices", ["token_hash"], unique=True
    )
    # Неуникальный: список устройств юзера в настройках и их отзыв.
    op.create_index("ix_user_trusted_devices_user_id", "user_trusted_devices", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_user_trusted_devices_user_id", table_name="user_trusted_devices")
    op.drop_index("ix_user_trusted_devices_token_hash", table_name="user_trusted_devices")
    op.drop_table("user_trusted_devices")
