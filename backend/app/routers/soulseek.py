import asyncio
import base64
import logging
import os
import re
from typing import List, Optional, Tuple

import aiofiles
import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from app.schemas import ExternalTrackResponse

logger = logging.getLogger(__name__)

router = APIRouter()

SLSKD_URL = os.getenv("SLSKD_URL", "http://slskd:5030").rstrip("/")
SLSKD_API_KEY = os.getenv("SLSKD_API_KEY", "")
SOULSEEK_USERNAME = os.getenv("SOULSEEK_USERNAME", "")
DOWNLOADS_DIR = os.getenv("SLSKD_DOWNLOADS_DIR", "/app/slskd_downloads")
INCOMPLETE_DIR = os.getenv("SLSKD_INCOMPLETE_DIR", "/app/slskd_incomplete")

AUDIO_EXTENSIONS = (".mp3", ".flac", ".ogg", ".m4a", ".wav", ".opus")

# Как долго собирать ответы пиров на поиск, прежде чем вернуть агрегат.
# Результаты Soulseek приходят волнами в течение нескольких секунд.
SEARCH_TIMEOUT = 15.0
SEARCH_POLL_INTERVAL = 0.7
# Стрим: сколько ждать новых байт, прежде чем сдаться (в секундах, при простое).
STREAM_IDLE_TIMEOUT = 45.0
STREAM_POLL_INTERVAL = 0.4

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


@router.get("/search", response_model=List[ExternalTrackResponse])
async def search_soulseek(
    request: Request,
    q: str = Query(..., min_length=1),
    limit: int = Query(20, ge=1, le=50),
):
    if not SOULSEEK_USERNAME:
        return []

    base_url = str(request.base_url).rstrip("/")

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
            return []

        # Собираем ответы пиров, пока поиск не завершится или не истечёт таймаут.
        elapsed = 0.0
        responses: List[dict] = []
        while elapsed < SEARCH_TIMEOUT:
            await asyncio.sleep(SEARCH_POLL_INTERVAL)
            elapsed += SEARCH_POLL_INTERVAL
            state = await _slskd_client.get(
                f"{SLSKD_URL}/api/v0/searches/{search_id}", headers=_headers()
            )
            state.raise_for_status()
            payload = state.json()
            if payload.get("responseCount", 0) > 0:
                resp = await _slskd_client.get(
                    f"{SLSKD_URL}/api/v0/searches/{search_id}/responses",
                    headers=_headers(),
                )
                resp.raise_for_status()
                responses = resp.json()
            if payload.get("isComplete") or payload.get("state") == "Completed":
                break
    except httpx.HTTPError:
        logger.exception("Soulseek search failed")
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


@router.get("/stream/{token}")
async def stream_soulseek(token: str):
    if not SOULSEEK_USERNAME:
        raise HTTPException(status_code=503, detail="Soulseek не настроен")

    try:
        username, filename, size = _token_decode(token)
    except Exception:
        raise HTTPException(status_code=400, detail="Некорректный токен")

    ext = os.path.splitext(_basename(filename))[1].lower()
    media_type = MEDIA_TYPES.get(ext, "application/octet-stream")

    # Общий клиент (см. _slskd_client): не закрываем его в finally —
    # он живёт на модуль и переиспользует соединения между стримами.
    client = _slskd_client
    await _enqueue_download(client, username, filename, size)

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
