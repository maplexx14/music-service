"""flow-warmer: заранее считает следующие порции потока рекомендаций.

Отдельный процесс (сервис flow-warmer в docker-compose), а не фон веб-воркера:
расчёт порции — это веер провайдеров и ранжирование, секунды CPU под GIL, и в
веб-воркере они отнимали время у всех запросов (замер 2026-10-13: 100
одновременных холодных /flow на 4 воркерах — 80 обрывов, WORKER TIMEOUT).
Здесь он идёт с пониженным приоритетом и не мешает отдаче.

Задачи приходят из Redis-очереди flow:pc:queue: /flow ставит юзера туда после
каждой выдачи (см. flow._deliver_portion). Порция считается тем же конвейером
flow._compute_flow(mode="precompute") и кладётся в flow:ready:{user} вместе с
ranking_context, для которого посчитана. Плюс периодический проход: тем, кто
был в потоке за FLOW_WARMER_ACTIVE_HOURS, порция пересчитывается незадолго до
того, как выдача сочтёт её устаревшей, — чтобы и первый клик после перерыва
попадал в готовое. И пересчёт по сигналу юзера: лайк, дизлайк или серия
скипов после расчёта (отложенная очередь flow:pc:delayed, см.
recommendation_cache.mark_flow_signal). Матчи источников аудио (Soulseek качает
файл) ставятся сразу только для порции, заказанной выдачей; остальным — при
выдаче.

Запуск: python -m app.flow_warmer
"""
import asyncio
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import urlsplit

from fastapi import Response
from sqlalchemy import func, select
from starlette.requests import Request

from app.cache import get_cache_async, redis_client, set_cache_async
from app.recommendation_cache import FLOW_PC_DELAYED, flow_signal_key, flow_skips_key
from app.database import SessionLocal
from app.models import User, recommendation_impressions
from app.routers import flow

logger = logging.getLogger("flow_warmer")

# Одновременных расчётов. На проде расчёт — 4–10 с, из них CPU около секунды,
# остальное ждёт провайдеров: параллельность поднимает пропускную способность
# примерно до одной порции в секунду, дальше упрётся в GIL одного процесса.
CONCURRENCY = int(os.getenv("FLOW_WARMER_CONCURRENCY", "6"))
# Готовая порция старше этого пересчитывается периодическим проходом. Чуть
# меньше flow._READY_MAX_AGE (90 мин) за вычетом прохода и расчёта: раньше —
# лишние расчёты и походы к провайдерам для тех, кто сейчас не слушает.
REFRESH_AFTER = int(os.getenv("FLOW_WARMER_REFRESH_SEC", "4500"))
SCAN_EVERY = int(os.getenv("FLOW_WARMER_SCAN_SEC", "300"))
NICE = int(os.getenv("FLOW_WARMER_NICE", "10"))
THREADS = int(os.getenv("FLOW_WARMER_THREADS", "32"))
# Кого держать с готовой порцией: получавших поток за столько часов (по
# показам в БД, а не только по мете в Redis) — чтобы и после перерыва в пару
# дней, и после пересоздания Redis первый клик попадал в готовое.
ACTIVE_HOURS = int(os.getenv("FLOW_WARMER_ACTIVE_HOURS", "72"))
MAX_USERS = int(os.getenv("FLOW_WARMER_MAX_USERS", "5000"))
DEFAULT_LIMIT = 15
# Выдача была не раньше этого — юзер слушает, порцию скоро заберут: матчи
# источников аудио ставим при предрасчёте, а не при выдаче.
MATCH_WINDOW = int(os.getenv("FLOW_WARMER_MATCH_SEC", "600"))
# Как часто перекладывать созревшие сигналы из flow:pc:delayed в очередь.
SIGNAL_POLL = float(os.getenv("FLOW_WARMER_SIGNAL_POLL_SEC", "1"))
# BLPOP короче socket_timeout клиента Redis (cache.py, 2 с), иначе пустая
# очередь заканчивалась бы исключением таймаута сокета.
_POP_TIMEOUT = 1


