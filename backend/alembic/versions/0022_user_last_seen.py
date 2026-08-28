"""Колонка users.last_seen — «последний онлайн» для админ-панели.

Админка раньше знала только, СКОЛЬКО юзеров онлайн (маркеры в Redis с TTL
120 с), но не кто и когда заходил последний раз. last_seen пишется с
троттлингом из get_current_user (см. dependencies.py) и служит порядком
сортировки профилей: онлайн-юзеры получают свежий last_seen автоматически.

Существующим строкам остаётся NULL — они едут в конце сортировки (NULLS
LAST) и заполняются первым же заходом юзера.

Revision ID: 0022_user_last_seen
Revises: 0021_unique_liked_playlist
"""

from alembic import op
import sqlalchemy as sa


revision = "0022_user_last_seen"
down_revision = "0021_unique_liked_playlist"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("last_seen", sa.DateTime(timezone=True), nullable=True))
    op.create_index("ix_users_last_seen", "users", ["last_seen"])


def downgrade() -> None:
    op.drop_index("ix_users_last_seen", table_name="users")
    op.drop_column("users", "last_seen")
