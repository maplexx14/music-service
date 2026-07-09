import asyncio
import base64
import binascii
import logging
import re
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query, Request

from app.cache import get_cache, set_cache
from app.routers.ytdlp import (
    TrackUnavailable,
    _cached_file,
    cached_ydl,
    clean_title,
    stream_cached_audio,
)
from app.schemas import ExternalTrackResponse

logger = logging.getLogger(__name__)

router = APIRouter()

# Резолв SoundCloud идёт через yt-dlp (тот же движок, что и YouTube Music).
# Отдельного SDK/ключа не нужно — yt-dlp сам добывает client_id.

# googlevideo-аналог у SoundCloud тоже живёт ограниченно — кэшируем прямой URL.
_RESOLVE_TTL = 3 * 3600
_UNAVAILABLE_TTL = 600


def _artist(entry: dict) -> str:
    artists = entry.get("artists") or []
    name = ", ".join(a for a in artists if a).strip()
    return name or (entry.get("uploader") or "Unknown Artist")


def _thumb(entry: dict) -> Optional[str]:
    thumbs = entry.get("thumbnails") or []
    if thumbs:
        return thumbs[-1].get("url")
    return entry.get("thumbnail")


def _encode_token(track_id: str, permalink: str) -> str:
    """Кладёт id и permalink в безопасный для URL токен.

    Для резолва yt-dlp нужен permalink (в нём есть слуг пользователя), а для
    имени кэш-файла — стабильный числовой id. Упаковываем оба в один токен пути.
    """
    raw = f"{track_id}|{permalink}".encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _decode_token(token: str) -> tuple[str, str]:
    pad = "=" * (-len(token) % 4)
    try:
        raw = base64.urlsafe_b64decode(token + pad).decode("utf-8")
        track_id, permalink = raw.split("|", 1)
    except (binascii.Error, ValueError, UnicodeDecodeError) as exc:
        raise HTTPException(status_code=400, detail="Некорректный id") from exc
    if not track_id.isdigit() or not permalink.startswith("https://soundcloud.com/"):
        raise HTTPException(status_code=400, detail="Некорректный id")
    return track_id, permalink


def _normalize(request: Request, entry: dict) -> Optional[ExternalTrackResponse]:
    track_id = entry.get("id")
    permalink = entry.get("webpage_url") or entry.get("url")
    # Резолвим строго по permalink на soundcloud.com — только его yt-dlp
    # надёжно отдаёт SoundcloudIE (api-ссылка уходит в generic extractor).
    if not track_id or not permalink or "soundcloud.com/" not in permalink:
        return None
    if not str(track_id).isdigit():
        return None

    base_url = str(request.base_url).rstrip("/")
    token = _encode_token(str(track_id), permalink)
    return ExternalTrackResponse(
        id=f"soundcloud:{track_id}",
        source="soundcloud",
        external_id=str(track_id),
        title=clean_title(entry.get("title") or "Unknown"),
        artist=_artist(entry),
        album=None,
        duration=int(entry.get("duration") or 0),
        cover_url=_thumb(entry),
        stream_url=f"{base_url}/api/soundcloud/stream/{token}",
        download_url=None,
        download_allowed=False,
    )


def entry_to_import(request: Request, entry: dict) -> Optional["ExternalTrackImport"]:
    """yt-dlp entry (из поиска/плейлиста/профиля) → ExternalTrackImport.

    Нативная материализация SoundCloud-трека: тот же токен-URL, что и в поиске.
    Используется импортером. Возвращает None, если entry не резолвится в трек.
    """
    from app.schemas import ExternalTrackImport

    track = _normalize(request, entry)
    if track is None:
        return None
    return ExternalTrackImport(
        source=track.source,
        external_id=track.external_id,
        title=track.title,
        artist=track.artist,
        album=track.album,
        duration=track.duration,
        cover_url=track.cover_url,
        stream_url=track.stream_url,
    )


def _search_blocking(q: str, limit: int) -> list:
    import yt_dlp

    opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": True,  # только метаданные, без резолва аудио (быстро)
        "skip_download": True,
        "noplaylist": True,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"scsearch{limit}:{q}", download=False)
    return (info or {}).get("entries") or []


