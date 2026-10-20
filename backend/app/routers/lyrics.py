"""Тексты песен с lrclib через бэкенд.

Раньше браузер ходил на lrclib.net сам. lrclib стоит за Cloudflare, который
провайдеры в РФ душат, а фолбэк-поиск отдаёт ~0.5 МБ (полные тексты всех
версий песни) — на домашнем интернете без VPN текст искался секундами.
С сервера тот же поиск занимает доли секунды, клиенту уходит только
выбранный текст, а Redis-кэш делает повторный запрос мгновенным для всех.
"""
import asyncio
import logging
import re

import httpx
from fastapi import APIRouter, HTTPException, Query, Request

from app.cache import get_cache, set_cache
from app.rate_limit import limiter

logger = logging.getLogger(__name__)

router = APIRouter()

_LRCLIB = "https://lrclib.net/api"
_TIMEOUT = httpx.Timeout(8.0, connect=4.0)
# lrclib просит представляться. С дефолтным python-httpx Cloudflare перед ним
# отвечал 429 уже на 4–5-м запросе подряд (прод, 2026-10-20: 17% /api/lyrics
# уходили в 502), с UA приложения на той же серии 429 нет.
_HEADERS = {"User-Agent": "bolt-music/1.0 (https://boltmusic.lat)"}
# Пауза перед повтором после 429/5xx: сразу повторять лимит смысла нет.
_RETRY_DELAY_SEC = 0.5
# Расхождение длительности (сек), при котором синхронный текст из поиска ещё
# считается той же записью: live- и радио-версии расходятся по таймингам на
# секунды. /api/get сверяет длительность сам, ±2 с.
SYNC_DURATION_TOLERANCE = 3
# Найденный текст не меняется; ненайденный могут добавить на lrclib позже.
FOUND_TTL = 30 * 24 * 3600
MISSING_TTL = 24 * 3600


def _strip_timestamps(lrc: str) -> str:
    return "\n".join(
        re.sub(r"^(\[\d{2}:\d{2}\.\d{2,3}\])+", "", line).strip() for line in lrc.split("\n")
    )


def _pick_from_search(results, duration: int) -> dict:
    if not isinstance(results, list):
        return {}
    entries = [r for r in results if isinstance(r, dict)]

    def same_recording(entry) -> bool:
        try:
            length = float(entry.get("duration") or 0)
        except (TypeError, ValueError):
            return False
        return duration > 0 and abs(length - duration) <= SYNC_DURATION_TOLERANCE

    for entry in entries:
        if entry.get("syncedLyrics") and same_recording(entry):
            return {"synced": entry["syncedLyrics"]}
    # Длительность не совпала — текст без подсветки: лучше честно без
    # синхронизации, чем со сдвигом.
    for entry in entries:
        if entry.get("plainLyrics"):
            return {"plain": entry["plainLyrics"]}
        if entry.get("syncedLyrics"):
            return {"plain": _strip_timestamps(entry["syncedLyrics"])}
    return {}


async def _fetch(client: httpx.AsyncClient, path: str, params: dict) -> httpx.Response:
    # lrclib время от времени отвечает 503 на ровном месте, а на всплеске —
    # 429; второй запрос после короткой паузы обычно проходит.
    response = await client.get(f"{_LRCLIB}/{path}", params=params)
    if response.status_code >= 500 or response.status_code == 429:
        await asyncio.sleep(_RETRY_DELAY_SEC)
        response = await client.get(f"{_LRCLIB}/{path}", params=params)
    return response


async def _lookup(artist: str, title: str, duration: int) -> dict:
    async with httpx.AsyncClient(timeout=_TIMEOUT, headers=_HEADERS) as client:
        params = {"artist_name": artist, "track_name": title}
        if duration > 0:
            params["duration"] = str(duration)
        response = await _fetch(client, "get", params)
        if response.status_code == 200:
            data = response.json()
            if isinstance(data, dict) and data.get("syncedLyrics"):
                return {"synced": data["syncedLyrics"]}

        response = await _fetch(client, "search", {"q": f"{artist} {title}"})
        response.raise_for_status()
        return _pick_from_search(response.json(), duration)


@router.get("")
@limiter.limit("120/minute")
async def get_lyrics(
    request: Request,
    artist: str = Query(..., min_length=1, max_length=300),
    title: str = Query(..., min_length=1, max_length=300),
    duration: int = Query(0, ge=0, le=24 * 3600),
):
    """Текст трека: {"synced": LRC | null, "plain": str | null}."""
    key = f"lyrics:v1:{artist.strip().lower()}|{title.strip().lower()}|{duration}"
    cached = get_cache(key)
    if cached is not None:
        return cached
    try:
        found = await _lookup(artist.strip(), title.strip(), duration)
    except (httpx.HTTPError, ValueError) as error:
        logger.info("lyrics: lrclib lookup failed for %s — %s: %s", artist, title, error)
        raise HTTPException(status_code=502, detail="lyrics provider unavailable")
    result = {"synced": found.get("synced"), "plain": found.get("plain")}
    set_cache(key, result, expire=FOUND_TTL if (result["synced"] or result["plain"]) else MISSING_TTL)
    return result
