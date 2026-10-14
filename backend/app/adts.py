"""AAC из MP4 → ADTS для быстрого старта в Safari на iOS.

Safari (AVFoundation) перед первым звуком из MP4 выкачивает ~1 МБ и больше,
а из фрагментированного DASH-файла YouTube — ещё больше: на канале 500 КБ/с
это 2 и 6-8 с тишины. MP3 и «голый» AAC в ADTS он играет с первых килобайт
(замер в Safari 2026-10-03: 0.1-0.5 с на том же канале). SoundCloud и Deezer
отдают как раз такие потоки — отсюда «у них 2-3 с, у нас до 10».

Клиент просит ADTS параметром ``?fmt=adts`` (PWA на iOS, см.
frontend/src/utils/streamQuality.js). Звук не перекодируется: те же кадры AAC
перекладываются по индексу из таблиц MP4 прямо при отдаче (app/mp4_adts.py) —
с честными Content-Length и Range, без промежуточного файла. ffmpeg с
LRU-кэшем готовых .aac остался запасным путём для раскладок, которые индекс
не берёт.

Цена: у ADTS нет индекса, длительность и позицию Safari оценивает по
битрейту — шкала плывёт на 1-2% (UI берёт длительность из БД, перемотка
работает, трек доигрывается до конца — проверено там же).
"""

import asyncio
import glob
import hashlib
import logging
import os
import subprocess
import tempfile
import uuid
from collections import OrderedDict
from typing import AsyncIterator, Callable, Optional

from fastapi import Request, Response
from fastapi.responses import StreamingResponse

from app.transcode import FFMPEG_BIN

logger = logging.getLogger(__name__)

# Расширения AAC-в-MP4. Opus/WebM в ADTS не переложить, MP3 и так быстрый.
_MP4_EXTS = (".m4a", ".mp4", ".m4b")
ADTS_MEDIA_TYPE = "audio/aac"
# Готовые .aac пишет только запасной путь (ffmpeg): основной перекладывает на
# лету. Потолок поэтому скромный, старый кэш ужимается на старте (trim_cache).
_MAX_BYTES = int(os.getenv("ADTS_CACHE_MAX_MB", "128")) * 1024 * 1024
_REMUX_TIMEOUT = 60

_locks: dict[str, asyncio.Lock] = {}
# Источник, который ffmpeg переложить не смог (не AAC, битый): повторять на
# каждый Range-запрос незачем — отдаём оригинал.
_failed: set[str] = set()


def wants_adts(request: Optional[Request]) -> bool:
    return (
        request is not None
        and request.query_params.get("fmt") == "adts"
        and not getattr(request.state, "adts_off", False)
    )


# Один URL — одно представление на всё время игры. Холодный трек первый раз
# идёт живым прокси с YouTube в MP4 (переложить на лету нечего), а докачавшись
# в кэш, тот же URL с ?fmt=adts начинал отдавать ADTS. Safari добирает трек
# Range-запросами по ходу игры и клеил ADTS-байты по смещениям MP4: часы шли
# по таблицам MP4, а звука не было («играет, время идёт, тишина»). Поэтому
# отданный оригиналом URL остаётся оригиналом, пока его может держать браузер
# (Cache-Control кэш-файла — сутки).
_ORIGINAL_PIN_TTL = 86400


def _pin_key(cache_id: str) -> str:
    return f"adts:original:{cache_id}"


async def pin_original(request: Request, cache_id: str) -> None:
    """Этот URL отдан оригиналом — дальше и Range-запросы получают оригинал."""
    if not wants_adts(request):
        return
    from app.cache import set_cache_async

    await set_cache_async(_pin_key(cache_id), 1, expire=_ORIGINAL_PIN_TTL)


async def keep_original_if_pinned(request: Request, cache_id: str) -> None:
    if not wants_adts(request):
        return
    from app.cache import get_cache_async

    if await get_cache_async(_pin_key(cache_id)):
        request.state.adts_off = True


def is_mp4_audio(path: str, media_type: Optional[str] = None) -> bool:
    if os.path.splitext(path)[1].lower() in _MP4_EXTS:
        return True
    return bool(media_type) and media_type.split(";")[0].strip() in ("audio/mp4", "audio/x-m4a")


def adts_response(
    index,
    request: Request,
    etag: str,
    read: Callable[[int, int], AsyncIterator[bytes]],
    cache_control: Optional[str] = None,
) -> Response:
    """Ответ с ADTS по индексу кадров (app/mp4_adts.py): Range, ETag и 304
    как у обычной отдачи файла. ``read(a, b)`` — байты MP4 [a, b]."""
    from app import mp4_adts, storage

    common = storage.audio_common_headers(etag)
    if cache_control:
        common["Cache-Control"] = cache_control
    if storage.if_none_match_matches(request, etag):
        return Response(status_code=304, headers=common)
    total = index.total
    range_header = request.headers.get("range")
    if range_header and not storage.if_range_allows_206(request, etag):
        range_header = None
    if range_header:
        parsed = storage.parse_range_header(range_header, total)
        if parsed is None:
            return Response(status_code=416, headers={**common, "Content-Range": f"bytes */{total}"})
        start, end = parsed
    else:
        start, end = 0, total - 1
    headers = {**common, "Content-Length": str(end - start + 1)}
    if range_header:
        headers["Content-Range"] = f"bytes {start}-{end}/{total}"
    return StreamingResponse(
        mp4_adts.iter_range(index, start, end, read),
        status_code=206 if range_header else 200,
        media_type=ADTS_MEDIA_TYPE,
        headers=headers,
    )


