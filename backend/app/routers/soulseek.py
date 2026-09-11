import asyncio
import base64
import logging
import os
import re
import time
from typing import List, Optional, Tuple

import aiofiles
import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import RedirectResponse, StreamingResponse

from app.cache import get_cache_async, set_cache_async
from app.schemas import ExternalTrackResponse
from app import storage

logger = logging.getLogger(__name__)

router = APIRouter()

SLSKD_URL = os.getenv("SLSKD_URL", "http://slskd:5030").rstrip("/")
SLSKD_API_KEY = os.getenv("SLSKD_API_KEY", "")
SOULSEEK_USERNAME = os.getenv("SOULSEEK_USERNAME", "")
DOWNLOADS_DIR = os.getenv("SLSKD_DOWNLOADS_DIR", "/app/slskd_downloads")
INCOMPLETE_DIR = os.getenv("SLSKD_INCOMPLETE_DIR", "/app/slskd_incomplete")

AUDIO_EXTENSIONS = (".mp3", ".flac", ".ogg", ".m4a", ".wav", ".opus")

# Как долго ждать завершения поиска в slskd, прежде чем вернуть агрегат.
# slskd отдаёт /responses ТОЛЬКО у завершившегося поиска: пока state
# InProgress, responseCount уже растёт, но GET /responses даёт []. Сам поиск
# живёт ~50 с на стороне slskd и завершается state='Completed, TimedOut'.
# 15 с здесь стабильно возвращали пустоту на любой запрос.
SEARCH_TIMEOUT = 60.0
SEARCH_POLL_INTERVAL = 0.7
# Стрим: сколько ждать новых байт, прежде чем сдаться (в секундах, при простое).
STREAM_IDLE_TIMEOUT = 45.0
STREAM_POLL_INTERVAL = 0.4
# Сколько ждать первых байт закачки ДО старта StreamingResponse: обычно пир с
# свободным слотом начинает отдавать за секунды, дольше — очередь, и пусть
# стрим работает по idle-timeout.
STREAM_START_TIMEOUT = 8.0
# Фоновое ожидание завершения трансфера для архивации в MinIO (см.
# _adopt_when_done): закачка живёт в slskd, а не в стриме, и может тянуться
# дольше прослушивания.
_ADOPT_TIMEOUT = 15 * 60
_ADOPT_POLL_INTERVAL = 5.0
_adopt_inflight: set[str] = set()

MEDIA_TYPES = {
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".m4a": "audio/mp4",
    ".wav": "audio/wav",
}


def _headers() -> dict:
    return {"X-API-Key": SLSKD_API_KEY} if SLSKD_API_KEY else {}


# Общий клиент к slskd: без него каждый поиск/стрим платит свежий TCP-хендшейк
# (плюс сокет-чурн под нагрузкой). Заголовки передаются per-request.
_slskd_client = httpx.AsyncClient(timeout=15.0)

# Предохранитель доступности slskd. Когда контейнер не поднят (или DNS его
# имени не резолвит — типично после деплоя без slskd), каждый поиск ждёт
# сетевой таймаут и сыплет ConnectError-трейсбеками, а промах не доказан —
# кэш не спасает, и matcher/харвест бьются в недоступный хост на каждый чих.
# После connect-ошибки помечаем slskd «недоступен до» и отказываем быстро.
# Как и _bot_check_until в ytdlp — память процесса, не Redis: счётчик живёт
# ровно столько же и не должен переживать рестарт.
_SLSKD_BACKOFF = 60.0
_slskd_down_until = 0.0


def _slskd_available() -> bool:
    return time.monotonic() >= _slskd_down_until


def _slskd_unreachable() -> None:
    """Connect-уровень ошибок (DNS/подключение) — slskd недоступен целиком."""
    global _slskd_down_until
    _slskd_down_until = time.monotonic() + _SLSKD_BACKOFF
    logger.warning(
        "slskd unreachable (%s), pausing soulseek attempts for %ss",
        SLSKD_URL, _SLSKD_BACKOFF,
    )