async def search_soundcloud(
    request: Request,
    q: str,
    limit: int = 20,
) -> List[ExternalTrackResponse]:
    """Поиск по SoundCloud через yt-dlp. Возвращает source=soundcloud."""
    try:
        raw = await asyncio.to_thread(_search_blocking, q, limit)
    except Exception:  # noqa: BLE001 — нет сети / yt-dlp не установлен
        logger.exception("SoundCloud search failed")
        return []

    results: List[ExternalTrackResponse] = []
    for entry in raw:
        track = _normalize(request, entry)
        if track:
            results.append(track)
        if len(results) >= limit:
            break
    return results


def _pick_progressive(info: dict) -> Optional[dict]:
    """Выбирает прогрессивный (http) аудио-формат.

    HLS-плейлисты (m3u8_native) наш стрим-прокси отдавать не умеет — берём
    только цельный http/https-файл, предпочитая больший битрейт и mp3/m4a.
    """
    formats = info.get("formats") or []
    progressive = [
        f
        for f in formats
        if f.get("acodec") not in (None, "none")
        and f.get("url")
        and f.get("protocol") in ("http", "https")
    ]
    if not progressive:
        return None
    progressive.sort(
        key=lambda f: (f.get("abr") or 0, 1 if f.get("ext") in ("mp3", "m4a") else 0),
        reverse=True,
    )
    return progressive[0]


def _resolve_blocking(permalink: str) -> tuple[str, str, Optional[int]]:
    import yt_dlp

    # Переиспользуем YoutubeDL в рамках потока — конструктор грузит реестр
    # экстракторов заново на каждый вызов, это заметная накладная трата
    # (см. ytdlp.cached_ydl).
    ydl = cached_ydl(
        "soundcloud",
        {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "noplaylist": True,
            # См. ytdlp._extract_with_clients: без format дефолтный селектор
            # может не смэтчиться и упасть с "Requested format is not
            # available" ещё до того, как _pick_progressive выберет формат.
            "format": "bestaudio/best",
        },
    )
    try:
        info = ydl.extract_info(permalink, download=False)
    except yt_dlp.utils.DownloadError as exc:
        raise RuntimeError(str(exc)) from exc

    fmt = _pick_progressive(info or {})
    if not fmt:
        raise RuntimeError("нет прогрессивного аудио-формата")
    ext = "." + (fmt.get("ext") or "mp3").lower()
    size = fmt.get("filesize")
    total = int(size) if isinstance(size, (int, float)) and size > 0 else None
    return fmt["url"], ext, total


async def _resolve_cached(
    track_id: str, permalink: str, force: bool = False
) -> tuple[str, str, Optional[int], bool]:
    """Резолв прямого URL с кэшем в Redis. Кидает TrackUnavailable при неудаче.

    Четвёртый элемент — ``fresh`` (см. аналогичное поле в ytdlp._resolve_cached).
    """
    key = f"soundcloud:resolve:{track_id}"
    cached = None if force else get_cache(key)
    if cached:
        if cached.get("unavailable"):
            raise TrackUnavailable(track_id)
        if cached.get("url"):
            return cached["url"], cached.get("ext", ".mp3"), cached.get("total"), False

    try:
        url, ext, total = await asyncio.to_thread(_resolve_blocking, permalink)
    except Exception as exc:  # noqa: BLE001
        set_cache(key, {"unavailable": True}, expire=_UNAVAILABLE_TTL)
        raise TrackUnavailable(track_id) from exc

    set_cache(key, {"url": url, "ext": ext, "total": total}, expire=_RESOLVE_TTL)
    return url, ext, total, True


@router.get("/search", response_model=List[ExternalTrackResponse])
async def search_endpoint(
    request: Request,
    q: str = Query(..., min_length=1),
    limit: int = Query(20, ge=1, le=50),
):
    return await search_soundcloud(request, q, limit)


@router.get("/stream/{token}")
async def stream_soundcloud(token: str, request: Request):
    track_id, permalink = _decode_token(token)
    return await stream_cached_audio(
        request,
        f"sc{track_id}",
        lambda force: _resolve_cached(track_id, permalink, force=force),
    )


@router.post("/prefetch/{token}")
async def prefetch_soundcloud(token: str):
    """Заранее резолвит URL следующего трека (кладёт в Redis)."""
    track_id, permalink = _decode_token(token)
    if _cached_file(f"sc{track_id}"):
        return {"status": "cached"}
    try:
        await _resolve_cached(track_id, permalink)
    except TrackUnavailable:
        return {"status": "unavailable"}
    except Exception:  # noqa: BLE001
        return {"status": "error"}
    return {"status": "ready"}
