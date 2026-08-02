import asyncio
import base64
import binascii
import logging
import os
import re
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import RedirectResponse

from app.cache import get_cache_async, set_cache_async
from app.routers.ytdlp import (
    CACHE_DIR,
    MEDIA_TYPES,
    TrackUnavailable,
    TransientResolveError,
    _cached_file,
    _enforce_cache_limit,
    _serve_file,
    cached_ydl,
    clean_title,
    schedule_prefetch,
    prefetch_is_ready,
    single_flight_resolve,
    stream_cached_audio,
)
from app.schemas import (
    ExternalPlaylistDetail,
    ExternalPlaylistResponse,
    ExternalTrackResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter()

# Резолв SoundCloud идёт через yt-dlp (тот же движок, что и YouTube Music).
# Отдельного SDK/ключа не нужно — yt-dlp сам добывает client_id.

# Подписанный cf-media URL SoundCloud живёт всего ~4-5 минут (в отличие от
# googlevideo-ссылок YouTube, живущих часами). Кэшировать его на часы нельзя:
# из кэша прилетал бы заведомо протухший URL → 403 от CDN → трек, «который
# только что играл», переставал запускаться. TTL держим заметно ниже срока
# подписи, чтобы отданный из кэша URL всегда имел запас валидности на старт
# стрима и докачку (полностью проигранный трек оседает в диск-кэше и дальше
# отдаётся с диска, без CDN). Дедуп прогрев→клик (секунды) этот TTL сохраняет.
_RESOLVE_TTL = 120
_UNAVAILABLE_TTL = 600
_TRANSIENT_TTL = 25

# Предохранитель на HLS-ремукс: ffmpeg обрежет вывод на этом размере. Тот же
# смысл, что у ARCHIVE_MAX_AUDIO_BYTES в external_archive — многочасовой микс
# не должен занять весь дисковый кэш.
_HLS_MAX_BYTES = int(os.getenv("ARCHIVE_MAX_AUDIO_BYTES", str(60 * 1024 * 1024)))


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
        genre=entry.get("genre") or None,
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
        genre=track.genre,
    )


# --- Быстрый поиск через api-v2 -------------------------------------------
# SoundcloudSearchIE в yt-dlp делает по HTTP-запросу на каждый найденный трек
# (~0.3с/трек → ~10с на выдачу из 30), из-за чего весь агрегатный поиск ждал
# SoundCloud. Прямой запрос к api-v2 /search/tracks отдаёт ту же выдачу одним
# запросом (~0.4с) через уже имеющийся _api_get (client_id в Redis, авто-
# обновление при 401/403). yt-dlp остаётся фолбэком на случай смены API.


def _normalize_api(request: Request, item: dict) -> Optional[ExternalTrackResponse]:
    """Трек из api-v2 /search/tracks → ExternalTrackResponse."""
    track_id = item.get("id")
    permalink = item.get("permalink_url") or ""
    if not track_id or "soundcloud.com/" not in permalink:
        return None
    artwork = item.get("artwork_url") or (item.get("user") or {}).get("avatar_url")
    if artwork:
        # api отдаёт превью -large (100x100) — просим 500x500.
        artwork = artwork.replace("-large.", "-t500x500.")
    base_url = str(request.base_url).rstrip("/")
    token = _encode_token(str(track_id), permalink)
    return ExternalTrackResponse(
        id=f"soundcloud:{track_id}",
        source="soundcloud",
        external_id=str(track_id),
        title=clean_title(item.get("title") or "Unknown"),
        artist=(item.get("user") or {}).get("username") or "Unknown Artist",
        album=None,
        duration=int((item.get("duration") or 0) / 1000),
        cover_url=artwork,
        stream_url=f"{base_url}/api/soundcloud/stream/{token}",
        download_url=None,
        download_allowed=False,
        genre=item.get("genre") or None,
    )


async def _search_api(request: Request, q: str, limit: int) -> List[ExternalTrackResponse]:
    data = await _api_get("/search/tracks", {"q": q, "limit": limit})
    if not isinstance(data, dict):
        raise RuntimeError("SoundCloud api-v2 search returned no data")
    results: List[ExternalTrackResponse] = []
    for item in data.get("collection") or []:
        track = _normalize_api(request, item)
        if track:
            results.append(track)
        if len(results) >= limit:
            break
    return results


