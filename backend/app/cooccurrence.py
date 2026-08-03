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

from sqlalchemy import bindparam, text
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

# Сколько соседей хранить на трек. Больше — точнее exploration, но таблица
# растёт как N_tracks * TOP_N.
_TOP_N = 30

# Пара (X, Y) попадает в матрицу, если её держат хотя бы столько РАЗНЫХ юзеров.
#
# Ниже двух опускать нельзя, как бы ни была мала база. Пара внутри библиотеки
# ОДНОГО юзера — это не коллаборативный сигнал вообще: `pairs` джойнит signals
# саму с собой по user_id, поэтому при пороге 1 в матрицу попадает каждая пара
# треков каждого юзера. Хуже того, у трека, который есть только у него, pop=1,
# и нормализованный скор равен 1/sqrt(1*1) = 1.0 — максимуму из возможных, то
# есть такие пары не «приглушаются нормализацией», а вытесняют настоящих
# соседей из топ-N.
#
# Пока юзер был один, это не проявлялось: его собственные соседи — его же
# треки, а их выдаче вырезает _collection_exclude_select. Стоило появиться
# второму юзеру — и единственным выхлопом CF стала его приватная библиотека со
# скором 1.0, которая поехала первому юзеру в exploration.
#
# Пустая матрица на двух юзерах — правильный ответ: коллаборативного сигнала
# там нет, и рекомендации должны откатываться на контентные фильтры.
_MIN_COMMON = 2

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
        -- COUNT(DISTINCT user_id), а не COUNT(*): signals собран через UNION и
        -- уже даёт не больше строки на (user_id, track_id), так что счётчики
        -- совпадают — но порог означает «сколько РАЗНЫХ юзеров», и полагаться
        -- здесь на неявную дедупликацию нельзя (см. _MIN_COMMON).
        HAVING COUNT(DISTINCT a.user_id) >= :min_common
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


def pair_scores(db: Session, track_ids) -> dict:
    """Похожесть ВНУТРИ набора кандидатов: {(a, b): score} в обе стороны.

    Нужна для MMR-отбора (diversity.mmr): чтобы наказывать кандидата за
    похожесть на уже выбранное, нужна метрика «трек ↔ трек». Обучать embeddings
    ради этого не обязательно — score в track_cooccurrence уже и есть метрика
    похожести по аудитории.

    Скоры нормируются на максимум в наборе: абсолютное значение зависит от
    размера базы (сколько юзеров вообще держат пару), а MMR сравнивает штраф с
    релевантностью в шкале 0..1.
    """
    ids = [int(t) for t in track_ids]
    if len(ids) < 2:
        return {}
    rows = db.execute(
        text(
            """
            SELECT track_id, other_track_id, score
            FROM track_cooccurrence
            WHERE track_id IN :ids AND other_track_id IN :ids
            """
        ).bindparams(bindparam("ids", expanding=True)),
        {"ids": ids},
    ).all()
    if not rows:
        return {}
    top = max(float(r[2]) for r in rows) or 1.0
    pairs: dict = {}
    for a, b, score in rows:
        s = float(score) / top
        # Матрица асимметрична (нормировка по популярности), а MMR нужен
        # симметричный «насколько это одно и то же» — берём максимум.
        key, rkey = (int(a), int(b)), (int(b), int(a))
        pairs[key] = max(pairs.get(key, 0.0), s)
        pairs[rkey] = max(pairs.get(rkey, 0.0), s)
    return pairs


def similar_track_ids(db: Session, seed_ids, limit: int = 100):
    """Соседи по co-occurrence для набора seed-треков.

    Возвращает [(track_id, суммарный score)] по убыванию похожести. Скоры
    суммируются по всем seed'ам: трек, похожий сразу на несколько любимых,
    выигрывает у похожего на один.
    """
    seed_ids = [int(s) for s in seed_ids]
    if not seed_ids:
        return []
    # IN с expanding bindparam, а не `= ANY(:seeds)`: ANY — Postgres-изм, на
    # SQLite (тесты) он падал с "no such function: ANY". План в Postgres тот же.
    rows = db.execute(
        text(
            """
            SELECT other_track_id, SUM(score) AS s
            FROM track_cooccurrence
            WHERE track_id IN :seeds
            GROUP BY other_track_id
            ORDER BY s DESC
            LIMIT :lim
            """
        ).bindparams(bindparam("seeds", expanding=True)),
        {"seeds": seed_ids, "lim": limit},
    ).all()
    return [(int(tid), float(score)) for tid, score in rows]
