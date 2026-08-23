"""Один is_liked-плейлист на пользователя

Уникальности в БД не было: `get_or_create_liked_playlist` делал SELECT, потом
INSERT, и два одновременных лайка создавали пользователю второй плейлист
"Понравившиеся". Читатели брали его через `.scalar()` и получали
MultipleResultsFound — админ-панель проходит по всем пользователям, поэтому
одна такая строка ломала панель целиком.

Дубликаты сливаются в самый старый плейлист (треки переносятся, позиции
продолжают существующие), после чего частичный уникальный индекс делает
повторение невозможным.

Revision ID: 0021_unique_liked_playlist
Revises: 0020_content_profile
"""

from alembic import op
import sqlalchemy as sa


revision = "0021_unique_liked_playlist"
down_revision = "0020_content_profile"
branch_labels = None
depends_on = None


INDEX_NAME = "uq_playlists_owner_liked"


def _merge_duplicates(bind) -> None:
    duplicate_owners = [
        row[0]
        for row in bind.execute(
            sa.text(
                "SELECT owner_id FROM playlists WHERE is_liked IS TRUE "
                "GROUP BY owner_id HAVING count(*) > 1"
            )
        )
    ]
    for owner_id in duplicate_owners:
        playlist_ids = [
            row[0]
            for row in bind.execute(
                sa.text(
                    "SELECT id FROM playlists WHERE owner_id = :owner "
                    "AND is_liked IS TRUE ORDER BY id"
                ),
                {"owner": owner_id},
            )
        ]
        keep, extras = playlist_ids[0], playlist_ids[1:]
        for extra in extras:
            # Треки, которых в основном плейлисте ещё нет, переезжают в конец.
            next_position = bind.execute(
                sa.text(
                    "SELECT coalesce(max(position), -1) + 1 FROM playlist_tracks "
                    "WHERE playlist_id = :keep"
                ),
                {"keep": keep},
            ).scalar()
            moving = bind.execute(
                sa.text(
                    "SELECT track_id, added_at FROM playlist_tracks "
                    "WHERE playlist_id = :extra AND track_id NOT IN ("
                    "  SELECT track_id FROM playlist_tracks WHERE playlist_id = :keep"
                    ") ORDER BY added_at NULLS LAST, track_id"
                ),
                {"extra": extra, "keep": keep},
            ).all()
            for offset, (track_id, added_at) in enumerate(moving):
                bind.execute(
                    sa.text(
                        "INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at) "
                        "VALUES (:keep, :track_id, :position, :added_at)"
                    ),
                    {
                        "keep": keep,
                        "track_id": track_id,
                        "position": next_position + offset,
                        "added_at": added_at,
                    },
                )
            bind.execute(
                sa.text("DELETE FROM playlist_tracks WHERE playlist_id = :extra"),
                {"extra": extra},
            )
            bind.execute(
                sa.text("DELETE FROM playlists WHERE id = :extra"),
                {"extra": extra},
            )


def upgrade() -> None:
    bind = op.get_bind()
    _merge_duplicates(bind)
    existing = {ix["name"] for ix in sa.inspect(bind).get_indexes("playlists")}
    if INDEX_NAME not in existing:
        op.create_index(
            INDEX_NAME,
            "playlists",
            ["owner_id"],
            unique=True,
            postgresql_where=sa.text("is_liked IS TRUE"),
            sqlite_where=sa.text("is_liked IS TRUE"),
        )


def downgrade() -> None:
    op.drop_index(INDEX_NAME, table_name="playlists")
