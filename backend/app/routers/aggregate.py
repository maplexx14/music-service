import asyncio
import logging
import re
from typing import List

from fastapi import APIRouter, Query, Request

from app.routers import soulseek, soundcloud, ytdlp
from app.routers.ytdlp import clean_title
from app.schemas import ExternalPlaylistResponse, ExternalTrackResponse

logger = logging.getLogger(__name__)

router = APIRouter()

# Приоритет источников при дедупе одинаковых треков.
# В гибриде по умолчанию показываем быстрый ytmusic, но lossless (soulseek)
# считаем «лучше» и оставляем именно его, если нашёлся дубль.
_SOURCE_RANK = {"soulseek": 3, "ytmusic": 2, "soundcloud": 1}


def _dedup_key(track: ExternalTrackResponse) -> tuple:
    def norm(s: str) -> str:
        s = clean_title(s).lower()
        s = re.sub(r"\bfeat\.?\b.*$", "", s)  # убрать "feat. ..."
        s = re.sub(r"[^\w\s]", "", s)          # пунктуация
        s = re.sub(r"\s+", " ", s).strip()
        return s

    return (norm(track.artist), norm(track.title))


@router.get("/external", response_model=List[ExternalTrackResponse])
async def search_external(
    request: Request,
    q: str = Query(..., min_length=1),
    limit: int = Query(30, ge=1, le=60),
):
    """Единый поиск по внешним источникам (YouTube Music + SoundCloud).

    Soulseek отключён (медленный поллинг slskd подвешивал ответ) — вернуть
    строку в gather, когда понадобится lossless.
    """
    per_source = max(10, limit)

    results = await asyncio.gather(
        ytdlp.search_ytmusic(request, q, limit=per_source),
        soundcloud.search_soundcloud(request, q, limit=per_source),
        return_exceptions=True,
    )

    tracks: List[ExternalTrackResponse] = []
    for res in results:
        if isinstance(res, Exception):
            logger.warning("external provider failed: %s", res)
            continue
        tracks.extend(res)

    # Дедуп: при коллизии оставляем источник с более высоким рангом.
    best: dict = {}
    for t in tracks:
        key = _dedup_key(t)
        prev = best.get(key)
        if prev is None or _SOURCE_RANK.get(t.source, 0) > _SOURCE_RANK.get(prev.source, 0):
            best[key] = t

    merged = list(best.values())
    # Сортировка: сначала быстрые ytmusic (мгновенный старт), lossless — следом.
    merged.sort(key=lambda t: _SOURCE_RANK.get(t.source, 0))
    return merged[:limit]


@router.get("/external/playlists", response_model=List[ExternalPlaylistResponse])
async def search_external_playlists(
    q: str = Query(..., min_length=1),
    limit: int = Query(10, ge=1, le=30),
):
    """Поиск плейлистов во внешних источниках (пока только SoundCloud)."""
    try:
        return await soundcloud.search_soundcloud_playlists(q, limit)
    except Exception:  # noqa: BLE001
        logger.exception("external playlist search failed")
        return []
