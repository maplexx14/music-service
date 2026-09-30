"""add censor_overrides

Привязка зацензуренных треков каталога (закон РФ о «пропаганде») к их
оригиналам на SoundCloud. См. app/models.CensorOverride и app/censorship.py.

Revision ID: 0025_censor_overrides
Revises: 0024_impression_features
"""

from alembic import op
import sqlalchemy as sa


revision = "0025_censor_overrides"
down_revision = "0024_impression_features"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if "censor_overrides" in sa.inspect(bind).get_table_names():
        return
    op.create_table(
        "censor_overrides",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("source", sa.String(16), nullable=False, server_default="ytmusic"),
        sa.Column("external_id", sa.String(), nullable=False),
        sa.Column("censored_title", sa.String(), nullable=False),
        sa.Column("censored_artist", sa.String(), nullable=False),
        sa.Column("censored_key", sa.String(), nullable=False),
        sa.Column("original_id", sa.String(), nullable=False),
        sa.Column("original_permalink", sa.String(), nullable=False),
        sa.Column("original_title", sa.String(), nullable=False),
        sa.Column("original_artist", sa.String(), nullable=False),
        sa.Column("original_duration", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("original_cover_url", sa.String(), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="suggested"),
        sa.Column("score", sa.Float(), nullable=True),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index(
        "uq_censor_overrides_source_external",
        "censor_overrides",
        ["source", "external_id"],
        unique=True,
    )
    op.create_index("ix_censor_overrides_censored_key", "censor_overrides", ["censored_key"])
    op.create_index("ix_censor_overrides_status", "censor_overrides", ["status"])


def downgrade() -> None:
    op.drop_table("censor_overrides")
