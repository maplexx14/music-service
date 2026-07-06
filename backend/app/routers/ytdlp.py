import asyncio
import glob
import logging
import os
import re
import tempfile
from typing import List, Optional

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from app.cache import get_cache, set_cache
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


# Наборы player-клиентов, которыми по очереди прикидываемся при резолве.
# "Video unavailable" часто зависит от клиента: то, что недоступно для web,
# нередко отдаётся tv/android_music/ios и наоборот. Перебираем, пока не выйдет.
_CLIENT_CANDIDATES = (
    ["ios", "android", "web"],
    ["tv", "web_safari"],
    ["android_music", "web_music"],
    ["mweb", "android"],
)


def _extract_with_clients(video_id: str, clients: List[str]) -> Optional[dict]:
    """Одна попытка резолва конкретным набором клиентов. None при неудаче."""
    import yt_dlp

    url = f"https://music.youtube.com/watch?v={video_id}"
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "skip_download": True,
        "extractor_args": {"youtube": {"player_client": clients}},
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            return ydl.extract_info(url, download=False)
    except yt_dlp.utils.DownloadError as exc:
        logger.info("resolve via %s failed for %s: %s", clients, video_id, exc)
        return None


def _resolve_audio(video_id: str) -> tuple[str, str, Optional[int]]:
    """Через yt-dlp достаёт прямой URL аудио, расширение и размер. Блокирующая.

    Перебирает наборы клиентов — повышает шанс обойти 'Video unavailable',
    которое часто специфично для клиента.
    """
    info = None
    for clients in _CLIENT_CANDIDATES:
        info = _extract_with_clients(video_id, clients)
        if info and _pick_audio_format(info):
            break
        info = None

    if info is None:
        raise RuntimeError("видео недоступно ни для одного из клиентов")

    fmt = _pick_audio_format(info)
    if not fmt:
        raise RuntimeError("нет доступного аудио-формата")
    ext = "." + (fmt.get("ext") or "m4a").lower()
    # Только ТОЧНЫЙ filesize годится для Content-Length; filesize_approx может
    # расходиться с реальным размером и ломает ответ ("content shorter than
    # Content-Length"). Если точного нет — вернём None и определим размер
    # пробным range-запросом к googlevideo (там размер точный).
    size = fmt.get("filesize")
    total = int(size) if isinstance(size, (int, float)) and size > 0 else None
    return fmt["url"], ext, total


# googlevideo-ссылки живут несколько часов; кэшируем результат резолва в Redis,
# чтобы не гонять медленный yt-dlp при перемотке, повторе и ретраях. TTL с
# запасом меньше реального срока жизни ссылки.
_RESOLVE_TTL = 3 * 3600
# Негативный кэш недоступных видео: не запускаем yt-dlp (4 попытки клиентов)
# заново на каждый ретрай браузера. Короткий TTL — вдруг видео вернётся.
_UNAVAILABLE_TTL = 600


class TrackUnavailable(Exception):
    """Видео недоступно (удалено/приватно/регион) — резолв невозможен."""


async def _resolve_cached(video_id: str) -> tuple[str, str, Optional[int]]:
    """Резолв прямого URL с кэшем в Redis.

    Кидает TrackUnavailable, если видео недоступно, иначе — исходное исключение.
    """
    key = f"ytdlp:resolve:v2:{video_id}"
    cached = get_cache(key)
    if cached:
        if cached.get("unavailable"):
            raise TrackUnavailable(video_id)
        if cached.get("url"):
            return cached["url"], cached.get("ext", ".m4a"), cached.get("total")

    try:
        url, ext, total = await asyncio.to_thread(_resolve_audio, video_id)
    except Exception as exc:  # noqa: BLE001
        # Видео недоступно всеми клиентами — помечаем негативным кэшем.
        set_cache(key, {"unavailable": True}, expire=_UNAVAILABLE_TTL)
        raise TrackUnavailable(video_id) from exc

    set_cache(key, {"url": url, "ext": ext, "total": total}, expire=_RESOLVE_TTL)
    return url, ext, total


# Размер сегмента при проксировании googlevideo. Длинный одиночный GET
# googlevideo часто троттлит и обрывает (RemoteProtocolError), поэтому тянем
# файл короткими range-запросами — каждый успевает завершиться целиком.
_SEGMENT = 1 << 20  # 1 MiB
_SEGMENT_RETRIES = 3
# Буфер чтения при отдаче кэш-файла с диска. Крупнее 64 KiB — меньше переходов
# в threadpool на каждый чанк при множестве одновременных стримов.
_FILE_CHUNK = 256 * 1024