def _search_blocking(q: str, limit: int) -> list:
    # Переиспользуем YoutubeDL в рамках потока (см. ytdlp.cached_ydl) —
    # конструктор на каждый поиск заново грузил бы реестр экстракторов.
    ydl = cached_ydl(
        "soundcloud:search",
        {
            "quiet": True,
            "no_warnings": True,
            "extract_flat": True,  # только метаданные, без резолва аудио (быстро)
            "skip_download": True,
            "noplaylist": True,
        },
    )
    info = ydl.extract_info(f"scsearch{limit}:{q}", download=False)
    return (info or {}).get("entries") or []


async def search_soundcloud(
    request: Request,
    q: str,
    limit: int = 20,
) -> List[ExternalTrackResponse]:
    """Поиск по SoundCloud: быстрый api-v2, при сбое — фолбэк на yt-dlp."""
    try:
        return await _search_api(request, q, limit)
    except Exception as exc:  # noqa: BLE001 — сменилась разметка/API, идём в yt-dlp
        logger.warning("SoundCloud api-v2 search failed (%s), falling back to yt-dlp", exc)

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
            # И подстраховка: даже если селектор не смэтчился, не кидаем
            # ошибку — формат всё равно выбирает _pick_progressive.
            "ignore_no_formats_error": True,
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
    """Резолв прямого URL с кэшем в Redis.

    Явно недоступный трек даёт TrackUnavailable, остальные ошибки резолва —
    TransientResolveError: сбой yt-dlp или сети не должен превращаться в 404.

    Четвёртый элемент — ``fresh`` (см. аналогичное поле в ytdlp._resolve_cached).
    """
    key = f"soundcloud:resolve:{track_id}"
    cached = None if force else await get_cache_async(key)
    if cached:
        if cached.get("unavailable"):
            # Не используем отрицательный кэш старых версий: он мог быть
            # записан из-за 404 yt-dlp, хотя трек доступен в SoundCloud.
            logger.info("ignoring legacy unavailable cache entry for SoundCloud track %s", track_id)
        if cached.get("transient"):
            raise TransientResolveError(track_id)
        if cached.get("url"):
            return cached["url"], cached.get("ext", ".mp3"), cached.get("total"), False

    # Однополётность (см. ytdlp.single_flight_resolve): прогрев и настоящий
    # /stream-GET часто метят в один и тот же трек почти одновременно — не
    # гоняем два параллельных yt-dlp-резолва.
    return await single_flight_resolve(
        f"soundcloud:{track_id}",
        lambda: _resolve_and_cache(track_id, permalink, key),
    )


async def _resolve_and_cache(
    track_id: str, permalink: str, key: str
) -> tuple[str, str, Optional[int], bool]:
    try:
        url, ext, total = await asyncio.to_thread(_resolve_blocking, permalink)
    except Exception as ytdlp_exc:  # noqa: BLE001
        # yt-dlp получает метаданные по permalink. SoundCloud иногда отвечает
        # на этот запрос 404, хотя трек с тем же числовым id воспроизводится в
        # веб-плеере. В таком случае API v2 и его transcodings — независимый
        # и более устойчивый способ получить аудио.
        try:
            url, ext, total = await _resolve_via_api(track_id)
            logger.info("SoundCloud API fallback resolved track %s after yt-dlp failure", track_id)
        except Exception as api_exc:  # noqa: BLE001
            # Не превращаем ошибку метаданных yt-dlp в «трек удалён»: это как
            # раз тот ложный 404, который наблюдался у существующих треков.
            # Подтверждённый TrackUnavailable возможен только от API fallback.
            if isinstance(api_exc, TrackUnavailable):
                raise api_exc from ytdlp_exc
            logger.warning(
                "SoundCloud resolve failed for %s; yt-dlp: %s; API fallback: %s",
                track_id,
                ytdlp_exc,
                api_exc,
                exc_info=True,
            )
            await set_cache_async(key, {"transient": True}, expire=_TRANSIENT_TTL)
            raise TransientResolveError(track_id) from api_exc

    await set_cache_async(key, {"url": url, "ext": ext, "total": total}, expire=_RESOLVE_TTL)
    return url, ext, total, True