def _token_encode(username: str, filename: str, size: int) -> str:
    raw = f"{username}\n{filename}\n{size}".encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii")


def _token_decode(token: str) -> Tuple[str, str, int]:
    raw = base64.urlsafe_b64decode(token.encode("ascii")).decode("utf-8")
    username, filename, size = raw.split("\n", 2)
    return username, filename, int(size)


def _basename(filename: str) -> str:
    # Soulseek использует Windows-style пути с обратными слэшами.
    return re.split(r"[\\/]", filename)[-1]


def _is_audio(filename: str) -> bool:
    return _basename(filename).lower().endswith(AUDIO_EXTENSIONS)


def _parse_title_artist(filename: str) -> Tuple[str, str]:
    name = _basename(filename)
    name = re.sub(r"\.[A-Za-z0-9]+$", "", name)  # убрать расширение
    name = re.sub(r"^\s*\d+[\s.\-_]+", "", name)  # убрать ведущий номер трека
    name = name.replace("_", " ").strip()
    # Эвристика «Artist - Title».
    parts = re.split(r"\s[-–—]\s", name, maxsplit=1)
    if len(parts) == 2 and parts[0].strip() and parts[1].strip():
        return parts[1].strip(), parts[0].strip()  # (title, artist)
    return name or "Unknown", "Unknown Artist"


def _normalize_file(username: str, file: dict) -> Optional[ExternalTrackResponse]:
    filename = file.get("filename") or ""
    size = file.get("size") or 0
    if not filename or not size or not _is_audio(filename):
        return None

    title, artist = _parse_title_artist(filename)
    length = file.get("length")
    try:
        duration = int(length) if length else 0
    except (TypeError, ValueError):
        duration = 0

    token = _token_encode(username, filename, int(size))
    return ExternalTrackResponse(
        id=f"soulseek:{token}",
        source="soulseek",
        external_id=token,
        title=title,
        artist=artist,
        album=None,
        duration=duration,
        cover_url=None,
        stream_url="",  # заполняется в эндпоинте, где доступен Request
        download_url=None,
        download_allowed=False,
    )


def _rank_key(response: dict, file: dict) -> tuple:
    # Больше — лучше: свободный слот, скорость отдачи, битрейт.
    free = 1 if response.get("hasFreeUploadSlot") else 0
    speed = response.get("uploadSpeed") or 0
    bitrate = file.get("bitRate") or 0
    return (free, speed, bitrate)


async def _slskd_search_responses(q: str, timeout: float = SEARCH_TIMEOUT) -> Optional[List[dict]]:
    """Запускает поиск в slskd и собирает ответы пиров. None — поиск недоступен."""
    if not _slskd_available():
        return None
    try:
        create = await _slskd_client.post(
            f"{SLSKD_URL}/api/v0/searches",
            json={"searchText": q},
            headers=_headers(),
        )
        create.raise_for_status()
        search_id = create.json().get("id")
        if not search_id:
            logger.error("slskd search did not return an id: %s", create.text)
            return None

        # Ждём завершения поиска, прежде чем забирать ответы: slskd отдаёт
        # /responses ТОЛЬКО у завершившегося поиска (InProgress → responseCount
        # уже растёт, но GET /responses даёт []). Сам поиск живёт десятки
        # секунд и завершается state='Completed, TimedOut' — flags-строка,
        # точное равенство с 'Completed' не сработает, проверяем вхождение.
        # Промежуточные опросы нужны, чтобы заметить завершение раньше
        # потолка SEARCH_TIMEOUT.
        elapsed = 0.0
        responses: List[dict] = []
        while elapsed < timeout:
            await asyncio.sleep(SEARCH_POLL_INTERVAL)
            elapsed += SEARCH_POLL_INTERVAL
            state = await _slskd_client.get(
                f"{SLSKD_URL}/api/v0/searches/{search_id}", headers=_headers()
            )
            state.raise_for_status()
            payload = state.json()
            if payload.get("isComplete") or "Completed" in str(payload.get("state") or ""):
                resp = await _slskd_client.get(
                    f"{SLSKD_URL}/api/v0/searches/{search_id}/responses",
                    headers=_headers(),
                )
                resp.raise_for_status()
                responses = resp.json()
                break
        return responses
    except (httpx.ConnectError, httpx.ConnectTimeout):
        # DNS/подключение — хоста нет целиком (не «плохой запрос»):
        # включаем предохранитель, трейсбек не нужен.
        _slskd_unreachable()
        return None
    except httpx.HTTPError:
        logger.exception("Soulseek search failed")
        return None


