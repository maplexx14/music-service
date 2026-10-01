"""Мейнстрим-фильтр волны: у нелюбимых артистов — только их хиты.

Цель продукта: подходящим артистам давать их известные треки, а глубокий
каталог — только любимым (см. ``flow._DEEP_CATALOG_MIN_TRACKS``). Телеметрия
(2026-10-01, 30 дней) это подтверждала: кандидаты без признаков популярности
принимались в 0.5% случаев при 76–88% «плохо», с популярностью от 0.4 — в 17–26%.

«Хит» — трек из первой ``TOP_TRACKS`` артиста по Last.fm, и сам артист
известен: не меньше ``MIN_ARTIST_LISTENERS`` слушателей. Своих счётчиков на это
нет: у ``local`` и у части радио play_count пуст, и «0» значил одновременно
«непопулярный» и «неизвестно».

Ответ по артисту кэшируется на неделю (известность и топ меняются медленно).
Запросы, не успевшие к сроку, продолжают работать в фоне и греют кэш; пока
ответа нет, трек считается не доказанным хитом.
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Iterable, Optional

import httpx

from app.artist_utils import artist_key
from app.cache import get_cache_async, set_cache_async

logger = logging.getLogger(__name__)

MIN_ARTIST_LISTENERS = 50_000
TOP_TRACKS = 10
_API_URL = "https://ws.audioscrobbler.com/2.0/"
_CACHE_KEY = "mainstream:artist:v1:{}"
_SIMILAR_KEY = "mainstream:similar:v1:{}"
SIMILAR_LIMIT = 30
_TTL = 7 * 24 * 60 * 60
# Last.fm не знает артиста — это тоже ответ («не известен»), но имя могло прийти
# с опечаткой провайдера, так что держим его меньше.
_UNKNOWN_TTL = 24 * 60 * 60
# Last.fm просит не больше ~5 запросов в секунду с IP; на артиста их два.
_CONCURRENCY = 3
_NOT_FOUND = 6
_TIMEOUT = 6.0

# Семафор и задачи в полёте привязаны к своему event loop (тесты гоняют
# несколько loop'ов в одном процессе).
_semaphores: dict[int, asyncio.Semaphore] = {}
_inflight: dict[tuple[int, str], asyncio.Task] = {}


def available() -> bool:
    return bool(os.getenv("LASTFM_API_KEY"))


def _sem() -> asyncio.Semaphore:
    loop_id = id(asyncio.get_running_loop())
    semaphore = _semaphores.get(loop_id)
    if semaphore is None:
        semaphore = _semaphores[loop_id] = asyncio.Semaphore(_CONCURRENCY)
    return semaphore


async def _call(client: httpx.AsyncClient, method: str, artist: str, **params) -> dict:
    response = await client.get(
        _API_URL,
        params={
            "method": method,
            "artist": artist,
            "api_key": os.getenv("LASTFM_API_KEY", ""),
            "format": "json",
            "autocorrect": 1,
            **params,
        },
    )
    response.raise_for_status()
    return response.json()


async def _fetch(artist: str) -> Optional[dict]:
    """{"listeners", "top"} из Last.fm и в кэш; None — сеть не ответила."""
    key = _CACHE_KEY.format(artist_key(artist))
    try:
        async with _sem():
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                info, top = await asyncio.gather(
                    _call(client, "artist.getinfo", artist),
                    _call(client, "artist.gettoptracks", artist, limit=TOP_TRACKS),
                )
    except Exception as exc:  # noqa: BLE001 — внешний сервис не должен ронять волну
        logger.info("mainstream lookup failed artist=%r: %s", artist, exc)
        return None
    errors = {payload.get("error") for payload in (info, top) if "error" in payload}
    if errors:
        if errors != {_NOT_FOUND}:
            # Лимит частоты, временный сбой, плохой ключ — это не ответ про
            # артиста, кэшировать нельзя.
            logger.info("mainstream lookup error artist=%r: %s", artist, sorted(errors))
            return None
        result = {"listeners": 0, "top": []}
        await set_cache_async(key, result, expire=_UNKNOWN_TTL)
        return result
    try:
        listeners = int((info.get("artist") or {}).get("stats", {}).get("listeners") or 0)
    except (TypeError, ValueError):
        listeners = 0
    tracks = (top.get("toptracks") or {}).get("track") or []
    if isinstance(tracks, dict):
        tracks = [tracks]
    result = {
        "listeners": listeners,
        "top": [str(t.get("name") or "") for t in tracks[:TOP_TRACKS] if t.get("name")],
    }
    await set_cache_async(key, result, expire=_TTL)
    return result


def _task(artist: str) -> asyncio.Task:
    key = (id(asyncio.get_running_loop()), artist_key(artist))
    task = _inflight.get(key)
    if task is None or task.done():
        task = asyncio.create_task(_fetch(artist))
        _inflight[key] = task
        task.add_done_callback(lambda _t, k=key: _inflight.pop(k, None))
    return task


async def artist_hits(artists: Iterable[str], timeout: float) -> dict[str, Optional[dict]]:
    """{artist_key: {"listeners", "top"} | None} для имён; None — ответа нет.

    Кэш читается сразу, остальное спрашивается параллельно не дольше
    ``timeout`` секунд. Неуспевшие запросы НЕ отменяются: они дописывают кэш,
    и следующая подгрузка волны уже их видит.
    """
    names = {artist_key(a): a for a in artists if artist_key(a)}
    result: dict[str, Optional[dict]] = {}
    missing = {}
    for key, name in names.items():
        cached = await get_cache_async(_CACHE_KEY.format(key))
        if isinstance(cached, dict):
            result[key] = cached
        else:
            missing[key] = name
    if not missing or not available():
        return {**{key: None for key in missing}, **result}
    tasks = {key: _task(name) for key, name in missing.items()}
    if timeout > 0:
        await asyncio.wait(set(tasks.values()), timeout=timeout)
    for key, task in tasks.items():
        if task.done() and not task.cancelled() and task.exception() is None:
            result[key] = task.result()
        else:
            result[key] = None
    return result


async def similar_artists(artist: str) -> list[str]:
    """Соседи артиста по Last.fm (artist.getSimilar), самые похожие первыми.

    Кэш на ``_TTL``: граф похожести меняется медленно. Ошибка или нет ключа —
    пустой список без кэша.
    """
    key = _SIMILAR_KEY.format(artist_key(artist))
    cached = await get_cache_async(key)
    if isinstance(cached, list):
        return cached
    if not available():
        return []
    try:
        async with _sem():
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                payload = await _call(
                    client, "artist.getsimilar", artist, limit=SIMILAR_LIMIT
                )
    except Exception as exc:  # noqa: BLE001 — внешний сервис не должен ронять волну
        logger.info("mainstream similar failed artist=%r: %s", artist, exc)
        return []
    if "error" in payload:
        if payload.get("error") == _NOT_FOUND:
            await set_cache_async(key, [], expire=_UNKNOWN_TTL)
        return []
    found = (payload.get("similarartists") or {}).get("artist") or []
    if isinstance(found, dict):
        found = [found]
    names = [str(item.get("name") or "") for item in found if item.get("name")]
    await set_cache_async(key, names, expire=_TTL if names else _UNKNOWN_TTL)
    return names


def is_famous(info: Optional[dict]) -> bool:
    return bool(info) and int(info.get("listeners") or 0) >= MIN_ARTIST_LISTENERS


def is_hit(info: Optional[dict], title_key: str, norm_title) -> bool:
    """Трек — хит известного артиста? ``norm_title`` нормализует название из топа
    так же, как ``title_key`` у кандидата."""
    if not is_famous(info):
        return False
    if not title_key:
        return False
    for name in info.get("top") or []:
        top_key = norm_title(name)
        if not top_key:
            continue
        if top_key == title_key:
            return True
        # «Track (Remastered 2011)» и подобные хвосты у провайдера и Last.fm
        # чистятся по-разному; короткие названия префиксом не сравниваем.
        shorter, longer = sorted((top_key, title_key), key=len)
        if len(shorter) >= 5 and longer.startswith(shorter):
            return True
    return False


def gate(
    items: list,
    *,
    infos: dict,
    exempt,
    artist_of,
    title_of,
    norm_title,
    limit: int,
    popularity,
) -> tuple[list, dict[int, bool]]:
    """Оставляет хиты; ``exempt`` (лайки, любимые артисты) проходит без проверки.

    ``infos`` — ответ ``artist_hits`` по ключам ``artist_of(item)``. Если
    прошедших меньше ``limit``, добирает отсеянных по убыванию ``popularity``:
    пустая выдача хуже нарушения правила. Возвращает (оставленные в исходном
    порядке, {id(item): хит ли}) — второе только для проверенных, в телеметрию.
    """
    hit_by_item: dict[int, bool] = {}
    kept, reserve = [], []
    for item in items:
        if exempt(item):
            kept.append(item)
            continue
        hit = is_hit(infos.get(artist_of(item)), title_of(item), norm_title)
        hit_by_item[id(item)] = hit
        (kept if hit else reserve).append(item)
    if len(kept) < limit and reserve:
        reserve.sort(key=lambda item: popularity(item) or 0, reverse=True)
        kept.extend(reserve[: limit - len(kept)])
    return kept, hit_by_item