@router.get("/search", response_model=List[ExternalTrackResponse])
async def search_endpoint(
    request: Request,
    q: str = Query(..., min_length=1),
    limit: int = Query(20, ge=1, le=50),
):
    return await search_soundcloud(request, q, limit)


# ---------------------------------------------------------------------------
# Поиск плейлистов (sets). yt-dlp'шный scsearch ищет только треки, поэтому
# ходим в api-v2 напрямую. client_id добываем так же, как yt-dlp: скрейпим
# скрипты с главной soundcloud.com; храним в Redis, при 401/403 обновляем.
# ---------------------------------------------------------------------------

_CLIENT_ID_KEY = "soundcloud:client_id"
_CLIENT_ID_TTL = 24 * 3600
_API_V2 = "https://api-v2.soundcloud.com"


async def _scrape_client_id(client: "httpx.AsyncClient") -> Optional[str]:
    try:
        page = (await client.get("https://soundcloud.com/")).text
        script_urls = re.findall(r'<script[^>]+src="([^"]+)"', page)
        # client_id живёт в одном из последних бандлов — идём с конца.
        for src in reversed(script_urls):
            if not src.startswith("https://"):
                continue
            js = (await client.get(src)).text
            match = re.search(r'client_id\s*:\s*"([0-9a-zA-Z]{32})"', js)
            if match:
                return match.group(1)
    except Exception:  # noqa: BLE001 — сеть/разметка поменялась
        logger.exception("SoundCloud client_id scrape failed")
    return None


async def _api_get(path: str, params: dict) -> Optional[dict | list]:
    """GET к api-v2 с client_id из Redis; при 401/403 скрейпит новый и повторяет."""
    import httpx

    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
        client_id = await get_cache_async(_CLIENT_ID_KEY)
        for attempt in range(2):
            if not client_id:
                client_id = await _scrape_client_id(client)
                if not client_id:
                    return None
                await set_cache_async(_CLIENT_ID_KEY, client_id, expire=_CLIENT_ID_TTL)
            try:
                resp = await client.get(
                    f"{_API_V2}{path}", params={**params, "client_id": client_id}
                )
            except httpx.HTTPError:
                logger.exception("SoundCloud api-v2 request failed: %s", path)
                return None
            if resp.status_code in (401, 403) and attempt == 0:
                client_id = None  # протух — скрейпим заново и повторяем
                continue
            if resp.status_code != 200:
                logger.warning("SoundCloud api-v2 %s: HTTP %s", path, resp.status_code)
                return None
            return resp.json()
    return None


class _TranscodingGone(RuntimeError):
    """Эндпоинт транскодирования ответил 404 — этого пресета у трека больше нет."""


async def _transcoding_direct_url(transcoding_url: str) -> str:
    """Второй шаг SoundCloud: URL транскодирования → прямая ссылка на аудио.

    Транскодер отвечает либо JSON с ``url``, либо сразу 302 на CDN. Редирект
    здесь нельзя проходить автоматически: CDN-URL одноразовый/короткоживущий,
    и его 404 не является ответом эндпоинта транскодирования.
    """
    import httpx

    async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
        client_id = await get_cache_async(_CLIENT_ID_KEY)
        for attempt in range(2):
            if not client_id:
                client_id = await _scrape_client_id(client)
                if not client_id:
                    raise RuntimeError("could not obtain SoundCloud client_id")
                await set_cache_async(_CLIENT_ID_KEY, client_id, expire=_CLIENT_ID_TTL)
            try:
                response = await client.get(transcoding_url, params={"client_id": client_id})
            except httpx.HTTPError as exc:
                raise RuntimeError("SoundCloud transcoding request failed") from exc
            if response.status_code in (401, 403) and attempt == 0:
                client_id = None
                continue
            if response.status_code == 404:
                raise _TranscodingGone("SoundCloud transcoding returned HTTP 404")
            if response.is_error:
                raise RuntimeError(f"SoundCloud transcoding returned HTTP {response.status_code}")
            direct_url = response.headers.get("location") if response.is_redirect else None
            if not direct_url:
                try:
                    direct_url = response.json().get("url")
                except ValueError as exc:
                    raise RuntimeError("SoundCloud transcoding returned invalid response") from exc
            if not direct_url:
                raise RuntimeError("SoundCloud transcoding response has no audio URL")
            return direct_url

    raise RuntimeError("SoundCloud client_id was rejected")