# ---------------------------------------------------------------------------
# ytmusic → Soulseek: то же, что soundcloud-подмена (см. soundcloud.py,
# schedule_ytmusic_soundcloud_match), только источником аудио служит
# оригинальный релизный файл с пира — ровно та запись, что была в релизе
# (включая lossless), а не загрузка в SoundCloud, где матчинг регулярно
# цеплял ремиксы. Поэтому приоритет ВЫШЕ SoundCloud.
#
# Как и scmatch, матч ищется заранее, из поисковых эндпоинтов ytmusic: у
# /stream/{video_id} метаданных нет — только videoId и кэш. Найденный матч
# сразу ставит закачку у пира: к моменту клика файл уже течёт.
# ---------------------------------------------------------------------------

_MATCH_TTL = 7 * 24 * 3600
_MATCH_MISS_TTL = 6 * 3600
# У пиров свои рипы (прегэпы/трим тишины расходятся сильнее, чем между
# стримингами) — окно по длительности шире SC-шных ±5с.
_MATCH_DURATION_TOLERANCE = 8
# Поиск в slskd дорогой (до 15с поллинга) — греем только верхушку выдачи.
_MATCH_SCHEDULE_LIMIT = 3
# Одновременных поисков: очередь внутри slskd отсутствует, ограничиваем сами.
_MATCH_CONCURRENCY = 2
# Ставить закачку сразу при найденном матче, не дожидаясь клика: без этого
# первый проигрыш платит ожидание очереди пира. 0 — качать только по клику.
_MATCH_PREFETCH = os.getenv("SLSK_MATCH_PREFETCH", "1") not in ("0", "false", "no")
_match_sem: Optional[asyncio.Semaphore] = None
_match_inflight: dict[str, asyncio.Task] = {}

# Слова в имени файла, отличающие ремикс/кавер от оригинальной записи.
# «live» и «edit» не включены — дают слишком много ложных срабатываний
# («Live and Die», «Editor»).
_REMIX_RE = re.compile(
    r"\b(?:remixes?|bootleg|rework|vip|flip|acapella|instrumental|"
    r"cover|dub\s*mix|extended\s*mix|radio\s*edit)\b",
    re.IGNORECASE,
)


def _is_remix_mismatch(filename: str, want_title: str) -> bool:
    """Кандидат — ремикс/кавер, а ищем оригинал (или наоборот)."""
    cand = _basename(filename)
    if _REMIX_RE.search(cand):
        return not _REMIX_RE.search(want_title or "")
    return False


