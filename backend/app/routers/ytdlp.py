import asyncio
import logging
import re
from typing import List, Optional

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from app.schemas import ExternalTrackResponse

logger = logging.getLogger(__name__)

router = APIRouter()

# ytmusicapi/yt-dlp — опциональные зависимости. Если их нет, провайдер тихо
# отключается (search вернёт []), чтобы не ронять весь агрегатор.
try:
    from ytmusicapi import YTMusic

    _ytmusic: Optional["YTMusic"] = YTMusic()
except Exception:  # noqa: BLE001 — библиотека может быть не установлена / без сети
    _ytmusic = None
    logger.warning("ytmusicapi недоступен — провайдер YouTube Music отключён")

MEDIA_TYPES = {
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".opus": "audio/ogg",
    ".ogg": "audio/ogg",
    ".webm": "audio/webm",
}

# Мусор в заголовках YouTube, который мешает и показу, и дедупу с Soulseek.
_JUNK = re.compile(
    r"\s*[\(\[]\s*(?:official\s*(?:music\s*)?video|official\s*audio|lyrics?|"
    r"lyric\s*video|audio|visualizer|hd|hq|4k|mv|m/v|remaster(?:ed)?"
    r"(?:\s*\d{4})?)\s*[\)\]]",
    re.IGNORECASE,
)


def clean_title(text: str) -> str:
    """Убирает '(Official Video)', '[Lyrics]' и т.п. из названия."""
    return _JUNK.sub("", text or "").strip(" -–—")


def _thumb(thumbnails: list) -> Optional[str]:
    if not thumbnails:
        return None
    # ytmusicapi отдаёт список по возрастанию размера — берём самую крупную.
    return thumbnails[-1].get("url")


def _duration_seconds(item: dict) -> int:
    secs = item.get("duration_seconds")
    if isinstance(secs, int) and secs > 0:
        return secs
    # Фолбэк: строка "3:45".
    dur = item.get("duration") or ""
    parts = [p for p in dur.split(":") if p.strip().isdigit()]
    total = 0
    for p in parts:
        total = total * 60 + int(p)
    return total


def _normalize(item: dict) -> Optional[ExternalTrackResponse]:
    video_id = item.get("videoId")
    if not video_id:
        return None

    title = clean_title(item.get("title") or "Unknown")
    artists = item.get("artists") or []
    artist = ", ".join(a.get("name", "") for a in artists if a.get("name")).strip()
    if not artist:
        artist = "Unknown Artist"

    album = None
    alb = item.get("album")
    if isinstance(alb, dict):
        album = alb.get("name")

    return ExternalTrackResponse(
        id=f"ytmusic:{video_id}",
        source="ytmusic",
        external_id=video_id,
        title=title,
        artist=artist,
        album=album,
        duration=_duration_seconds(item),
        cover_url=_thumb(item.get("thumbnails")),
        stream_url="",  # заполняется ниже, где доступен Request
        download_url=None,
        download_allowed=False,
    )


async def search_ytmusic(
    request: Request,
    q: str,
    limit: int = 20,
) -> List[ExternalTrackResponse]:
    """Поиск по YouTube Music. Возвращает ExternalTrackResponse (source=ytmusic)."""
    if _ytmusic is None:
        return []

    base_url = str(request.base_url).rstrip("/")
    try:
        # ytmusicapi синхронный — уводим в тредпул, чтобы не блокировать loop.
        raw = await asyncio.to_thread(
            _ytmusic.search, q, filter="songs", limit=limit
        )
    except Exception:  # noqa: BLE001
        logger.exception("YouTube Music search failed")
        return []

    results: List[ExternalTrackResponse] = []
    for item in raw or []:
        track = _normalize(item)
        if not track:
            continue
        track.stream_url = f"{base_url}/api/ytdlp/stream/{track.external_id}"
        results.append(track)
        if len(results) >= limit:
            break
    return results


@router.get("/search", response_model=List[ExternalTrackResponse])
async def search_endpoint(
    request: Request,
    q: str = Query(..., min_length=1),
    limit: int = Query(20, ge=1, le=50),
):
    return await search_ytmusic(request, q, limit)


def _pick_audio_format(info: dict) -> Optional[dict]:
    """Выбирает лучший аудио-only формат из info['formats'] вручную.

    Надёжнее строки 'bestaudio' — не падает с 'Requested format is not
    available', когда набор форматов у ролика нестандартный.
    """
    formats = info.get("formats") or []
    audio_only = [
        f
        for f in formats
        if f.get("acodec") not in (None, "none")
        and f.get("vcodec") in (None, "none")
        and f.get("url")
    ]
    if not audio_only:
        # Фолбэк: любой формат с аудио-дорожкой и прямым URL.
        audio_only = [
            f
            for f in formats
            if f.get("acodec") not in (None, "none") and f.get("url")
        ]
    if not audio_only:
        return None
    # Больше abr (аудио-битрейт) → лучше; при равенстве предпочитаем m4a.
    audio_only.sort(
        key=lambda f: (f.get("abr") or 0, 1 if f.get("ext") == "m4a" else 0),
        reverse=True,
    )
    return audio_only[0]


def _resolve_audio(video_id: str) -> tuple[str, str]:
    """Через yt-dlp достаёт прямой URL аудио и его расширение. Блокирующая."""
    import yt_dlp

    url = f"https://music.youtube.com/watch?v={video_id}"
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "skip_download": True,
        # Разные клиенты отдают разные наборы форматов; перебор повышает шанс
        # получить аудио-only поток без ошибки формата.
        "extractor_args": {"youtube": {"player_client": ["ios", "android", "web"]}},
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)

    fmt = _pick_audio_format(info)
    if not fmt:
        raise RuntimeError("нет доступного аудио-формата")
    ext = "." + (fmt.get("ext") or "m4a").lower()
    return fmt["url"], ext


@router.get("/stream/{video_id}")
async def stream_ytmusic(video_id: str):
    if _ytmusic is None:
        raise HTTPException(status_code=503, detail="YouTube Music не настроен")
    if not re.fullmatch(r"[A-Za-z0-9_-]{5,20}", video_id):
        raise HTTPException(status_code=400, detail="Некорректный id")

    try:
        direct_url, ext = await asyncio.to_thread(_resolve_audio, video_id)
    except Exception:  # noqa: BLE001
        logger.exception("yt-dlp resolve failed: %s", video_id)
        raise HTTPException(status_code=502, detail="Не удалось получить аудио")

    media_type = MEDIA_TYPES.get(ext, "audio/mp4")

    async def proxy():
        # Проксируем байты googlevideo напрямую — без перекодирования/ffmpeg.
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream("GET", direct_url) as upstream:
                if upstream.status_code >= 400:
                    logger.warning("upstream %s for %s", upstream.status_code, video_id)
                    return
                async for chunk in upstream.aiter_bytes(chunk_size=65536):
                    yield chunk

    return StreamingResponse(
        proxy(),
        media_type=media_type,
        headers={"Accept-Ranges": "none", "Cache-Control": "no-store"},
    )
