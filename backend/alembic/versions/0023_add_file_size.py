"""add file_size to tracks

Размер файла в байтах для быстрого stat без обращения к MinIO.
При upload/archive записывается сразу, существующие треки получат NULL
и будут заполняться лениво при первом стриме (fallback на HEAD).

Revision ID: 0023_add_file_size
Revises: 0022_user_last_seen
"""

from alembic import op
import sqlalchemy as sa


revision = "0023_add_file_size"
down_revision = "0022_user_last_seen"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("tracks")}
    if "file_size" not in columns:
        op.add_column("tracks", sa.Column("file_size", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("tracks", "file_size")