async def _resolve_via_api(track_id: str) -> tuple[str, str, Optional[int]]:
    """Получает HTTP-поток трека через api-v2, минуя web-метаданные yt-dlp.

    HLS здесь намеренно не выбираем: общий stream-прокси работает с byte-range
    HTTP-аудио, а не с m3u8-плейлистами. Трек, у которого остался только HLS,
    играется отдельным путём — см. ``resolve_hls_via_api`` и ``_stream_via_hls``.
    """
    track = await _api_get(f"/tracks/{track_id}", {})
    if not isinstance(track, dict):
        raise RuntimeError("SoundCloud API did not return track metadata")
    if track.get("access") == "blocked":
        raise TrackUnavailable(track_id)

    transcodings = ((track.get("media") or {}).get("transcodings") or [])
    # Монетизированные (policy=MONETIZE) треки SoundCloud раздаёт только как
    # посегментно зашифрованный HLS (протоколы ctr-/cbc-encrypted-hls) — это
    # DRM: yt-dlp его намеренно не расшифровывает ("This video is DRM
    # protected"), а ffmpeg не соберёт из него файл. Прогрессивный mp3-пресет у
    # таких треков ещё числится в метаданных, но его эндпоинт мёртв (404). Флаг
    # отличает «DRM, играть реально нечем» (→ TrackUnavailable → 404 → чистый
    # скип на фронте) от случайного 404 у обычного трека (→ transient → 503
    # с ретраем).
    has_drm = any(
        str(item.get("format", {}).get("protocol", "")).startswith(("ctr-", "cbc-"))
        for item in transcodings
    )
    progressive = [
        item for item in transcodings
        if item.get("url") and item.get("format", {}).get("protocol") == "progressive"
    ]
    if not progressive:
        if has_drm:
            raise TrackUnavailable(track_id)
        raise RuntimeError("SoundCloud API returned no progressive audio stream")
    progressive.sort(
        key=lambda item: (
            "mpeg" in str(item.get("format", {}).get("mime_type", "")),
            item.get("preset") == "mp3_1_0",
        ),
        reverse=True,
    )

    try:
        direct_url = await _transcoding_direct_url(progressive[0]["url"])
    except _TranscodingGone as exc:
        if has_drm:
            # У DRM-трека прогрессивный mp3-пресет числится в метаданных, но
            # эндпоинт отдаёт 404 (реально остался только зашифрованный HLS).
            # Играть нечем — трек недоступен.
            raise TrackUnavailable(track_id) from exc
        # У обычного трека URL транскодирования может устареть/меняться
        # независимо от самого трека — это не повод помечать удалённым.
        raise RuntimeError("SoundCloud transcoding returned HTTP 404") from exc

    mime = str(progressive[0].get("format", {}).get("mime_type", "")).lower()
    ext = ".mp3" if "mpeg" in mime else ".m4a"
    return direct_url, ext, None


