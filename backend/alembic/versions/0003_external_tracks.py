"""External tracks: source/external_id/stream_url, nullable file_path

Revision ID: 0003
Revises: 0002
Create Date: 2026-07-06

"""
from alembic import op
import sqlalchemy as sa

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = [c["name"] for c in insp.get_columns("tracks")]

    if "source" not in cols:
        op.add_column(
            "tracks",
            sa.Column("source", sa.String(), nullable=False, server_default="local"),
        )
        op.create_index("ix_tracks_source", "tracks", ["source"])
    if "external_id" not in cols:
        op.add_column("tracks", sa.Column("external_id", sa.String(), nullable=True))
        op.create_index("ix_tracks_external_id", "tracks", ["external_id"])
    if "stream_url" not in cols:
        op.add_column("tracks", sa.Column("stream_url", sa.String(), nullable=True))

    # У внешних треков нет локального файла. Newer bootstraps already have a
    # nullable column; only alter legacy schemas that still need it. SQLite
    # requires Alembic's batch table rebuild for this operation.
    file_path = next(
        (column for column in insp.get_columns("tracks") if column["name"] == "file_path"),
        None,
    )
    if file_path is not None and not file_path.get("nullable", True):
        if bind.dialect.name == "sqlite":
            with op.batch_alter_table("tracks") as batch:
                batch.alter_column(
                    "file_path", existing_type=sa.String(), nullable=True
                )
        else:
            op.alter_column(
                "tracks", "file_path", existing_type=sa.String(), nullable=True
            )

    # Идемпотентный апсерт по (source, external_id). Частичный уникальный индекс,
    # чтобы множество локальных треков с external_id IS NULL не конфликтовало.
    existing_indexes = [i["name"] for i in insp.get_indexes("tracks")]
    if "uq_tracks_source_external" not in existing_indexes:
        op.create_index(
            "uq_tracks_source_external",
            "tracks",
            ["source", "external_id"],
            unique=True,
            postgresql_where=sa.text("external_id IS NOT NULL"),
        )


def downgrade() -> None:
    op.drop_index("uq_tracks_source_external", table_name="tracks")
    bind = op.get_bind()
    if bind.dialect.name == "sqlite":
        with op.batch_alter_table("tracks") as batch:
            batch.alter_column(
                "file_path", existing_type=sa.String(), nullable=False
            )
    else:
        op.alter_column(
            "tracks", "file_path", existing_type=sa.String(), nullable=False
        )
    op.drop_column("tracks", "stream_url")
    op.drop_index("ix_tracks_external_id", table_name="tracks")
    op.drop_column("tracks", "external_id")
    op.drop_index("ix_tracks_source", table_name="tracks")
    op.drop_column("tracks", "source")