def _request_for(base_url: str) -> Request:
    """Request, у которого base_url — публичный адрес, с которого пришёл юзер.

    Из него собираются stream_url треков (ytdlp/soundcloud), поэтому адрес
    должен быть тем же, что видит клиент, а не внутренним адресом контейнера.
    """
    parts = urlsplit(base_url or "http://localhost:8000")
    host = parts.netloc or "localhost:8000"
    port = parts.port or (443 if parts.scheme == "https" else 80)
    return Request(
        {
            "type": "http",
            "method": "GET",
            "scheme": parts.scheme or "http",
            "server": (parts.hostname or "localhost", port),
            "path": "/api/recommendations/flow",
            "root_path": "",
            "query_string": b"",
            "headers": [(b"host", host.encode())],
        }
    )


def _client_hour(meta: dict) -> Optional[int]:
    offset = meta.get("hour_offset")
    if not isinstance(offset, int):
        return None
    return (datetime.now(timezone.utc).hour + offset) % 24


# Один юзер — один расчёт за раз: периодический проход мог поставить в очередь
# юзера, чью порцию по выдаче уже считал другой воркер (2026-10-13 на проде:
# user=1 дважды параллельно). Второй ждёт первого и видит готовую порцию.
_user_locks: dict = {}


def _is_current(payload, context: str, limit: int, signal_at: float = 0.0) -> bool:
    """Готовая порция посчитана под эту историю, после последнего сигнала
    юзера и ещё не просит пересчёта."""
    if not isinstance(payload, dict):
        return False
    created = float(payload.get("created") or 0)
    return (
        payload.get("context") == context
        and payload.get("limit") == limit
        and created > signal_at
        and time.time() - created < REFRESH_AFTER
    )


async def precompute_user(user_id: int, session_factory=SessionLocal) -> bool:
    """Считает следующую порцию юзера и кладёт её в flow:ready. True — готово."""
    return await _precompute(user_id, session_factory) in ("computed", "current")


async def _precompute(user_id: int, session_factory=SessionLocal) -> str:
    # По loop: тесты гоняют каждый asyncio.run в своём (как flow._live_semaphore).
    key = (id(asyncio.get_running_loop()), user_id)
    lock = _user_locks.setdefault(key, asyncio.Lock())
    async with lock:
        return await _precompute_unlocked(user_id, session_factory)


async def _precompute_unlocked(user_id: int, session_factory) -> str:
    meta = await get_cache_async(flow._pc_meta_key(user_id)) or {}
    if not isinstance(meta, dict):
        meta = {}
    limit = int(meta.get("limit") or DEFAULT_LIMIT)
    # Своей меты нет (вернулся после перерыва) — последний публичный адрес;
    # выдача всё равно переписывает stream_url под адрес запроса.
    base_url = (
        meta.get("base_url")
        or await get_cache_async(flow._PC_BASE_URL)
        or os.getenv("FLOW_PUBLIC_BASE_URL", "")
    )
    delivered_at = meta.get("at")
    listening = (
        isinstance(delivered_at, (int, float)) and time.time() - delivered_at < MATCH_WINDOW
    )
    db = session_factory()
    try:
        user = db.get(User, user_id)
        if user is None or not user.is_active:
            return "inactive"
        history = await flow._load_flow_history(db, user_id)
        current, signal_at = await asyncio.gather(
            get_cache_async(flow._ready_key(user_id)),
            get_cache_async(flow_signal_key(user_id)),
        )
        if not isinstance(signal_at, (int, float)):
            signal_at = 0.0
        if _is_current(current, flow._ranking_context(user_id, history), limit, signal_at):
            return "current"
        # Скипы до этого момента расчёт прочтёт из БД — серия считается заново.
        await asyncio.to_thread(redis_client.delete, flow_skips_key(user_id))
        exclude = await asyncio.to_thread(flow._precompute_exclude, db, history)
        payload = await flow._compute_flow(
            _request_for(base_url),
            Response(),
            limit,
            exclude,
            _client_hour(meta),
            user,
            db,
            mode="precompute",
            schedule_matches=listening,
        )
    finally:
        db.close()
    if not isinstance(payload, dict) or not payload.get("items"):
        return "empty"
    await set_cache_async(flow._ready_key(user_id), payload, expire=flow._READY_TTL)
    return "computed"


def _pop_job() -> Optional[int]:
    item = redis_client.blpop([flow._PC_QUEUE], timeout=_POP_TIMEOUT)
    if not item:
        return None
    user_id = int(item[1])
    # Снимаем отметку ДО расчёта: новая выдача за время расчёта должна снова
    # поставить юзера — его история к тому моменту уже другая.
    redis_client.srem(flow._PC_QUEUED, user_id)
    return user_id


