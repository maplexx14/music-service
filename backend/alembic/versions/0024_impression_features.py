"""add features to recommendation_impressions

Происхождение кандидата (радио, граф артистов, теги...), признак новизны
артиста и компоненты score для каждой отданной позиции. Без них офлайн-анализ
видел только итоговый score и не мог сказать, какой источник или признак
реально предсказывает прослушивание.

Revision ID: 0024_impression_features
Revises: 0023_add_file_size
"""

from alembic import op
import sqlalchemy as sa


revision = "0024_impression_features"
down_revision = "0023_add_file_size"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("recommendation_impressions")}
    if "features" not in columns:
        op.add_column(
            "recommendation_impressions",
            sa.Column("features", sa.JSON(), nullable=True),
        )


def downgrade() -> None:
    op.drop_column("recommendation_impressions", "features")