# Дисковый кэш проигранных треков: раз скачав аудио с googlevideo, храним его
# локально и при повторном прослушивании отдаём с диска — без обращения к
# YouTube и повторного скачивания.
CACHE_DIR = os.getenv(
    "YTDLP_CACHE_DIR",
    os.path.join(os.path.dirname(__file__), "..", "..", "ytdlp_cache"),
)
CACHE_MAX_BYTES = int(os.getenv("YTDLP_CACHE_MAX_MB", "4096")) * 1024 * 1024
os.makedirs(CACHE_DIR, exist_ok=True)


def _cached_file(video_id: str) -> Optional[str]:
    """Путь к готовому кэш-файлу трека (любое расширение) или None."""
    for path in glob.glob(os.path.join(CACHE_DIR, f"{video_id}.*")):
        if not path.endswith(".part") and os.path.getsize(path) > 0:
            return path
    return None


def _enforce_cache_limit() -> None:
    """Простейший LRU по mtime: чистим самые старые файлы при переполнении."""
    try:
        files = [
            (p, os.path.getsize(p), os.path.getmtime(p))
            for p in glob.glob(os.path.join(CACHE_DIR, "*"))
            if not p.endswith(".part")
        ]
    except OSError:
        return
    total = sum(size for _, size, _ in files)
    if total <= CACHE_MAX_BYTES:
        return
    for path, size, _ in sorted(files, key=lambda f: f[2]):  # старые первыми
        try:
            os.remove(path)
        except OSError:
            continue
        total -= size
        if total <= CACHE_MAX_BYTES:
            break


