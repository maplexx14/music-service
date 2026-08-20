"""Порог co-occurrence: паре нужно как минимум два РАЗНЫХ юзера.

Боевая регрессия: при `_MIN_COMMON = 1` в матрицу попадала каждая пара треков
внутри библиотеки одного юзера — `pairs` джойнит signals саму с собой по
user_id. У трека, который есть только у него, pop = 1, поэтому нормализованный
скор равен 1/sqrt(1*1) = 1.0, то есть МАКСИМУМУ: такие пары не приглушались
нормализацией, а вытесняли настоящих соседей из топ-N.

Пока юзер был один, это не проявлялось — его собственные соседи это его же
треки, а их вырезает _collection_exclude_select. Стоило появиться второму
юзеру, и единственным выхлопом CF стала его приватная библиотека со скором 1.0,
уехавшая первому юзеру в exploration.

SQL пересчёта совместим и с PostgreSQL, и с SQLite: тестовый раннер может
выполнить тот же CTE без отдельной реализации.
"""

from sqlalchemy import create_engine, text

from app.cooccurrence import _MIN_COMMON, _REBUILD_SQL


def test_pair_requires_at_least_two_users():
    assert _MIN_COMMON >= 2, (
        "порог ниже двух возвращает баг «чужая библиотека в рекомендациях»: "
        "пара внутри одного юзера — не коллаборативный сигнал, а её скор равен "
        "максимальным 1.0"
    )


def test_threshold_counts_distinct_users():
    """Порог должен считать РАЗНЫХ юзеров, а не строки.

    signals собран через UNION и уже даёт не больше строки на (user_id,
    track_id), поэтому COUNT(*) численно совпадает — но полагаться на неявную
    дедупликацию нельзя: стоит кому-то поменять UNION на UNION ALL или добавить
    третий источник сигналов, и порог молча начнёт считать не то.
    """
    sql = str(_REBUILD_SQL)
    assert "COUNT(DISTINCT a.user_id) >= :min_common" in sql, (
        f"порог должен считать разных юзеров, а не строки:\n{sql}"
    )


def test_rebuild_sql_runs_on_sqlite():
    engine = create_engine("sqlite://")
    with engine.begin() as db:
        db.exec_driver_sql(
            "CREATE TABLE user_track_plays "
            "(user_id INTEGER, track_id INTEGER, play_count INTEGER)"
        )
        db.exec_driver_sql(
            "CREATE TABLE user_track_skips "
            "(user_id INTEGER, track_id INTEGER, skip_count INTEGER, disliked BOOLEAN)"
        )
        db.exec_driver_sql(
            "CREATE TABLE playlist_tracks (playlist_id INTEGER, track_id INTEGER)"
        )
        db.exec_driver_sql(
            "CREATE TABLE playlists (id INTEGER, owner_id INTEGER, is_liked BOOLEAN)"
        )
        db.exec_driver_sql(
            "CREATE TABLE track_cooccurrence "
            "(track_id INTEGER, other_track_id INTEGER, score FLOAT, "
            "common_users INTEGER, updated_at TIMESTAMP)"
        )
        db.execute(_REBUILD_SQL, {"top_n": 50, "min_common": 2})
        assert db.execute(text("SELECT COUNT(*) FROM track_cooccurrence")).scalar() == 0
