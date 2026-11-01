"""Новые копии SoundCloud: отдельный архив, который не содержит старую цензуру.

Поколение фиксировано, а не привязано к старту воркера. Только полная новая
загрузка SoundCloud публикует объект под этим ключом; прежние архивы и
дисковый кэш не усыновляются. Ключ по id каталога переживает потерю SC-матча.
"""

import asyncio
import logging
import os

from app import external_archive, storage
from app.cache import get_cache_async, set_cache_async

logger = logging.getLogger(__name__)

_SOURCE = "soundcloud-originals-v1"
_inflight: set[str] = set()


def archive_key(video_id: str) -> str:
    return f"{_SOURCE}/{video_id}"


def cache_id(video_id: str, track_id: str) -> str:
    return f"scorig1-{video_id}-{track_id}"


async def archived_path(video_id: str):
    from app.routers.ytdlp import archived_music_path

    return await archived_music_path(archive_key(video_id))


async def stream_from_archive(video_id: str, request):
    """Свежая SC-копия раньше поиска матча; нет/пропала — обычный подбор."""
    path = await archived_path(video_id)
    if not path:
        return None
    try:
        return await storage.minio_range_response_async(
            path, request, quality=request.query_params.get("quality")
        )
    except Exception as exc:  # noqa: BLE001 — воспроизведение продолжится из SC
        if isinstance(exc, storage.ObjectMissing):
            await set_cache_async(f"archive:path:{archive_key(video_id)}", "", expire=300)
        logger.warning("SoundCloud original archive unavailable for %s", video_id, exc_info=True)
        return None


async def prefetch_archive(video_id: str) -> bool:
    path = await archived_path(video_id)
    if not path:
        return False
    try:
        await storage.warm_music_object(path)
    except Exception:  # noqa: BLE001 — удалённую копию всё ещё может отдать стрим
        logger.warning("SoundCloud original archive warm failed for %s", video_id, exc_info=True)
    return True


async def archive(video_id: str, track_id: str, permalink: str) -> None:
    """Публикует новый архив только после полной загрузки с SoundCloud."""
    if not storage.is_minio_backend() or video_id in _inflight:
        return
    _inflight.add(video_id)
    resume_path = None
    fail_key = external_archive._fail_key(_SOURCE, video_id)
    try:
        if await get_cache_async(fail_key):
            return
        if external_archive._lazy_sem is None:
            external_archive._lazy_sem = asyncio.Semaphore(external_archive._LAZY_CONCURRENCY)
        async with external_archive._lazy_sem:
            if await archived_path(video_id):
                return
            from app.routers import soundcloud, ytdlp

            target = archive_key(video_id)
            fresh_cache_id = cache_id(video_id, track_id)
            for attempt in range(external_archive._MAX_RETRIES + 1):
                # Только файл нового поколения: старый sc<id> мог быть
                # скачан до смены политики, его здесь не используем.
                local = await asyncio.to_thread(ytdlp._cached_file, fresh_cache_id)
                if local:
                    path = await external_archive.adopt_local_file(
                        "soundcloud", track_id, local, archive_key=target
                    )
                    status = (external_archive.ArchiveResult.ARCHIVED if path
                              else external_archive.ArchiveResult.UPLOAD_FAILED)
                else:
                    status, resume_path = await external_archive._archive_external_core(
                        None, "soundcloud", track_id, permalink, None,
                        resume_path=resume_path, force_resolve=attempt > 0, archive_key=target,
                    )
                    if status == external_archive.ArchiveResult.TRANSIENT:
                        local = await soundcloud._ensure_hls_cached(track_id, cache_id=fresh_cache_id)
                        if local:
                            path = await external_archive.adopt_local_file(
                                "soundcloud", track_id, local, archive_key=target
                            )
                            status = (external_archive.ArchiveResult.ARCHIVED if path
                                      else external_archive.ArchiveResult.UPLOAD_FAILED)
                if status not in (external_archive.ArchiveResult.TRANSIENT,
                                   external_archive.ArchiveResult.FAILED):
                    break
                if attempt < external_archive._MAX_RETRIES:
                    await asyncio.sleep(external_archive._RETRY_DELAY)
            if status in external_archive._REMEMBERED_FAILURES:
                await set_cache_async(fail_key, status, expire=external_archive.ARCHIVE_FAIL_TTL)
    except Exception:  # noqa: BLE001 — фоновая архивация не останавливает плеер
        logger.exception("SoundCloud original archive failed for %s", video_id)
    finally:
        if resume_path:
            try:
                os.remove(resume_path)
            except OSError:
                pass
        _inflight.discard(video_id)