async def find_soulseek_equivalent(
    video_id: str, title: str, artist: str, duration: int
) -> Optional[str]:
    """Токен файла-эквивалента в Soulseek для трека YouTube Music.

    None — точного совпадения нет (или slskd недоступен): вызывающий код
    откатывается на SoundCloud/YouTube.
    """
    # Пустой SOULSEEK_USERNAME = Soulseek выключен целиком (например, в
    # прод-конфигурации без slskd): не ищем и не трогаем кэш, чтобы каждый
    # ytmusic-поиск/стрим не бился в несуществующий хост.
    if not SOULSEEK_USERNAME:
        return None
    key = f"ytmusic:slskmatch:{video_id}"
    cached = await get_cache_async(key)
    if cached:
        # Промах тоже кэшируем — иначе каждый стрим гонял бы slskd-поиск заново.
        token = cached.get("token")
        return str(token) if token else None

    from app.routers.ytdlp import clean_title

    want_title = clean_title(title or "")
    if not want_title or not artist or duration <= 0:
        await set_cache_async(key, {"token": None}, expire=_MATCH_MISS_TTL)
        return None

    global _match_sem
    if _match_sem is None:
        _match_sem = asyncio.Semaphore(_MATCH_CONCURRENCY)
    async with _match_sem:
        responses = await _slskd_search_responses(f"{artist} {want_title}")
    if responses is None:
        # Поиск недоступен: промах не доказан — не кэшируем, следующий вызов
        # попробует снова.
        return None

    from app.routers.soundcloud import _ScMatchCandidate, _is_exact_match

    best: Optional[tuple] = None  # (rank, username, file)
    for response in responses:
        username = response.get("username") or ""
        if not username:
            continue
        for file in response.get("files") or []:
            filename = file.get("filename") or ""
            if not _is_audio(filename):
                continue
            try:
                f_duration = int(file.get("length") or 0)
            except (TypeError, ValueError):
                f_duration = 0
            f_title, f_artist = _parse_title_artist(filename)
            candidate = _ScMatchCandidate(
                title=f_title,
                artist=f_artist,
                duration=f_duration,
            )
            if not _is_exact_match(
                candidate, want_title, artist, duration,
                tolerance=_MATCH_DURATION_TOLERANCE,
            ):
                continue
            if _is_remix_mismatch(filename, want_title):
                continue
            # Уже скачанный файл — мгновенный стрим без пира вообще.
            have_local = 1 if _find_local_path(filename) else 0
            rank = (have_local, *_rank_key(response, file))
            if best is None or rank > best[0]:
                best = (rank, username, file)

    if best is None:
        await set_cache_async(key, {"token": None}, expire=_MATCH_MISS_TTL)
        logger.info("no soulseek equivalent for ytmusic track %s", video_id)
        return None

    _rank, username, file = best
    size = int(file.get("size") or 0)
    if not size:
        await set_cache_async(key, {"token": None}, expire=_MATCH_MISS_TTL)
        return None
    token = _token_encode(username, file["filename"], size)
    await set_cache_async(key, {"token": token}, expire=_MATCH_TTL)
    logger.info(
        "ytmusic track %s (%s — %s) matched to soulseek peer %s",
        video_id, artist, title, username,
    )
    if _MATCH_PREFETCH:
        await _enqueue_download(_slskd_client, username, file["filename"], size)
    return token


async def soulseek_match_for(video_id: str) -> Optional[str]:
    """Известный soulseek-эквивалент ytmusic-трека.

    Только чтение кэша, без поиска: вызывается из /stream и /prefetch на
    каждый чих (поиск запускается заранее, из поиска ytmusic).
    """
    cached = await get_cache_async(f"ytmusic:slskmatch:{video_id}")
    token = cached.get("token") if cached else None
    return str(token) if token else None


def schedule_ytmusic_soulseek_match(tracks) -> None:
    """Ищет soulseek-эквиваленты ytmusic-треков в фоне (fire-and-forget).

    Зеркало soundcloud.schedule_ytmusic_soundcloud_match. Повторные вызовы
    дёшевы: find_soulseek_equivalent выходит по кэшу (в т.ч. по закэширо-
    ванному промаху), параллельные дубли режет _match_inflight, а
    одновременность slskd-поисков ограничена _match_sem.
    """
    from app.routers.soundcloud import _sc_match_fields

    for track in list(tracks)[:_MATCH_SCHEDULE_LIMIT]:
        fields = _sc_match_fields(track)
        if fields is None or fields[0] in _match_inflight:
            continue
        video_id, title, artist, duration = fields
        task = asyncio.create_task(_match_job(video_id, title, artist, duration))
        _match_inflight[video_id] = task
        task.add_done_callback(
            lambda _task, vid=video_id: _match_inflight.pop(vid, None)
        )


async def _match_job(
    video_id: str, title: str, artist: str, duration: int
) -> Optional[str]:
    try:
        return await find_soulseek_equivalent(video_id, title, artist, duration)
    except Exception:  # noqa: BLE001 — фоновый матч, стрим его не ждёт
        logger.warning("slsk match failed for ytmusic %s", video_id, exc_info=True)
        return None


