"""Сигналы для рекомендаций: события прослушиваний, показы, co-occurrence

Три новые таблицы:
- user_play_events — лог событий прослушивания с долей дослушивания
  (completion) и локальным часом клиента. В отличие от агрегата
  user_track_plays хранит каждое событие — питает сигналы «дослушал/бросил»
  и контекст времени суток.
- rec_impressions — счётчик показов трека в рекомендациях. Показанный
  несколько раз и ни разу не сыгранный трек — негативный сигнал.
- track_cooccurrence — предрассчитанная item-item похожесть (co-occurrence
  по повторным прослушиваниям и плейлистам всех юзеров) для коллаборативной
  фильтрации и exploration-слотов.

Revision ID: 0007
Revises: 0006
Create Date: 2026-07-14

"""
from alembic import op
import sqlalchemy as sa

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ondelete=CASCADE: эти таблицы не замаплены как ORM-relationships, при
    # удалении трека/юзера ORM их не подчистит — пусть чистит сама БД.
    op.create_table(
        "user_play_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "track_id",
            sa.Integer(),
            sa.ForeignKey("tracks.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "played_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        # Финальная доля прослушивания 0..1 (NULL — ещё не сообщена фронтом).
        sa.Column("completion", sa.Float(), nullable=True),
        # Локальный час клиента 0-23 (таймзона юзера != таймзоне сервера).
        sa.Column("client_hour", sa.Integer(), nullable=True),
    )
    op.create_index(
        "ix_user_play_events_user_played",
        "user_play_events",
        ["user_id", "played_at"],
    )
    op.create_index("ix_user_play_events_track", "user_play_events", ["track_id"])

    op.create_table(
        "rec_impressions",
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "track_id",
            sa.Integer(),
            sa.ForeignKey("tracks.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("shown_count", sa.Integer(), nullable=False, server_default="1"),
        sa.Column(
            "last_shown",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )

    op.create_table(
        "track_cooccurrence",
        sa.Column(
            "track_id",
            sa.Integer(),
            sa.ForeignKey("tracks.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "other_track_id",
            sa.Integer(),
            sa.ForeignKey("tracks.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("score", sa.Float(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_track_cooccurrence_track", "track_cooccurrence", ["track_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_track_cooccurrence_track", table_name="track_cooccurrence")
    op.drop_table("track_cooccurrence")
    op.drop_table("rec_impressions")
    op.drop_index("ix_user_play_events_track", table_name="user_play_events")
    op.drop_index("ix_user_play_events_user_played", table_name="user_play_events")
    op.drop_table("user_play_events")
