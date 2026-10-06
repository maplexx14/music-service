"""Карточки артистов для выбора любимых: фото, число фанатов, похожие.

Источник — публичный api.deezer.com (без ARL): у него на артиста есть и
квадратное фото, и ``nb_fan``, и граф похожих (``/artist/{id}/related``) с теми
же полями — одним запросом приходит всё, что рисует сетка онбординга. Last.fm
картинки артистов больше не отдаёт, а YouTube Music на каждого соседа просил
бы отдельный поиск.

Поиски идут через общий троттл deezer-роутера: публичный API пускает 50
запросов за 5 с с адреса, и онбординг не должен съедать квоту матчинга треков.
"""

import asyncio
import logging
import time
from typing import Iterable, List, Optional

from app.artist_utils import artist_key, same_artist
from app.cache import get_cache_async, set_cache_async
from app.routers import deezer

logger = logging.getLogger(__name__)

_CARD_TTL = 7 * 24 * 3600
_CARD_MISS_TTL = 6 * 3600
_RELATED_TTL = 7 * 24 * 3600
_RELATED_MISS_TTL = 3600
_MAX_RELATED = 20

# Идущие поиски карточек по ключу артиста. Одного артиста одновременно
# просят соседние пачки сетки, похожие и другие пользователи с теми же
# жанрами; лишний поиск — минус слот в общем троттле Deezer.
_inflight: dict = {}


def _card_key(name: str) -> str:
    return f"artist_card:v1:{artist_key(name)}"


def _related_key(deezer_id: int) -> str:
    return f"artist_related:v1:{deezer_id}"


def _card(item: dict) -> dict:
    return {
        "name": (item.get("name") or "").strip(),
        "cover_url": item.get("picture_big") or item.get("picture_xl") or None,
        "fans": int(item.get("nb_fan") or 0),
        "deezer_id": int(item.get("id") or 0) or None,
    }


async def _api_get(path: str, params: Optional[dict] = None) -> Optional[dict]:
    """GET к api.deezer.com под общим троттлом; None при сбое или квоте."""
    try:
        async with deezer._search_lock:
            delay = deezer._last_search + deezer._SEARCH_INTERVAL - time.monotonic()
            if delay > 0:
                await asyncio.sleep(delay)
            deezer._last_search = time.monotonic()
        r = await deezer._client.get(f"{deezer._API_URL}{path}", params=params)
        r.raise_for_status()
        data = r.json()
    except Exception as exc:  # noqa: BLE001 — внешний сервис, карточка без фото не беда
        logger.warning("deezer artist api failed: %s: %r", path, exc)
        return None
    if not isinstance(data, dict) or "data" not in data:
        # {"error": {...}} — квота/сбой, а не «ничего нет»: не кэшируем.
        logger.warning("deezer artist api error %s: %s", path, str(data)[:200])
        return None
    return data


async def artist_card(name: str) -> dict:
    """Карточка артиста по имени. Без совпадения — карточка с одним именем:
    подставлять первого попавшегося из поиска нельзя, это было бы чужое фото."""
    name = (name or "").strip()
    empty = {"name": name, "cover_url": None, "fans": 0, "deezer_id": None}
    if not name:
        return empty
    key = _card_key(name)
    cached = await get_cache_async(key)
    if isinstance(cached, dict):
        return {**cached, "name": name}

    task = _inflight.get(key)
    if task is None:
        task = asyncio.ensure_future(_search_card(name, key))
        _inflight[key] = task
        task.add_done_callback(lambda _t: _inflight.pop(key, None))
    card = await asyncio.shield(task)
    # Имя оставляем пользовательское: под ним артист уже лежит в выборе, а
    # другое написание («Zemfira» против «Земфира») выглядело бы как подмена.
    return {**(card or empty), "name": name}


async def _search_card(name: str, key: str) -> Optional[dict]:
    """Поиск карточки в Deezer; None — сбой, ответ не кэшируется."""
    data = await _api_get("/search/artist", {"q": name, "limit": 5})
    if data is None:
        return None
    found = next(
        (item for item in data.get("data") or [] if same_artist(item.get("name") or "", name)),
        None,
    )
    card = _card(found) if found else {"name": name, "cover_url": None, "fans": 0, "deezer_id": None}
    await set_cache_async(key, card, expire=_CARD_TTL if found else _CARD_MISS_TTL)
    return card


async def artist_cards(names: Iterable[str]) -> List[dict]:
    unique: List[str] = []
    seen = set()
    for raw in names:
        name = (raw or "").strip()
        if name and artist_key(name) not in seen:
            seen.add(artist_key(name))
            unique.append(name)
    return list(await asyncio.gather(*(artist_card(n) for n in unique)))


async def similar_cards(name: str, limit: int = 3, exclude: Iterable[str] = ()) -> List[dict]:
    """Похожие на артиста по графу Deezer, самые похожие первыми."""
    source = await artist_card(name)
    deezer_id = source.get("deezer_id")
    if not deezer_id:
        return []

    key = _related_key(deezer_id)
    related = await get_cache_async(key)
    if not isinstance(related, list):
        data = await _api_get(f"/artist/{deezer_id}/related", {"limit": _MAX_RELATED})
        if data is None:
            return []
        related = [_card(item) for item in data.get("data") or [] if item.get("name")]
        await set_cache_async(key, related, expire=_RELATED_TTL if related else _RELATED_MISS_TTL)
        # Соседи приходят уже с фото и фанатами — кладём их карточки в кэш,
        # чтобы следующий клик по соседу не искал его заново.
        await asyncio.gather(
            *(set_cache_async(_card_key(c["name"]), c, expire=_CARD_TTL) for c in related)
        )

    skip = {artist_key(n) for n in exclude} | {artist_key(name)}
    out: List[dict] = []
    for card in related:
        if artist_key(card["name"]) in skip or any(
            same_artist(card["name"], s) for s in skip
        ):
            continue
        out.append(card)
        if len(out) >= limit:
            break
    return out