async def await_soulseek_match(
    video_id: str, timeout: float = 3.0
) -> Optional[str]:
    """Эквивалент из кэша; если поиск этого трека сейчас идёт — ждём его.

    До timeout, дальше — как получится (промах → вызывающий код идёт на
    SoundCloud/YouTube). shield: таймаут стрима не отменяет общий поиск.
    """
    task = _match_inflight.get(video_id)
    if task is not None:
        try:
            return await asyncio.wait_for(asyncio.shield(task), timeout)
        except asyncio.TimeoutError:
            pass
        except Exception:  # noqa: BLE001 — матч не должен ломать стрим
            logger.warning("slsk match wait failed for %s", video_id, exc_info=True)
    return await soulseek_match_for(video_id)


async def prefetch_soulseek_match(video_id: str, timeout: float = 3.0) -> Optional[str]:
    """Ставит закачку известного soulseek-матча; ждёт идущий поиск до timeout.

    Вызывается из /api/ytdlp/prefetch/{video_id}: к моменту клика файл уже
    течёт с пира, и stream_soulseek отдаёт байты без ожидания очереди.
    """
    token = await await_soulseek_match(video_id, timeout=timeout)
    if not token or not _slskd_available():
        return None
    try:
        username, filename, size = _token_decode(token)
    except Exception:  # noqa: BLE001 — битый токен → обычный путь прогрева
        return None
    await _enqueue_download(_slskd_client, username, filename, size)
    return token


@router.get("/search", response_model=List[ExternalTrackResponse])
async def search_soulseek(
    request: Request,
    q: str = Query(..., min_length=1),
    limit: int = Query(20, ge=1, le=50),
):
    if not SOULSEEK_USERNAME:
        return []

    base_url = str(request.base_url).rstrip("/")

    responses = await _slskd_search_responses(q)
    if responses is None:
        return []

    # Разворачиваем (response -> files) и ранжируем.
    candidates: List[tuple] = []
    for response in responses:
        username = response.get("username") or ""
        if not username:
            continue
        for file in response.get("files", []):
            if _is_audio(file.get("filename") or ""):
                candidates.append((_rank_key(response, file), username, file))

    candidates.sort(key=lambda c: c[0], reverse=True)

    results: List[ExternalTrackResponse] = []
    seen = set()
    for _, username, file in candidates:
        track = _normalize_file(username, file)
        if not track:
            continue
        dedup = (track.artist.lower(), track.title.lower())
        if dedup in seen:
            continue
        seen.add(dedup)
        track.stream_url = f"{base_url}/api/soulseek/stream/{track.external_id}"
        results.append(track)
        if len(results) >= limit:
            break

    return results


def _find_local_path(filename: str) -> Optional[str]:
    """Ищет скачанный/скачиваемый файл по басенейму в downloads и incomplete."""
    target = _basename(filename)
    for base in (DOWNLOADS_DIR, INCOMPLETE_DIR):
        if not os.path.isdir(base):
            continue
        for root, _dirs, files in os.walk(base):
            if target in files:
                return os.path.join(root, target)
    return None


async def _enqueue_download(client: httpx.AsyncClient, username: str, filename: str, size: int):
    try:
        await client.post(
            f"{SLSKD_URL}/api/v0/transfers/downloads/{username}",
            json=[{"filename": filename, "size": size}],
            headers=_headers(),
        )
    except (httpx.ConnectError, httpx.ConnectTimeout):
        _slskd_unreachable()
    except httpx.HTTPError:
        # Если файл уже в очереди, slskd вернёт ошибку — это не критично.
        logger.info("Download enqueue for %s returned non-2xx (возможно, уже в очереди)", filename)


