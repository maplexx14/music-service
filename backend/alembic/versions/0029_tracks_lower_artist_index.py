"""index on lower(tracks.artist)

Flow и рекомендации выбирают треки по lower(artist) = ANY(список артистов
вкуса). EXPLAIN на проде (2026-10-12): Seq Scan по всем трекам, ~20-30 мс на
каждый из трёх таких запросов за один /recommendations/flow. Выражение в
индексе совпадает с тем, что генерирует SQLAlchemy (func.lower(Track.artist)).

Revision ID: 0029_tracks_lower_artist_index
Revises: 0028_drop_totp
"""

from alembic import op


revision = "0029_tracks_lower_artist_index"
down_revision = "0028_drop_totp"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # IF NOT EXISTS: индекс уже есть в моделях (create_all на свежей БД).
    op.execute("CREATE INDEX IF NOT EXISTS ix_tracks_lower_artist ON tracks (lower(artist))")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_tracks_lower_artist")
