"""add censor_overrides.evidence

Результат сравнения звука цензурной версии с оригиналом (где и насколько
заглушено) — см. app/audio_compare.py. Отдельной миграцией: 0025 уже
выкачена.

Revision ID: 0026_censor_evidence
Revises: 0025_censor_overrides
"""

from alembic import op
import sqlalchemy as sa


revision = "0026_censor_evidence"
down_revision = "0025_censor_overrides"
branch_labels = None
depends_on = None


def upgrade() -> None:
    columns = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("censor_overrides")}
    if "evidence" not in columns:
        op.add_column("censor_overrides", sa.Column("evidence", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("censor_overrides", "evidence")