async def _transfer_finished(client: httpx.AsyncClient, username: str, filename: str) -> Optional[bool]:
    """True — завершён, False — упал/отменён, None — ещё идёт/неизвестно."""
    try:
        resp = await client.get(
            f"{SLSKD_URL}/api/v0/transfers/downloads/{username}", headers=_headers()
        )
        resp.raise_for_status()
        data = resp.json()
    except (httpx.ConnectError, httpx.ConnectTimeout):
        _slskd_unreachable()
        return None
    except httpx.HTTPError:
        return None

    target = _basename(filename)
    # Структура: список directories, в каждой — files.
    directories = data.get("directories", []) if isinstance(data, dict) else data
    for directory in directories:
        for f in directory.get("files", []):
            if _basename(f.get("filename", "")) != target:
                continue
            state = (f.get("state") or "").lower()
            if "completed" in state and "succeeded" in state:
                return True
            if any(x in state for x in ("failed", "cancelled", "errored", "rejected")):
                return False
            return None
    return None


async def _adopt_when_done(
    source: str, external_id: str, username: str, filename: str
) -> None:
    """Дожидается завершения закачки в slskd и уносит файл в MinIO.

    Трансфер не зависит от стрима: клиент мог уйти на середине, а файл
    продолжает докачиваться. Ошибки только логируем — архивация не должна
    ничего ломать (следующее прослушивание повторит через стрим).
    """
    from app import external_archive

    try:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + _ADOPT_TIMEOUT
        while True:
            finished = await _transfer_finished(_slskd_client, username, filename)
            if finished is False:
                return
            if finished is True:
                break
            if loop.time() >= deadline:
                return
            await asyncio.sleep(_ADOPT_POLL_INTERVAL)

        path = _find_local_path(filename)
        if path and os.path.exists(path):
            await external_archive.adopt_local_file(source, external_id, path)
    except Exception:  # noqa: BLE001 — фон, воспроизведение важнее
        logger.warning("slsk adopt failed for %s", filename, exc_info=True)
    finally:
        _adopt_inflight.discard(filename)


