"""Initial schema (idempotent bootstrap for existing databases)

Revision ID: 0001
Revises:
Create Date: 2026-07-03

"""
from alembic import op

from app.database import Base
from app import models  # noqa: F401

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    # checkfirst makes this a no-op for databases created by the old create_all
    Base.metadata.create_all(bind=op.get_bind(), checkfirst=True)


def downgrade() -> None:
    Base.metadata.drop_all(bind=op.get_bind())