def _serve_file(path: str, media_type: str, request: Request) -> StreamingResponse:
    """Отдаёт локальный файл с поддержкой Range (перемотка/докачка)."""
    size = os.path.getsize(path)
    has_range = bool(request.headers.get("range"))
    start, end = _parse_range(request.headers.get("range"), size)
    if end is None:
        end = size - 1
    end = min(end, size - 1)

    def gen():
        with open(path, "rb") as fh:
            fh.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = fh.read(min(_FILE_CHUNK, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    headers = {
        "Accept-Ranges": "bytes",
        # Кэш-файл неизменен для данного video_id — разрешаем браузеру кэшировать
        # (повторное прослушивание не бьёт по бэку вовсе).
        "Cache-Control": "public, max-age=86400",
        "Content-Length": str(end - start + 1),
    }
    status_code = 200
    if has_range:
        status_code = 206
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    return StreamingResponse(
        gen(), status_code=status_code, media_type=media_type, headers=headers
    )


def _parse_range(header: Optional[str], total: Optional[int]) -> tuple[int, Optional[int]]:
    """Парсит 'bytes=start-end' → (start, end|None). end включительный."""
    if not header:
        return 0, None
    m = re.fullmatch(r"bytes=(\d*)-(\d*)", header.strip())
    if not m:
        return 0, None
    start_s, end_s = m.group(1), m.group(2)
    if start_s == "":
        # suffix range: последние N байт
        if end_s == "" or total is None:
            return 0, None
        n = int(end_s)
        return max(0, total - n), total - 1
    start = int(start_s)
    end = int(end_s) if end_s else None
    return start, end


async def _probe_total(client: httpx.AsyncClient, url: str) -> Optional[int]:
    """Узнаёт полный размер файла через ранний range-запрос."""
    try:
        resp = await client.get(url, headers={"Range": "bytes=0-0"})
    except httpx.HTTPError:
        return None
    cr = resp.headers.get("content-range")  # 'bytes 0-0/12345'
    if cr and "/" in cr:
        tail = cr.rsplit("/", 1)[-1].strip()
        if tail.isdigit():
            return int(tail)
    return None


@router.get("/stream/{video_id}")
async def stream_ytmusic(video_id: str, request: Request):
    if _ytmusic is None:
        raise HTTPException(status_code=503, detail="YouTube Music не настроен")
    if not re.fullmatch(r"[A-Za-z0-9_-]{5,20}", video_id):
        raise HTTPException(status_code=400, detail="Некорректный id")

    # Уже качали этот трек — отдаём с диска, минуя yt-dlp и googlevideo.
    cached = _cached_file(video_id)
    if cached:
        ext = os.path.splitext(cached)[1].lower()
        return _serve_file(cached, MEDIA_TYPES.get(ext, "audio/mp4"), request)

    try:
        direct_url, ext, total = await _resolve_cached(video_id)
    except TrackUnavailable:
        # Видео недоступно (удалено/приватно/регион) — это не сбой сервера.
        logger.info("track unavailable: %s", video_id)
        raise HTTPException(status_code=404, detail="Трек недоступен")
    except Exception:  # noqa: BLE001
        logger.exception("yt-dlp resolve failed: %s", video_id)
        raise HTTPException(status_code=502, detail="Не удалось получить аудио")

    media_type = MEDIA_TYPES.get(ext, "audio/mp4")

    client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=60.0))
    # Content-Length должен ТОЧНО совпадать с тем, что реально отдаст эта
    # googlevideo-ссылка, иначе Starlette падает с "content shorter than
    # Content-Length". Авторитетный размер — из content-range самого googlevideo
    # (probe), а filesize из yt-dlp может расходиться. Поэтому probe в приоритете,
    # filesize — только фолбэк, если probe не удался.
    probed = await _probe_total(client, direct_url)
    if probed is not None:
        total = probed

    req_start, req_end = _parse_range(request.headers.get("range"), total)
    if total is not None and req_end is None:
        req_end = total - 1

    # Кэшируем только когда клиент тянет файл целиком (start=0..total-1) —
    # тогда по завершении получаем полную копию, пригодную для повторной отдачи.
    cache_final = os.path.join(CACHE_DIR, f"{video_id}{ext}")
    want_cache = (
        total is not None
        and req_start == 0
        and req_end == total - 1
        and not os.path.exists(cache_final)
    )

    async def proxy():
        # Тянем сегментами по _SEGMENT байт с повтором при обрыве — googlevideo
        # надёжно отдаёт короткие range-запросы, но рвёт длинные потоки.
        tmp = None
        tmp_path = None
        committed = False
        if want_cache:
            try:
                fd, tmp_path = tempfile.mkstemp(dir=CACHE_DIR, suffix=".part")
                tmp = os.fdopen(fd, "wb")
            except OSError:
                tmp = None
        try:
            pos = req_start
            # Если размер неизвестен — качаем до конца (end=None) одним потоком
            # с ретраями по мере продвижения.
            while req_end is None or pos <= req_end:
                seg_end = pos + _SEGMENT - 1
                if req_end is not None:
                    seg_end = min(seg_end, req_end)
                headers = {"Range": f"bytes={pos}-{seg_end}"}

                got = 0
                for attempt in range(_SEGMENT_RETRIES):
                    try:
                        async with client.stream("GET", direct_url, headers=headers) as up:
                            if up.status_code >= 400:
                                logger.warning("upstream %s for %s", up.status_code, video_id)
                                return
                            async for chunk in up.aiter_bytes(chunk_size=65536):
                                # Пишем в кэш только новые (за пределами уже
                                # полученных got) байты сегмента.
                                if tmp is not None:
                                    tmp.write(chunk)
                                got += len(chunk)
                                yield chunk
                        break
                    except httpx.HTTPError as exc:
                        # Частичный сегмент — досбираем оставшийся хвост.
                        if got:
                            headers = {"Range": f"bytes={pos + got}-{seg_end}"}
                        if attempt == _SEGMENT_RETRIES - 1:
                            logger.warning("segment failed %s @%d: %s", video_id, pos, exc)
                            return

                advanced = (seg_end - pos + 1)
                pos += advanced
                if req_end is None and advanced < _SEGMENT:
                    break

            # Дошли до конца файла без обрыва — фиксируем кэш атомарно.
            if tmp is not None and req_end is not None and pos > req_end:
                tmp.flush()
                os.fsync(tmp.fileno())
                tmp.close()
                tmp = None
                os.replace(tmp_path, cache_final)
                committed = True
                _enforce_cache_limit()
        finally:
            await client.aclose()
            if tmp is not None:
                tmp.close()
            if tmp_path and not committed and os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass

    status_code = 200
    headers = {"Accept-Ranges": "bytes", "Cache-Control": "no-store"}
    if total is not None:
        if request.headers.get("range"):
            status_code = 206
            headers["Content-Range"] = f"bytes {req_start}-{req_end}/{total}"
            headers["Content-Length"] = str(req_end - req_start + 1)
        else:
            headers["Content-Length"] = str(total)

    return StreamingResponse(
        proxy(),
        status_code=status_code,
        media_type=media_type,
        headers=headers,
    )


@router.post("/prefetch/{video_id}")
async def prefetch_ytmusic(video_id: str):
    """Заранее резолвит URL следующего трека (кладёт в Redis), чтобы старт
    воспроизведения был мгновенным. Фронт зовёт это для следующего в очереди."""
    if _ytmusic is None:
        raise HTTPException(status_code=503, detail="YouTube Music не настроен")
    if not re.fullmatch(r"[A-Za-z0-9_-]{5,20}", video_id):
        raise HTTPException(status_code=400, detail="Некорректный id")
    if _cached_file(video_id):
        return {"status": "cached"}
    try:
        await _resolve_cached(video_id)
    except TrackUnavailable:
        return {"status": "unavailable"}
    except Exception:  # noqa: BLE001
        return {"status": "error"}
    return {"status": "ready"}