@router.get("/stream/{token}")
async def stream_soulseek(token: str, request: Request, vid: str = Query(default="")):
    if not SOULSEEK_USERNAME:
        raise HTTPException(status_code=503, detail="Soulseek не настроен")

    try:
        username, filename, size = _token_decode(token)
    except Exception:
        raise HTTPException(status_code=400, detail="Некорректный токен")

    ext = os.path.splitext(_basename(filename))[1].lower()
    media_type = MEDIA_TYPES.get(ext, "application/octet-stream")

    # Архивная копия в MinIO (её кладёт _adopt_when_done после первой
    # закачки) быстрее пира и не зависит от того, ушёл ли раздающий в
    # оффлайн. Ключ — исходный идентификатор трека: ytmusic/{vid} для
    # подмены ytmusic-трека, soulseek/{token} для самостоятельного.
    if storage.is_minio_backend():
        try:
            from app.routers.ytdlp import archived_music_path

            archive_key = (
                f"ytmusic/{vid}"
                if re.fullmatch(r"[A-Za-z0-9_-]{5,20}", vid or "")
                else f"soulseek/{token}"
            )
            archived = await archived_music_path(archive_key)
            if archived:
                return await storage.minio_range_response_async(archived, request)
        except Exception:  # noqa: BLE001 — объект мог удалиться, играем по обычному пути
            logger.warning("slsk archived object unusable for %s", filename, exc_info=True)

    # Общий клиент (см. _slskd_client): не закрываем его в finally —
    # он живёт на модуль и переиспользует соединения между стримами.
    client = _slskd_client

    # slskd недоступен (предохранитель, см. _slskd_unreachable) — не тратим
    # STREAM_START_TIMEOUT на поллинг мёртвого хоста, сразу отыгрываем
    # фолбэк тем же кодом, что и отказ пира.
    if not _slskd_available():
        if re.fullmatch(r"[A-Za-z0-9_-]{5,20}", vid or ""):
            return RedirectResponse(
                f"/api/ytdlp/stream/{vid}?slskfallback=1", status_code=307
            )
        raise HTTPException(status_code=502, detail="slskd недоступен")

    await _enqueue_download(client, username, filename, size)

    # Ждём первых байт ДО ответа клиенту. Пока StreamingResponse не начат,
    # отказ пира можно честно отыграть фолбэком: этот эндпоинт вызывается 307
    # из /api/ytdlp/stream/{video_id} (см. vid), и по таймауту очереди мы
    # возвращаем браузер туда же — с slskfallback=1 стрим уйдёт на SoundCloud.
    # После старта стрима это уже невозможно: пустой 200 выглядит для плеера
    # как «трек кончился», а не «истник отказал».
    loop = asyncio.get_running_loop()
    deadline = loop.time() + STREAM_START_TIMEOUT
    while True:
        path = _find_local_path(filename)
        if path and os.path.exists(path) and os.path.getsize(path) > 0:
            break
        finished = await _transfer_finished(client, username, filename)
        if finished is False:
            if re.fullmatch(r"[A-Za-z0-9_-]{5,20}", vid or ""):
                return RedirectResponse(
                    f"/api/ytdlp/stream/{vid}?slskfallback=1", status_code=307
                )
            raise HTTPException(status_code=502, detail="Пир не отдал файл")
        if loop.time() >= deadline:
            break  # очередь пира длинная — стримуем как получится, дальше idle-timeout
        await asyncio.sleep(STREAM_POLL_INTERVAL)

    # Архивация: пир уйдёт в оффлайн, а трек должен остаться. Трансфер живёт
    # в slskd независимо от нашего стрима, поэтому ждём его завершения
    # фоновой задачей (в т.ч. после ухода клиента) и уносим файл в MinIO под
    # исходным идентификатором: ytmusic/{vid} для подмены ytmusic-трека
    # (archive:path подхватит stream_cached_audio) или soulseek/{token}.
    if storage.is_minio_backend():
        if re.fullmatch(r"[A-Za-z0-9_-]{5,20}", vid or ""):
            source, external_id = "ytmusic", vid
        else:
            source, external_id = "soulseek", token
        if filename not in _adopt_inflight:
            _adopt_inflight.add(filename)
            asyncio.create_task(_adopt_when_done(source, external_id, username, filename))

    async def streamer():
        sent = 0
        idle = 0.0
        try:
            while sent < size:
                path = _find_local_path(filename)
                if path and os.path.exists(path):
                    current = os.path.getsize(path)
                    if current > sent:
                        async with aiofiles.open(path, "rb") as fh:
                            await fh.seek(sent)
                            chunk = await fh.read(current - sent)
                        if chunk:
                            sent += len(chunk)
                            idle = 0.0
                            yield chunk
                            continue

                # Новых байт нет — проверяем состояние трансфера.
                finished = await _transfer_finished(client, username, filename)
                if finished is False:
                    logger.warning("Soulseek transfer failed: %s", filename)
                    break
                if finished is True:
                    # Дочитываем хвост после завершения.
                    path = _find_local_path(filename)
                    if path and os.path.exists(path):
                        current = os.path.getsize(path)
                        if current > sent:
                            async with aiofiles.open(path, "rb") as fh:
                                await fh.seek(sent)
                                chunk = await fh.read(current - sent)
                            if chunk:
                                sent += len(chunk)
                                yield chunk
                    break

                idle += STREAM_POLL_INTERVAL
                if idle >= STREAM_IDLE_TIMEOUT:
                    logger.warning("Soulseek stream idle timeout: %s", filename)
                    break
                await asyncio.sleep(STREAM_POLL_INTERVAL)
        finally:
            pass  # общий _slskd_client не закрываем

    # Без Content-Length: реально отданный объём может оказаться меньше
    # заявленного size (обрыв трансфера, idle-timeout, пир ошибся в размере),
    # а фиксированный Content-Length при коротком теле роняет ответ
    # ("Response content shorter than Content-Length"). Отдаём chunked-поток:
    # перемотки всё равно нет (Accept-Ranges: none), длина не нужна.
    headers = {
        "Accept-Ranges": "none",
        "Cache-Control": "no-store",
    }
    return StreamingResponse(streamer(), media_type=media_type, headers=headers)
