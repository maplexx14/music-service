"""Индексы под реальные запросы + pg_trgm для ILIKE-поиска

Сортировки по популярности/давности и фильтры плейлистов ходили без индексов
(полные сканы на каждом списочном эндпоинте), а поиск ILIKE '%q%' с ведущим
процентом не может пользоваться b-tree вовсе — под него GIN по триграммам.

Revision ID: 0005
Revises: 0004
Create Date: 2026-07-10

"""
from alembic import op
import sqlalchemy as sa

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None

_INDEXES = [
    # Сортировка по популярности (tracks.py:get_tracks, recommendations, flow)
    ("ix_tracks_play_count", "tracks", [sa.text("play_count DESC")], {}),
    # Фильтры плейлистов (playlists.py, search.py, recommendations.py)
    ("ix_playlists_owner_id", "playlists", ["owner_id"], {}),
    ("ix_playlists_is_public", "playlists", ["is_public"], {}),
    # Сортировки по давности в профиле вкуса/истории (flow.py, tracks.py:history)
    (
        "ix_user_track_plays_user_last_played",
        "user_track_plays",
        ["user_id", sa.text("last_played DESC")],
        {},
    ),
    (
        "ix_user_liked_tracks_user_liked_at",
        "user_liked_tracks",
        ["user_id", sa.text("liked_at DESC")],
        {},
    ),
    (
        "ix_user_track_skips_user_last_skipped",
        "user_track_skips",
        ["user_id", sa.text("last_skipped DESC")],
        {},
    ),
    # ILIKE '%q%' (search.py, tracks.py:get_tracks по artist)
    (
        "ix_tracks_title_trgm",
        "tracks",
        ["title"],
        {"postgresql_using": "gin", "postgresql_ops": {"title": "gin_trgm_ops"}},
    ),
    (
        "ix_tracks_artist_trgm",
        "tracks",
        ["artist"],
        {"postgresql_using": "gin", "postgresql_ops": {"artist": "gin_trgm_ops"}},
    ),
    (
        "ix_tracks_album_trgm",
        "tracks",
        ["album"],
        {"postgresql_using": "gin", "postgresql_ops": {"album": "gin_trgm_ops"}},
    ),
    (
        "ix_playlists_name_trgm",
        "playlists",
        ["name"],
        {"postgresql_using": "gin", "postgresql_ops": {"name": "gin_trgm_ops"}},
    ),
    (
        "ix_users_username_trgm",
        "users",
        ["username"],
        {"postgresql_using": "gin", "postgresql_ops": {"username": "gin_trgm_ops"}},
    ),
]


def upgrade() -> None:
    bind = op.get_bind()
    # pg_trgm is PostgreSQL-only.  Ordinary indexes below remain useful in
    # SQLite test/development databases.
    if bind.dialect.name == "postgresql":
        op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    insp = sa.inspect(bind)
    for name, table, columns, kwargs in _INDEXES:
        existing = {ix["name"] for ix in insp.get_indexes(table)}
        if name not in existing:
            op.create_index(name, table, columns, **kwargs)


def downgrade() -> None:
    for name, table, _, _ in reversed(_INDEXES):
        op.drop_index(name, table_name=table)