async def _worker(index: int) -> None:
    while True:
        try:
            user_id = await asyncio.to_thread(_pop_job)
        except Exception:  # noqa: BLE001 — Redis недоступен: подождать и снова
            logger.warning("flow-warmer: queue read failed", exc_info=True)
            await asyncio.sleep(2)
            continue
        if user_id is None:
            continue
        started = time.monotonic()
        try:
            state = await _precompute(user_id)
        except Exception:  # noqa: BLE001 — один юзер не должен ронять воркер
            logger.exception("flow-warmer: precompute failed user=%s", user_id)
            continue
        logger.info(
            "flow-warmer: user=%s %s %.1fs worker=%d",
            user_id, state, time.monotonic() - started, index,
        )


def _recent_flow_users(session_factory=SessionLocal) -> set:
    """Получавшие поток за ACTIVE_HOURS — по показам (индекс по shown_at)."""
    since = datetime.now(timezone.utc) - timedelta(hours=ACTIVE_HOURS)
    db = session_factory()
    try:
        rows = db.execute(
            select(recommendation_impressions.c.user_id)
            .where(
                recommendation_impressions.c.surface == "flow",
                recommendation_impressions.c.shown_at >= since,
            )
            .group_by(recommendation_impressions.c.user_id)
            .order_by(func.max(recommendation_impressions.c.shown_at).desc())
            .limit(MAX_USERS)
        ).scalars().all()
    finally:
        db.close()
    return set(rows)


def _stale_active_users(session_factory=SessionLocal) -> list:
    """Активные в потоке юзеры, чья готовая порция устарела или её нет."""
    users = _recent_flow_users(session_factory)
    for key in redis_client.scan_iter(match="flow:pc:meta:*", count=500):
        if isinstance(key, bytes):
            key = key.decode()
        try:
            users.add(int(key.rsplit(":", 1)[1]))
        except ValueError:
            continue
    stale = []
    for user_id in users:
        ttl = redis_client.ttl(flow._ready_key(user_id))
        age = flow._READY_TTL - ttl if ttl and ttl > 0 else None
        if age is None or age > REFRESH_AFTER:
            stale.append(user_id)
    return stale


def _enqueue(user_ids: list) -> int:
    added = 0
    for user_id in user_ids:
        if redis_client.sadd(flow._PC_QUEUED, user_id):
            redis_client.rpush(flow._PC_QUEUE, user_id)
            added += 1
    return added


def _pop_due_signals() -> list:
    """Юзеры, чей отложенный пересчёт по сигналу созрел; снимаются с отложки."""
    due = redis_client.zrangebyscore(FLOW_PC_DELAYED, "-inf", time.time(), start=0, num=100)
    users = []
    for member in due:
        # ZREM — отметка «забрал»: при нескольких процессах юзер уйдёт один раз.
        if redis_client.zrem(FLOW_PC_DELAYED, member):
            users.append(int(member))
    return users


async def _signal_loop() -> None:
    while True:
        try:
            users = await asyncio.to_thread(_pop_due_signals)
            if users:
                added = await asyncio.to_thread(_enqueue, users)
                logger.info("flow-warmer: signal queued %d users", added)
        except Exception:  # noqa: BLE001
            logger.warning("flow-warmer: signal scan failed", exc_info=True)
        await asyncio.sleep(SIGNAL_POLL)


async def _refresh_loop() -> None:
    while True:
        try:
            stale = await asyncio.to_thread(_stale_active_users)
            added = await asyncio.to_thread(_enqueue, stale)
            if added:
                logger.info("flow-warmer: refresh queued %d users", added)
        except Exception:  # noqa: BLE001
            logger.warning("flow-warmer: refresh scan failed", exc_info=True)
        await asyncio.sleep(SCAN_EVERY)


async def _run() -> None:
    asyncio.get_running_loop().set_default_executor(
        ThreadPoolExecutor(max_workers=THREADS, thread_name_prefix="flow-warmer")
    )
    logger.info(
        "flow-warmer: concurrency=%d refresh_after=%ds scan_every=%ds",
        CONCURRENCY, REFRESH_AFTER, SCAN_EVERY,
    )
    await asyncio.gather(
        *(_worker(index) for index in range(CONCURRENCY)),
        _refresh_loop(),
        _signal_loop(),
    )


def main() -> None:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    try:
        os.nice(NICE)
    except OSError:
        logger.warning("flow-warmer: could not lower priority")
    asyncio.run(_run())


if __name__ == "__main__":
    main()
