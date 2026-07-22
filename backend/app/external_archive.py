"""Архивация внешних треков (ytmusic, soundcloud) в объектное хранилище MinIO.

Идея: у внешнего трека в БД нет файла — поток резолвится на лету при каждом
воспроизведении (yt-dlp → googlevideo / cf-media). Это медленно и хрупко (ссылка
живёт минуты-часы, трек может стать недоступным). Архивация один раз скачивает
аудио и кладёт его в MinIO; после этого stream-эндпоинт отдаёт трек presigned-
ссылкой напрямую из MinIO, а source в БД сохраняется прежним (нужен рекомендациям).

Два способа запуска:
    * schedule_archive() — ленивое кэширование при прослушивании (фоновая
      задача, повешенная на redirect в routers/tracks.py);
    * archive_track()    — единичная архивация, используется и лениво, и из
      скрипта массовой архивации (app.scripts.archive_external_to_minio).

Поддерживаются ytmusic и soundcloud — у обоих есть детерминированный резолвер
(ytmusic по videoId; soundcloud по permalink, который лежит в stream_url трека).
Soulseek — P2P через slskd: файл доступен, лишь пока раздающий пир онлайн,
поэтому архивация для него ненадёжна и не выполняется.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import logging
import mimetypes
import os
import tempfile
from typing import Optional
from urllib.parse import urlsplit

import httpx
from sqlalchemy.orm import Session

from app import storage
from app.database import SessionLocal
from app.models import Track

logger = logging.getLogger(__name__)

# Источники с детерминированным резолвом, которые умеем архивировать.
ARCHIVABLE_SOURCES = {"ytmusic", "soundcloud"}

# Расширение аудио → content-type для корректной отдачи из MinIO.
_AUDIO_CT = {
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".opus": "audio/ogg",
    ".ogg": "audio/ogg",
    ".webm": "audio/webm",
}

# Верхняя граница размера аудио: защита от гигантских «треков» (напр. многочасовых
# миксов), которые способны забить хранилище. 0 = без ограничения.
MAX_AUDIO_BYTES = int(os.getenv("ARCHIVE_MAX_AUDIO_BYTES", str(60 * 1024 * 1024)))

# Таймаут на скачивание одного трека (соединение, чтение).
_DL_TIMEOUT = httpx.Timeout(20.0, read=120.0)

# Ограничитель одновременных ленивых архиваций: несколько разных треков подряд
# в плеере не должны запускать десяток параллельных скачиваний в процессе API.
# 5 — баланс между скоростью архивации и нагрузкой на сеть/MinIO.
_LAZY_CONCURRENCY = int(os.getenv("ARCHIVE_LAZY_CONCURRENCY", "5"))
_lazy_sem: Optional[asyncio.Semaphore] = None

# Дедуп ленивых архиваций: пока трек качается, повторные прослушивания
# не должны стартовать вторую задачу на тот же id.
_inflight: set[int] = set()

# Повторная попытка при транзиентных ошибках (сеть, таймаут).
_MAX_RETRIES = 2
_RETRY_DELAY = 2.0


class ArchiveResult:
    """Строковые статусы результата (для агрегированной статистики в скрипте)."""

    ARCHIVED = "archived"
    ALREADY = "skipped:already-archived"
    LOCAL = "skipped:local"
    NO_ID = "skipped:no-external-id"
    UNSUPPORTED = "skipped:unsupported-source"
    NO_PERMALINK = "skipped:no-permalink"
    TOO_LARGE = "skipped:too-large"
    UNAVAILABLE = "unavailable"
    TRANSIENT = "transient-error"
    FAILED = "failed"


class _TooLarge(Exception):
    """Внутренний сигнал: файл превысил MAX_AUDIO_BYTES во время скачивания."""


def _audio_content_type(ext: str) -> str:
    return _AUDIO_CT.get(ext.lower(), "audio/mpeg")


def _sc_permalink_from_track(track: Track) -> Optional[str]:
    """Достаёт SoundCloud-permalink из stream_url трека.

    stream_url имеет вид …/api/soundcloud/stream/<token>, где token — это
    base64url("<track_id>|<permalink>"). Резолв SoundCloud требует именно
    permalink (в нём слуг пользователя), поэтому достаём его отсюда.
    """
    url = track.stream_url or ""
    marker = "/api/soundcloud/stream/"
    idx = url.find(marker)
    if idx < 0:
        return None
    token = url[idx + len(marker):].split("?", 1)[0].strip("/")
    if not token:
        return None
    pad = "=" * (-len(token) % 4)
    try:
        raw = base64.urlsafe_b64decode(token + pad).decode("utf-8")
        _track_id, permalink = raw.split("|", 1)
    except (binascii.Error, ValueError, UnicodeDecodeError):
        return None
    if not permalink.startswith("https://soundcloud.com/"):
        return None
    return permalink


async def _resolve_for_track(track: Track) -> tuple[str, str, Optional[int]]:
    """Резолв прямого аудио-URL по источнику трека → (url, ext, total).

    Бросает TrackUnavailable / TransientResolveError из ytdlp, а также
    _NoPermalink для soundcloud без валидного permalink в stream_url.
    """
    if track.source == "ytmusic":
        # Ленивый импорт: у ytdlp тяжёлые импорты (yt_dlp) — тянем только когда нужно.
        from app.routers.ytdlp import _resolve_audio

        return await _resolve_audio(track.external_id)

    if track.source == "soundcloud":
        from app.routers.soundcloud import _resolve_cached

        permalink = _sc_permalink_from_track(track)
        if not permalink:
            raise _NoPermalink()
        url, ext, total, _fresh = await _resolve_cached(track.external_id, permalink)
        return url, ext, total

    raise _Unsupported()


class _NoPermalink(Exception):
    """SoundCloud-трек без пригодного permalink в stream_url."""


class _Unsupported(Exception):
    """Источник трека не поддерживает детерминированную архивацию."""


async def _download_to_temp(url: str, suffix: str, client: httpx.AsyncClient) -> tuple[str, int]:
    """Скачивает url во временный файл. Возвращает (путь, размер). Чистит за собой при ошибке."""
    fd, tmp_path = tempfile.mkstemp(suffix=suffix)
    size = 0
    ok = False
    try:
        with os.fdopen(fd, "wb") as fh:
            async with client.stream("GET", url) as resp:
                resp.raise_for_status()
                async for chunk in resp.aiter_bytes(256 * 1024):
                    fh.write(chunk)
                    size += len(chunk)
                    # Прерываем скачивание, если файл превысил лимит: незачем
                    # тянуть весь многочасовой микс, чтобы потом его отбросить.
                    if MAX_AUDIO_BYTES and size > MAX_AUDIO_BYTES:
                        raise _TooLarge()
        ok = True
        return tmp_path, size
    finally:
        if not ok and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


def _cover_ext(url: str, content_type: Optional[str]) -> str:
    """Определяет расширение обложки по content-type, затем по URL, иначе .jpg."""
    if content_type:
        guessed = mimetypes.guess_extension(content_type.split(";")[0].strip())
        if guessed:
            return ".jpg" if guessed == ".jpe" else guessed
    path_ext = os.path.splitext(urlsplit(url).path)[1]
    return path_ext if path_ext else ".jpg"


async def _archive_cover(track: Track, external_key: str, client: httpx.AsyncClient) -> Optional[str]:
    """Скачивает http(s)-обложку внешнего трека в публичный бакет. Возвращает новый URL или None.

    Повторяет при сетевых ошибках (до _MAX_RETRIES раз), т.к. обложки —
    маленькие файлы, и единичный таймаут не должен лишать трек обложки навсегда.
    """
    cover_url = track.cover_url
    if not cover_url or not cover_url.startswith(("http://", "https://")):
        return None  # обложки нет или она уже локальная/в MinIO
    # Обложка — маленький файл; отдельный таймаут короче аудио-клиента.
    cover_timeout = httpx.Timeout(10.0, read=15.0)
    for attempt in range(_MAX_RETRIES + 1):
        try:
            async with httpx.AsyncClient(timeout=cover_timeout, follow_redirects=True) as c:
                async with c.stream("GET", cover_url) as resp:
                    resp.raise_for_status()
                    ct = resp.headers.get("content-type")
                    ext = _cover_ext(cover_url, ct)
                    fd, tmp_path = tempfile.mkstemp(suffix=ext)
                    try:
                        with os.fdopen(fd, "wb") as fh:
                            async for chunk in resp.aiter_bytes(128 * 1024):
                                fh.write(chunk)
                        key = f"external/{external_key}{ext}"
                        return storage.upload_cover_file(tmp_path, key, ct or "image/jpeg")
                    finally:
                        if os.path.exists(tmp_path):
                            try:
                                os.remove(tmp_path)
                            except OSError:
                                pass
        except Exception as exc:
            if attempt < _MAX_RETRIES:
                logger.warning(
                    "archive: обложка для %s попытка %d/%d не удалась: %s, повтор",
                    track.id, attempt + 1, _MAX_RETRIES, exc,
                )
                await asyncio.sleep(_RETRY_DELAY)
            else:
                logger.info("archive: обложка не скачалась для %s после %d попыток: %s",
                            track.id, _MAX_RETRIES + 1, exc)
    return None


async def archive_track(
    db: Session,
    track: Track,
    client: Optional[httpx.AsyncClient] = None,
) -> str:
    """Архивирует один внешний трек в MinIO и обновляет запись в БД.

    Возвращает один из статусов ArchiveResult. Идемпотентно: уже
    заархивированный трек (file_path вида minio://) не трогается.
    """
    from app.routers.ytdlp import TrackUnavailable, TransientResolveError

    if track.source == "local":
        return ArchiveResult.LOCAL
    if storage.is_minio_path(track.file_path):
        return ArchiveResult.ALREADY
    if track.source not in ARCHIVABLE_SOURCES:
        return ArchiveResult.UNSUPPORTED
    if not track.external_id:
        return ArchiveResult.NO_ID

    storage.ensure_buckets()

    owns_client = client is None
    client = client or httpx.AsyncClient(timeout=_DL_TIMEOUT, follow_redirects=True)
    try:
        try:
            url, ext, _total = await _resolve_for_track(track)
        except TrackUnavailable:
            return ArchiveResult.UNAVAILABLE
        except TransientResolveError:
            return ArchiveResult.TRANSIENT
        except _NoPermalink:
            return ArchiveResult.NO_PERMALINK
        except _Unsupported:
            return ArchiveResult.UNSUPPORTED

        key = f"external/{track.source}/{track.external_id}{ext}"
        try:
            tmp_path, _size = await _download_to_temp(url, ext, client)
        except _TooLarge:
            logger.info("archive: трек %s превысил лимит размера, пропуск", track.id)
            return ArchiveResult.TOO_LARGE

        try:
            file_path = storage.upload_music_file(tmp_path, key, _audio_content_type(ext))
        finally:
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass

        # Обложку архивируем отдельно и best-effort: её отсутствие не должно
        # ронять архивацию аудио.
        new_cover = await _archive_cover(track, f"{track.source}/{track.external_id}", client)

        # Обновляем запись атомарно: file_path → MinIO, source сохраняем.
        track.file_path = file_path
        if new_cover:
            track.cover_url = new_cover
        db.commit()
        return ArchiveResult.ARCHIVED
    except Exception:
        db.rollback()
        logger.exception("archive: не удалось заархивировать трек %s", track.id)
        return ArchiveResult.FAILED
    finally:
        if owns_client:
            await client.aclose()


async def schedule_archive(track_id: int) -> None:
    """Ленивая фоновая архивация одного трека при прослушивании.

    Fire-and-forget: вешается как BackgroundTask на redirect стрима внешнего
    трека. Дедупает по track_id (повторные прослушивания не плодят задачи) и
    ограничивает общую параллельность семафором. Все ошибки логируются, но
    наружу не пробрасываются — воспроизведение не должно ломаться из-за
    неудачной фоновой архивации.
    """
    global _lazy_sem
    if not storage.is_minio_backend():
        return
    if track_id in _inflight:
        return
    _inflight.add(track_id)

    if _lazy_sem is None:
        _lazy_sem = asyncio.Semaphore(_LAZY_CONCURRENCY)

    try:
        async with _lazy_sem:
            db = SessionLocal()
            try:
                track = db.get(Track, track_id)
                if track is None or storage.is_minio_path(track.file_path):
                    return
                if track.source not in ARCHIVABLE_SOURCES:
                    return
                for attempt in range(_MAX_RETRIES + 1):
                    status = await archive_track(db, track)
                    if status not in (ArchiveResult.TRANSIENT, ArchiveResult.FAILED):
                        break
                    if attempt < _MAX_RETRIES:
                        logger.warning(
                            "lazy-archive: трек %s попытка %d/%d — %s, повтор через %.1fs",
                            track_id, attempt + 1, _MAX_RETRIES, status, _RETRY_DELAY,
                        )
                        await asyncio.sleep(_RETRY_DELAY)
                logger.info("lazy-archive: трек %s → %s", track_id, status)
            finally:
                db.close()
    except Exception:
        logger.exception("lazy-archive: ошибка для трека %s", track_id)
    finally:
        _inflight.discard(track_id)


# Дедуп ленивой архивации по (source, external_id) — отдельно от _inflight
# (тот по track_id): сюда приходят вызовы из стрим-эндпоинтов провайдера,
# где DB-записи может ещё не быть (трек играется из поиска/потока).
_inflight_ext: set[str] = set()


async def _archive_external_core(
    db: Session,
    source: str,
    external_id: str,
    permalink: Optional[str],
    track: Optional[Track],
) -> str:
    """Резолвит → скачивает → кладёт внешний трек в MinIO по (source, external_id).

    Не требует DB-записи: ключ объекта детерминирован (external/<source>/<id>).
    Если track передан — обновляет его file_path/cover_url, чтобы повторные
    прослушивания шли через /tracks/{id}/stream уже из MinIO.
    """
    from app.routers.ytdlp import TrackUnavailable, TransientResolveError

    client = httpx.AsyncClient(timeout=_DL_TIMEOUT, follow_redirects=True)
    try:
        try:
            if source == "ytmusic":
                from app.routers.ytdlp import _resolve_audio

                url, ext, _total = await _resolve_audio(external_id)
            elif source == "soundcloud":
                if not permalink:
                    return ArchiveResult.NO_PERMALINK
                from app.routers.soundcloud import _resolve_cached

                url, ext, _total, _fresh = await _resolve_cached(external_id, permalink)
            else:
                return ArchiveResult.UNSUPPORTED
        except TrackUnavailable:
            return ArchiveResult.UNAVAILABLE
        except TransientResolveError:
            return ArchiveResult.TRANSIENT

        storage.ensure_buckets()
        key = f"external/{source}/{external_id}{ext}"
        try:
            tmp_path, _size = await _download_to_temp(url, ext, client)
        except _TooLarge:
            logger.info("archive-ext: %s/%s превысил лимит размера, пропуск", source, external_id)
            return ArchiveResult.TOO_LARGE

        try:
            file_path = storage.upload_music_file(tmp_path, key, _audio_content_type(ext))
        finally:
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass

        # Если трек уже материализован — привязываем объект к записи и архивируем
        # обложку. Если записи нет (трек играется из поиска/потока) — объект
        # просто лежит в MinIO и будет подхвачен при последующем импорте (find_music_object).
        if track is not None and not storage.is_minio_path(track.file_path):
            track.file_path = file_path
            new_cover = await _archive_cover(track, f"{source}/{external_id}", client)
            if new_cover:
                track.cover_url = new_cover
            db.commit()
        return ArchiveResult.ARCHIVED
    except Exception:
        db.rollback()
        logger.exception("archive-ext: не удалось заархивировать %s/%s", source, external_id)
        return ArchiveResult.FAILED
    finally:
        await client.aclose()


async def schedule_archive_external(
    source: str,
    external_id: str,
    permalink: Optional[str] = None,
) -> None:
    """Ленивая фоновая архивация внешнего трека прямо из стрим-эндпоинта провайдера.

    В отличие от schedule_archive (по track_id) работает без DB-записи: внешние
    треки из поиска/потока играются прямо через /ytdlp/stream/{id} и не
    проходят через /tracks/{id}/stream. Вызывается fire-and-forget из
    эндпоинта провайдера на каждом стриме; дедуп по (source, external_id)
    и быстрая проверка наличия объекта делают повторные вызовы (в т.ч. на
    Range-запросы) дешёвыми. Ошибки не пробрасываются — воспроизведение важнее.
    """
    global _lazy_sem
    if not storage.is_minio_backend():
        return
    if source not in ARCHIVABLE_SOURCES or not external_id:
        return

    dedup_key = f"{source}:{external_id}"
    if dedup_key in _inflight_ext:
        return

    _inflight_ext.add(dedup_key)
    if _lazy_sem is None:
        _lazy_sem = asyncio.Semaphore(_LAZY_CONCURRENCY)

    try:
        async with _lazy_sem:
            prefix = f"external/{source}/{external_id}"
            # Проверка наличия объекта ПОД семафором: MinIO list_objects —
            # сетевой вызов, до семафора он замедляет каждый стрим-запрос,
            # а при высокой нагрузке и вовсе блокирует очередь архиваций.
            existing = storage.find_music_object(prefix)
            db = SessionLocal()
            try:
                track = (
                    db.query(Track)
                    .filter(Track.source == source, Track.external_id == external_id)
                    .first()
                )
                if track is not None and storage.is_minio_path(track.file_path):
                    return
                if existing:
                    # Объект заархивирован раньше, чем трек материализовался в
                    # БД (играл строковым id из поиска). Ранний return без
                    # линковки оставлял file_path пустым НАВСЕГДА — трек ходил
                    # по медленному пути резолва провайдера, хотя байты давно
                    # лежат в MinIO. Линкуем — следующий /tracks/{id}/stream
                    # отдаст файл напрямую из MinIO.
                    if track is not None:
                        track.file_path = existing
                        db.commit()
                        logger.info(
                            "lazy-archive-ext: %s/%s → linked existing object", source, external_id
                        )
                    return
                for attempt in range(_MAX_RETRIES + 1):
                    status = await _archive_external_core(db, source, external_id, permalink, track)
                    if status not in (ArchiveResult.TRANSIENT, ArchiveResult.FAILED):
                        break
                    if attempt < _MAX_RETRIES:
                        logger.warning(
                            "lazy-archive-ext: %s/%s попытка %d/%d — %s, повтор через %.1fs",
                            source, external_id, attempt + 1, _MAX_RETRIES, status, _RETRY_DELAY,
                        )
                        await asyncio.sleep(_RETRY_DELAY)
                logger.info("lazy-archive-ext: %s/%s → %s", source, external_id, status)
            finally:
                db.close()
    except Exception:
        logger.exception("lazy-archive-ext: ошибка для %s/%s", source, external_id)
    finally:
        _inflight_ext.discard(dedup_key)