# Индексы локальных файлов (дисковый кэш провайдеров): ключ — путь, размер и
# mtime, перезаписанный файл индексируется заново. None — не перекладывается.
_local_indexes: "OrderedDict[tuple, object]" = OrderedDict()
_LOCAL_INDEX_MAX = 64


async def local_adts_response(
    path: str, request: Request, cache_control: Optional[str] = None
) -> Optional[Response]:
    """ADTS из локального MP4 по индексу кадров или None — тогда ffmpeg."""
    from app import mp4_adts, storage

    try:
        st = os.stat(path)
    except OSError:
        return None
    key = (path, st.st_size, st.st_mtime_ns)
    if key in _local_indexes:
        _local_indexes.move_to_end(key)
        index = _local_indexes[key]
    else:
        try:
            index = await asyncio.to_thread(mp4_adts.index_file, path)
        except OSError:
            return None
        _local_indexes[key] = index
        while len(_local_indexes) > _LOCAL_INDEX_MAX:
            _local_indexes.popitem(last=False)
    if index is None:
        return None
    etag = f'"{st.st_size:x}-{int(st.st_mtime):x}-adts"'
    return adts_response(
        index,
        request,
        etag,
        lambda start, end: storage._iter_cached_file(path, start, end),
        cache_control=cache_control or storage.AUDIO_CACHE_CONTROL,
    )


def _cache_dir() -> str:
    from app.routers.ytdlp import CACHE_DIR

    path = os.path.join(CACHE_DIR, "adts")
    os.makedirs(path, exist_ok=True)
    return path


def _target(source_id: str) -> str:
    digest = hashlib.sha1(source_id.encode()).hexdigest()[:20]
    return os.path.join(_cache_dir(), f"{digest}.aac")


def _remux(src: str, dest: str) -> bool:
    """MP4 → ADTS без перекодирования, атомарно через временный файл."""
    tmp = f"{dest}.{os.getpid()}-{uuid.uuid4().hex[:8]}.part"
    try:
        result = subprocess.run(
            [FFMPEG_BIN, "-v", "error", "-y", "-i", src, "-vn", "-c:a", "copy", "-f", "adts", tmp],
            capture_output=True, text=True, timeout=_REMUX_TIMEOUT,
        )
        if result.returncode != 0 or not os.path.getsize(tmp):
            logger.warning("adts: ffmpeg не переложил %s: %s", src, result.stderr.strip()[-300:])
            return False
        os.replace(tmp, dest)
        return True
    except (OSError, subprocess.SubprocessError):
        logger.warning("adts: перекладка %s упала", src, exc_info=True)
        return False
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def _enforce_limit() -> None:
    """LRU по mtime (готовый файл трогаем при каждой отдаче)."""
    try:
        files = [
            (p, os.path.getsize(p), os.path.getmtime(p))
            for p in glob.glob(os.path.join(_cache_dir(), "*.aac"))
        ]
    except OSError:
        return
    total = sum(size for _, size, _ in files)
    for path, size, _ in sorted(files, key=lambda f: f[2]):
        if total <= _MAX_BYTES:
            break
        try:
            os.remove(path)
            total -= size
        except OSError:
            continue


def trim_cache() -> None:
    """Ужимает кэш готовых .aac до потолка (зовётся на старте воркера)."""
    _enforce_limit()


def _touch(path: str) -> None:
    try:
        os.utime(path)
    except OSError:
        pass


async def _ensure(source_id: str, produce_source) -> Optional[str]:
    """Готовый ADTS для источника или None (тогда отдаётся оригинал).

    ``produce_source()`` — корутина, которая кладёт MP4 во временный файл и
    возвращает (путь, нужно_ли_удалить_после) — для MinIO это скачивание.
    """
    dest = _target(source_id)
    if os.path.exists(dest):
        _touch(dest)
        return dest
    if source_id in _failed:
        return None
    lock = _locks.setdefault(source_id, asyncio.Lock())
    try:
        async with lock:
            if os.path.exists(dest):
                return dest
            src, cleanup = await produce_source()
            try:
                ok = await asyncio.to_thread(_remux, src, dest)
            finally:
                if cleanup:
                    try:
                        os.remove(src)
                    except OSError:
                        pass
            if not ok:
                _failed.add(source_id)
                return None
    finally:
        _locks.pop(source_id, None)
    await asyncio.to_thread(_enforce_limit)
    return dest


async def adts_for_local(path: str) -> Optional[str]:
    """ADTS-версия локального MP4-файла (дисковый кэш провайдеров)."""
    try:
        stat = os.stat(path)
    except OSError:
        return None
    # Перезалитый файл под тем же путём — другой источник.
    source_id = f"file:{path}:{stat.st_size}:{int(stat.st_mtime)}"

    async def produce():
        return path, False

    return await _ensure(source_id, produce)


async def adts_for_object(file_path: str, etag: str) -> Optional[str]:
    """ADTS-версия MP4-объекта MinIO (minio://bucket/key)."""
    from app import storage

    source_id = f"obj:{file_path}:{etag}"

    async def produce():
        bucket, key = storage.parse_object_path(file_path)
        cached = storage.disk_cached_path(bucket, key)
        if cached:
            return cached, False  # дисковый кэш S3 — не удалять после конвертации
        fd, tmp = tempfile.mkstemp(suffix=os.path.splitext(key)[1] or ".m4a")
        os.close(fd)
        await asyncio.to_thread(storage.download_object, bucket, key, tmp)
        return tmp, True

    try:
        return await _ensure(source_id, produce)
    except Exception:  # noqa: BLE001 — не вышло, играем оригинал
        logger.warning("adts: объект %s не переложен", file_path, exc_info=True)
        _failed.add(source_id)
        return None