async def resolve_hls_via_api(track_id: str) -> Optional[tuple[str, str]]:

    Возвращает None, если пригодного HLS нет: либо транскодов нет вовсе, либо
    все они зашифрованные (DRM) — такое ffmpeg не соберёт. Тогда вызывающий код
    оставляет свою исходную ошибку резолва.
    """
    track = await _api_get(f"/tracks/{track_id}", {})
    if not isinstance(track, dict):
        return None
    if track.get("access") == "blocked":
        return None

    transcodings = ((track.get("media") or {}).get("transcodings") or [])
    # Только чистый "hls": ctr-/cbc-encrypted-hls — DRM, его не расшифровать.
    hls = [
        item for item in transcodings
        if item.get("url") and item.get("format", {}).get("protocol") == "hls"
    ]
    if not hls:
        return None
    # AAC-пресеты у SoundCloud качественнее mp3 при том же битрейте, а m4a
    # ремуксится из HLS без перекодирования. Внутри AAC берём старший битрейт
    # (aac_160k > aac_96k) — он зашит в имя пресета.
    def _preset_kbps(item: dict) -> int:
        match = re.search(r"(\d+)k", str(item.get("preset", "")))
        return int(match.group(1)) if match else 0

    hls.sort(
        key=lambda item: (
            "mp4" in str(item.get("format", {}).get("mime_type", "")),
            _preset_kbps(item),
        ),
        reverse=True,
    )
    try:
        m3u8_url = await _transcoding_direct_url(hls[0]["url"])
    except Exception:  # noqa: BLE001 — нет HLS-ссылки: пусть останется исходная ошибка
        logger.warning("SoundCloud HLS transcoding unavailable for %s", track_id, exc_info=True)
        return None

    mime = str(hls[0].get("format", {}).get("mime_type", "")).lower()
    ext = ".mp3" if "mpeg" in mime else ".m4a"
    return m3u8_url, ext



# ---------------------------------------------------------------------------
# HLS-only треки. Часть каталога (как правило, загрузки лейблов) SoundCloud
# раздаёт вообще без прогрессивного транскода. Байт-range-прокси m3u8 играть не
# умеет, поэтому такой трек один раз собирается ffmpeg'ом в цельный файл: он
# ложится в тот же дисковый кэш, из которого stream_cached_audio отдаёт уже
# проигранные треки, и параллельно уходит в MinIO — дальше трек живёт как
# обычный заархивированный файл (и prefetch_is_ready видит его готовым).
# ---------------------------------------------------------------------------

# Один ремукс на трек: браузер шлёт на один и тот же трек несколько
# Range-запросов, и без блокировки каждый запускал бы свой ffmpeg.
_hls_locks: dict[str, asyncio.Lock] = {}


async def _remux_hls_to_cache(cache_id: str, m3u8_url: str, ext: str) -> Optional[str]:
    """Собирает HLS в файл дискового кэша. Возвращает путь или None."""
    from app.transcode import remux_hls_to_file

    final_path = os.path.join(CACHE_DIR, f"{cache_id}{ext}")
    part_path = final_path + ".part"
    container = "mp3" if ext == ".mp3" else "mp4"
    ok = await asyncio.to_thread(
        remux_hls_to_file, m3u8_url, part_path, container, _HLS_MAX_BYTES
    )
    if not ok:
        return None
    try:
        # Атомарно: _cached_file игнорирует *.part, поэтому недособранный файл
        # никогда не попадёт в отдачу.
        os.replace(part_path, final_path)
    except OSError:
        logger.exception("hls: не удалось сохранить %s", final_path)
        return None
    _enforce_cache_limit()
    return final_path


async def _stream_via_hls(request: Request, track_id: str):
    """Отдаёт трек, у которого у SoundCloud остался только HLS.

    Возвращает None, если пригодного HLS нет — тогда вызывающий код оставляет
    исходную ошибку (503/404), как будто этого пути не существует.
    """
    cache_id = f"sc{track_id}"
    lock = _hls_locks.setdefault(track_id, asyncio.Lock())
    async with lock:
        cached = _cached_file(cache_id)
        if not cached:
            hls = await resolve_hls_via_api(track_id)
            if not hls:
                return None
            m3u8_url, ext = hls
            logger.info("SoundCloud %s: прогрессивного потока нет, собираем HLS", track_id)
            cached = await _remux_hls_to_cache(cache_id, m3u8_url, ext)
            if not cached:
                return None
            # Дисковый кэш вытесняется по LRU — кладём копию в MinIO, чтобы
            # второй раз не ремуксить (и чтобы ленивая архивация, которая умеет
            # только прогрессивный резолв, больше не билась об этот трек).
            try:
                from app import external_archive

                asyncio.create_task(
                    external_archive.adopt_local_file("soundcloud", track_id, cached)
                )
            except Exception:  # noqa: BLE001 — архивация не важнее воспроизведения
                logger.exception("hls: не удалось запланировать архивацию sc/%s", track_id)

    ext = os.path.splitext(cached)[1].lower()
    return await _serve_file(cached, MEDIA_TYPES.get(ext, "audio/mp4"), request)


def _upscale_artwork(url: Optional[str]) -> Optional[str]:
    # api-v2 отдаёт превью 100x100 ("-large") — просим полноразмерную.
    if url:
        return url.replace("-large.", "-t500x500.")
    return url


def _normalize_playlist(item: dict) -> Optional[ExternalPlaylistResponse]:
    pl_id = item.get("id")
    permalink = item.get("permalink_url")
    if not pl_id or not permalink or "soundcloud.com/" not in permalink:
        return None
    user = item.get("user") or {}
    # artwork_url плейлиста часто пустой — берём обложку первого трека.
    artwork = item.get("artwork_url")
    if not artwork:
        for t in item.get("tracks") or []:
            if t.get("artwork_url"):
                artwork = t["artwork_url"]
                break
    return ExternalPlaylistResponse(
        id=f"soundcloud:playlist:{pl_id}",
        source="soundcloud",
        external_id=str(pl_id),
        title=item.get("title") or "Unknown",
        owner=user.get("username"),
        cover_url=_upscale_artwork(artwork),
        permalink_url=permalink,
        track_count=int(item.get("track_count") or 0),
    )


def _track_from_api(request: Request, item: dict) -> Optional[ExternalTrackResponse]:
    """Полный объект трека api-v2 → играбельный ExternalTrackResponse."""
    track_id = item.get("id")
    permalink = item.get("permalink_url")
    if not track_id or not permalink or "soundcloud.com/" not in permalink:
        return None
    user = item.get("user") or {}
    title = item.get("title") or "Unknown"
    artist = user.get("username") or "Unknown Artist"
    # Частый паттерн «Артист - Название» в title — раскладываем.
    if " - " in title and (not user.get("username") or artist == title.partition(" - ")[0]):
        maybe_artist, _, rest = title.partition(" - ")
        if rest.strip():
            artist, title = maybe_artist.strip(), rest.strip()

    base_url = str(request.base_url).rstrip("/")
    token = _encode_token(str(track_id), permalink)
    return ExternalTrackResponse(
        id=f"soundcloud:{track_id}",
        source="soundcloud",
        external_id=str(track_id),
        title=clean_title(title),
        artist=artist,
        album=None,
        duration=int((item.get("duration") or 0) / 1000),
        cover_url=_upscale_artwork(item.get("artwork_url") or user.get("avatar_url")),
        stream_url=f"{base_url}/api/soundcloud/stream/{token}",
        download_url=None,
        download_allowed=False,
        genre=item.get("genre") or None,
    )


async def search_soundcloud_playlists(q: str, limit: int = 10) -> List[ExternalPlaylistResponse]:
    """Поиск плейлистов (sets) в SoundCloud через api-v2."""
    data = await _api_get("/search/playlists", {"q": q, "limit": limit})
    items = (data or {}).get("collection") or []
    results = []
    for item in items:
        pl = _normalize_playlist(item)
        if pl:
            results.append(pl)
        if len(results) >= limit:
            break
    return results


async def tracks_by_ids(request: Request, ids: List) -> dict:
    """Батч-дотяжка полных метаданных треков по числовым id через api-v2
    /tracks?ids= → {str(id): ExternalTrackResponse}. Используется, когда есть
    только id треков (плоский yt-dlp даёт лишь id/permalink без названия,
    артиста и длительности → иначе импорт помечает треки Unknown/0)."""
    numeric = [str(i) for i in ids if str(i).isdigit()]
    out: dict = {}
    for i in range(0, len(numeric), 50):
        batch = numeric[i : i + 50]
        fetched = await _api_get("/tracks", {"ids": ",".join(batch)})
        for t in fetched or []:
            track = _track_from_api(request, t)
            if track:
                out[str(t.get("id"))] = track
    return out


async def get_playlist_tracks(
    request: Request, playlist_id: str
) -> tuple[Optional[ExternalPlaylistResponse], List[ExternalTrackResponse]]:
    """Плейлист + полные метаданные всех его треков.

    api-v2 в объекте плейлиста отдаёт полными только первые ~5 треков,
    остальные — заглушки {id}. Дотягиваем их батчами через /tracks?ids=.
    """
    data = await _api_get(f"/playlists/{playlist_id}", {})
    if not data:
        return None, []
    meta = _normalize_playlist(data)

    raw_tracks = data.get("tracks") or []
    full = {t["id"]: t for t in raw_tracks if t.get("permalink_url")}
    missing = [t["id"] for t in raw_tracks if not t.get("permalink_url") and t.get("id")]
    for i in range(0, len(missing), 50):
        batch = missing[i : i + 50]
        fetched = await _api_get("/tracks", {"ids": ",".join(map(str, batch))})
        for t in fetched or []:
            full[t["id"]] = t

    tracks: List[ExternalTrackResponse] = []
    for t in raw_tracks:  # исходный порядок плейлиста
        item = full.get(t.get("id"))
        if not item:
            continue
        track = _track_from_api(request, item)
        if track:
            tracks.append(track)
    return meta, tracks


async def resolve_playlist_url(
    request: Request, url: str
) -> tuple[Optional[ExternalPlaylistResponse], List[ExternalTrackResponse]]:
    """permalink плейлиста → (метаданные, треки). Для импортера."""
    data = await _api_get("/resolve", {"url": url})
    pl_id = (data or {}).get("id") if isinstance(data, dict) else None
    if not pl_id or (data or {}).get("kind") != "playlist":
        return None, []
    return await get_playlist_tracks(request, str(pl_id))


@router.get("/search/playlists", response_model=List[ExternalPlaylistResponse])
async def search_playlists_endpoint(
    q: str = Query(..., min_length=1),
    limit: int = Query(10, ge=1, le=30),
):
    return await search_soundcloud_playlists(q, limit)


@router.get("/playlists/{playlist_id}", response_model=ExternalPlaylistDetail)
async def playlist_detail_endpoint(playlist_id: str, request: Request):
    if not playlist_id.isdigit():
        raise HTTPException(status_code=400, detail="Некорректный id плейлиста")
    meta, tracks = await get_playlist_tracks(request, playlist_id)
    if meta is None:
        raise HTTPException(status_code=404, detail="Плейлист не найден")
    return ExternalPlaylistDetail(playlist=meta, tracks=tracks)


@router.get("/stream/{token}")
async def stream_soundcloud(token: str, request: Request):
    track_id, permalink = _decode_token(token)
    try:
        from app import external_archive

        asyncio.create_task(
            external_archive.schedule_archive_external("soundcloud", track_id, permalink)
        )
    except Exception:  # noqa: BLE001 — архивация не должна ломать воспроизведение
        logger.exception("lazy-archive-ext: не удалось запланировать архивацию sc/%s", track_id)
    try:
        return await stream_cached_audio(
            request,
            f"sc{track_id}",
            lambda force: _resolve_cached(track_id, permalink, force=force),
            archive_key=f"soundcloud/{track_id}",
        )
    except HTTPException as exc:
        # 503 значит «прогрессивного потока нет/резолв сорвался». У части
        # каталога (обычно лейбловые загрузки) прогрессивного транскода у
        # SoundCloud нет вовсе — такой трек играем через HLS, см. _stream_via_hls.
        if exc.status_code != 503:
            raise
        response = await _stream_via_hls(request, track_id)
        if response is None:
            raise
        return response


@router.post("/prefetch/{token}")
async def prefetch_soundcloud(token: str):
    """Ставит трек в фоновую очередь прогрева (резолв в Redis + первые байты
    на диск, см. ytdlp.schedule_prefetch) и отвечает сразу."""
    track_id, permalink = _decode_token(token)
    status = schedule_prefetch(
        f"sc{track_id}",
        lambda force=False: _resolve_cached(track_id, permalink, force=force),
        f"soundcloud:resolve:{track_id}",
        _RESOLVE_TTL,
        archive_key=f"soundcloud/{track_id}",
    )
    return {"status": status}


@router.get("/prefetch/{token}/ready")
async def prefetch_soundcloud_ready(token: str):
    """Готов ли прогрев трека (резолв в Redis или кэш-файл). Фронт поллит это
    после POST /prefetch и снимает гейт скипа вперёд только на ready=True."""
    track_id, _permalink = _decode_token(token)
    ready = await prefetch_is_ready(
        f"sc{track_id}",
        f"soundcloud:resolve:{track_id}",
        archive_key=f"soundcloud/{track_id}",
    )
    return {"ready": ready}
