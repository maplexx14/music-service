"""Item-based коллаборативная фильтрация: co-occurrence треков.

«Юзеры, которые слушают трек X, также слушают Y» — считается по повторным
прослушиваниям (user_track_plays, play_count >= 2) и трекам в плейлистах
(включая «Понравившиеся») ВСЕХ пользователей. Это единственный сигнал в
системе, который умеет открывать юзеру НОВЫХ артистов — контентные фильтры
(жанр/слова/артист) рекомендуют в основном каталог уже знакомых.

Пересчитывать на каждый запрос дорого (self-join по всем сигналам), поэтому
матрица предрассчитывается фоновой задачей (см. main.py) в таблицу
track_cooccurrence: топ-N соседей на трек с нормализованным скором
common / sqrt(pop_a * pop_b) — иначе глобальные хиты «похожи» на всё подряд
просто из-за своей популярности.
"""
import logging

from sqlalchemy import text
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

# Сколько соседей хранить на трек. Больше — точнее exploration, но таблица
# растёт как N_tracks * TOP_N.
_TOP_N = 30

# Пара (X, Y) попадает в матрицу, если общих юзеров хотя бы столько. На
# малой базе (мало юзеров) порог 1 — иначе матрица пустая; нормализация
# скором всё равно приглушает случайные совпадения.
_MIN_COMMON = 1

_REBUILD_SQL = text(
    """
    WITH signals AS (
        SELECT user_id, track_id FROM user_track_plays WHERE play_count >= 2
        UNION
        SELECT p.owner_id AS user_id, pt.track_id
        FROM playlist_tracks pt
        JOIN playlists p ON p.id = pt.playlist_id
    ),
    pop AS (
        SELECT track_id, COUNT(*) AS cnt FROM signals GROUP BY track_id
    ),
    pairs AS (
        SELECT a.track_id, b.track_id AS other_track_id, COUNT(*) AS common
        FROM signals a
        JOIN signals b ON a.user_id = b.user_id AND a.track_id <> b.track_id
        GROUP BY a.track_id, b.track_id
        HAVING COUNT(*) >= :min_common
    ),
    scored AS (
        SELECT
            p.track_id,
            p.other_track_id,
            p.common / sqrt(pa.cnt::float * pb.cnt::float) AS score,
            ROW_NUMBER() OVER (
                PARTITION BY p.track_id
                ORDER BY p.common / sqrt(pa.cnt::float * pb.cnt::float) DESC
            ) AS rn
        FROM pairs p
        JOIN pop pa ON pa.track_id = p.track_id
        JOIN pop pb ON pb.track_id = p.other_track_id
    )
    INSERT INTO track_cooccurrence (track_id, other_track_id, score, updated_at)
    SELECT track_id, other_track_id, score, NOW()
    FROM scored
    WHERE rn <= :top_n
    """
)


def rebuild_cooccurrence(db: Session) -> int:
    """Полный пересчёт матрицы co-occurrence. Возвращает число пар.

    DELETE + INSERT в одной транзакции: читатели видят либо старую матрицу,
    либо новую целиком (в Postgres по умолчанию READ COMMITTED этого хватает —
    незакоммиченный DELETE снаружи не виден).
    """
    db.execute(text("DELETE FROM track_cooccurrence"))
    db.execute(_REBUILD_SQL, {"top_n": _TOP_N, "min_common": _MIN_COMMON})
    db.commit()
    count = db.execute(text("SELECT COUNT(*) FROM track_cooccurrence")).scalar()
    return int(count or 0)


def similar_track_ids(db: Session, seed_ids, limit: int = 100):
    """Соседи по co-occurrence для набора seed-треков.

    Возвращает [(track_id, суммарный score)] по убыванию похожести. Скоры
    суммируются по всем seed'ам: трек, похожий сразу на несколько любимых,
    выигрывает у похожего на один.
    """
    seed_ids = [int(s) for s in seed_ids]
    if not seed_ids:
        return []
    rows = db.execute(
        text(
            """
            SELECT other_track_id, SUM(score) AS s
            FROM track_cooccurrence
            WHERE track_id = ANY(:seeds)
            GROUP BY other_track_id
            ORDER BY s DESC
            LIMIT :lim
            """
        ),
        {"seeds": seed_ids, "lim": limit},
    ).all()
    return [(int(tid), float(score)) for tid, score in rows]
