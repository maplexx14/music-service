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
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlsplit

import httpx
from sqlalchemy.orm import Session

from app import storage
from app.cache import record_proxy_traffic, set_cache_async
from app.database import SessionLocal
from app.models import Track
from app.transcode import transcode_to_aac, AAC_EXT, AAC_CONTENT_TYPE
from app.acoustic_features import ANALYZER_VERSION, analyze_file

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
_DL_TIMEOUT = httpx.Timeout(30.0, read=300.0)


def _download_client(
    url: str, shared: httpx.AsyncClient
) -> tuple[httpx.AsyncClient, bool]:
    """Клиент для скачивания аудио по ``url``: (клиент, надо_ли_закрыть).

    googlevideo-ссылка привязана к IP выхода, который её выдал, поэтому при
    проксированном Invidious качать её общим (прямым) клиентом нельзя — придёт
    403. Для всего остального возвращаем общий клиент: обложки и аудио
    SoundCloud к IP не привязаны, и платный трафик на них тратить незачем.
    """
    from app.routers.ytdlp import proxy_for_url

    proxy = proxy_for_url(url)
    if proxy is None:
        return shared, False
    return (
        httpx.AsyncClient(timeout=_DL_TIMEOUT, follow_redirects=True, proxy=proxy),
        True,
    )

# Ограничитель одновременных ленивых архиваций: несколько разных треков подряд
# в плеере не должны запускать десяток параллельных скачиваний в процессе API.
# 5 — баланс между скоростью архивации и нагрузкой на сеть/MinIO.
_LAZY_CONCURRENCY = int(os.getenv("ARCHIVE_LAZY_CONCURRENCY", "5"))
_lazy_sem: Optional[asyncio.Semaphore] = None

# Дедуп ленивых архиваций: пока трек качается, повторные прослушивания
# не должны стартовать вторую задачу на тот же id.
_inflight: set[int] = set()

# Повторная попытка при транзиентных ошибках (сеть, таймаут).
_MAX_RETRIES = 4
_RETRY_DELAY = 2.0

# Размер сегмента при скачивании аудио с googlevideo. Длинный одиночный GET
# CDN троттлит и обрывает на середине (RemoteProtocolError: «peer closed
# connection without sending complete message body»), из-за чего архивация
# крупных треков не доходила до конца ни за одну из _MAX_RETRIES попыток.
# Короткие range-запросы успевают завершиться целиком, а обрыв стоит один
# сегмент вместо всего файла. Тот же приём уже применяется при проксировании
# стрима (ytdlp._SEGMENT).
_SEGMENT = 1 << 20  # 1 MiB
# Подряд идущие безрезультатные попытки одного сегмента, после которых сдаёмся.
_SEGMENT_RETRIES = 3


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
    # Источник ограничил наш IP (bot-check YouTube). Отдельно от TRANSIENT
    # СПЕЦИАЛЬНО: ретрай-циклы повторяют только TRANSIENT/FAILED, а здесь
    # повторять нельзя — блокировка снимается тишиной, и каждая повторная
    # попытка её продлевает. Архивация ленивая, так что следующее
    # прослушивание запустит её заново, когда бэкофф истечёт.
    BLOCKED = "blocked:source-rate-limit"
    FAILED = "failed"


class _TooLarge(Exception):
    """Внутренний сигнал: файл превысил MAX_AUDIO_BYTES во время скачивания."""


def _audio_content_type(ext: str) -> str:
    return _AUDIO_CT.get(ext.lower(), "audio/mpeg")


async def _note_archived(source: str, external_id: str, file_path: str) -> None:
    """Публикует путь свежей архивной копии в кэш, который читают стрим-эндпоинты.

    Провайдерские стримы ищут архив через ``archive:path:<source>/<id>``
    (см. ytdlp.archived_music_path) и кэшируют промах на несколько минут. Без
    этой записи только что заархивированный трек продолжал бы играться
    медленным путём резолва до истечения negative-TTL.
    """
    await set_cache_async(f"archive:path:{source}/{external_id}", file_path, expire=24 * 3600)


async def _note_acoustic_features(
    source: str, external_id: str, features: Optional[dict]
) -> None:
    """Retain analysis until an archived provider item is materialized."""
    if features:
        await set_cache_async(
            f"archive:acoustic:{source}/{external_id}",
            features,
            expire=24 * 3600,
        )


async def adopt_local_file(source: str, external_id: str, local_path: str) -> Optional[str]:
    """Кладёт уже готовый локальный файл в MinIO как архивную копию трека.

    Обычный путь архивации сам резолвит и качает аудио. Но есть источники, где
    файл уже собран на нашей стороне и повторно скачать его нечем: SoundCloud
    HLS-only треки ремуксятся ffmpeg'ом в дисковый кэш прямо на стриме
    (см. soundcloud._stream_via_hls), и этот же файл имеет смысл сохранить —
    дисковый кэш вытесняется по LRU, а MinIO нет.

    Возвращает file_path в MinIO или None, если архивация невозможна/не нужна.
    """
    if not storage.is_minio_backend():
        return None
    if source not in ARCHIVABLE_SOURCES or not external_id:
        return None
    if not local_path or not os.path.exists(local_path):
        return None

    ext = os.path.splitext(local_path)[1].lower() or ".m4a"
    key = f"external/{source}/{external_id}{ext}"
    acoustic_features = await asyncio.to_thread(analyze_file, local_path)
    try:
        storage.ensure_buckets()
        file_path = await asyncio.to_thread(
            storage.upload_music_file, local_path, key, _audio_content_type(ext)
        )
    except Exception:  # noqa: BLE001 — трек уже играет с диска, архив не критичен
        logger.exception("adopt: не удалось загрузить %s/%s в MinIO", source, external_id)
        return None

    await _note_archived(source, external_id, file_path)
    await _note_acoustic_features(source, external_id, acoustic_features)

    # Привязываем объект к записи в БД, чтобы /tracks/{id}/stream отдавал трек
    # прямо из MinIO, а ленивая архивация больше не бралась за него.
    db = SessionLocal()
    try:
        track = (
            db.query(Track)
            .filter(Track.source == source, Track.external_id == str(external_id))
            .first()
        )
        if track is not None and not storage.is_minio_path(track.file_path):
            track.file_path = file_path
            if acoustic_features:
                track.acoustic_features = acoustic_features
                track.acoustic_analyzed_at = datetime.now(timezone.utc)
                track.acoustic_analyzer_version = ANALYZER_VERSION
            db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.exception("adopt: не удалось привязать %s/%s к записи", source, external_id)
    finally:
        db.close()

    logger.info("adopt: %s/%s → %s", source, external_id, file_path)
    return file_path


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


async def _resolve_for_track(track: Track, force: bool = False) -> tuple[str, str, Optional[int]]:
    """Резолв прямого аудио-URL по источнику трека → (url, ext, total).

    Бросает TrackUnavailable / TransientResolveError (и BotCheckError как
    подтип второго) из ytdlp, а также _NoPermalink для soundcloud без
    валидного permalink в stream_url. ``force`` игнорирует кэш резолва —
    нужен на повторных попытках, когда скачивание не пошло: закэшированная
    ссылка CDN могла протухнуть, и повторять её бессмысленно.
    """
    if track.source == "ytmusic":
        # Ленивый импорт: у ytdlp тяжёлые импорты (yt_dlp) — тянем только когда нужно.
        # Через _resolve_cached, а не _resolve_audio: архивация запускается
        # fire-and-forget из стрим-эндпоинта, который секунду назад резолвил
        # ЭТОТ же ролик, — кэш (и single-flight внутри него) отдаёт готовый URL
        # вместо второго обращения к YouTube. Плюс в кэше живут негативные
        # записи (bot-check/transient): архивация больше не долбит YouTube,
        # когда он уже ответил «хватит», — а именно этот лишний поток запросов
        # и продлевал временную блокировку.
        from app.routers.ytdlp import _resolve_cached

        url, ext, total, _fresh = await _resolve_cached(track.external_id, force=force)
        return url, ext, total

    if track.source == "soundcloud":
        from app.routers.soundcloud import _resolve_cached

        permalink = _sc_permalink_from_track(track)
        if not permalink:
            raise _NoPermalink()
        url, ext, total, _fresh = await _resolve_cached(
            track.external_id, permalink, force=force
        )
        return url, ext, total

    raise _Unsupported()


class _NoPermalink(Exception):
    """SoundCloud-трек без пригодного permalink в stream_url."""


class _Unsupported(Exception):
    """Источник трека не поддерживает детерминированную архивацию."""


def _content_range_total(header: Optional[str]) -> Optional[int]:
    """Полный размер файла из заголовка ``Content-Range: bytes a-b/total``."""
    if not header or "/" not in header:
        return None
    tail = header.rsplit("/", 1)[-1].strip()
    return int(tail) if tail.isdigit() else None


async def _download_to_temp(
    url: str,
    suffix: str,
    client: httpx.AsyncClient,
    resume_path: Optional[str] = None,
) -> tuple[str, int]:
    """Скачивает url во временный файл с поддержкой Resume (Range requests).

    Если resume_path указан и файл существует — продолжает с того места,
    где остановились, отправляя заголовок Range. Иначе создаёт новый файл.
    Возвращает (путь, итоговый размер). Чистит за собой при ошибке.
    """
    if resume_path and os.path.exists(resume_path):
        tmp_path = resume_path
    else:
        fd, tmp_path = tempfile.mkstemp(suffix=suffix)
        os.close(fd)

    state_path = tmp_path + ".state"
    proxy = None
    if "googlevideo.com" in (urlsplit(url).hostname or "").lower():
        from app.routers.ytdlp import proxy_for_url

        proxy = proxy_for_url(url)
    size = 0
    ok = False

    try:
        # Восстанавливаем размер предыдущей попытки
        if os.path.exists(state_path):
            try:
                size = int(open(state_path).read().strip())
            except (ValueError, OSError):
                size = 0
        elif os.path.exists(tmp_path):
            size = os.path.getsize(tmp_path)

        if size > 0:
            logger.info("resume download from byte %d for %s", size, url)

        # Тянем файл короткими range-сегментами: см. _SEGMENT. Обрыв внутри
        # сегмента стоит только этот сегмент — прогресс на диске сохраняется,
        # и повтор продолжает с той же позиции, а не с нуля.
        total: Optional[int] = None
        stalled = 0
        # Сервер игнорирует Range и всегда отдаёт файл целиком: тогда первый же
        # 200-ответ и есть весь файл, а следующий range-запрос вернул бы его
        # заново — без этого флага цикл перекачивал бы файл вечно.
        ignores_range = False
        with os.fdopen(
            os.open(
                tmp_path,
                os.O_WRONLY | os.O_CREAT | (os.O_APPEND if size > 0 else os.O_TRUNC),
            ),
            "ab" if size > 0 else "wb",
        ) as fh:
            while total is None or size < total:
                end = size + _SEGMENT - 1
                if total is not None:
                    end = min(end, total - 1)
                got = 0
                try:
                    async with client.stream(
                        "GET", url, headers={"Range": f"bytes={size}-{end}"}
                    ) as resp:
                        # Сервер проигнорировал Range и отдаёт файл с начала:
                        # продолжать с середины нельзя — начинаем заново.
                        if resp.status_code == 200 and size > 0:
                            logger.info(
                                "server does not support range, restarting download"
                            )
                            fh.seek(0)
                            fh.truncate()
                            size = 0
                            total = None
                            stalled = 0
                            ignores_range = True
                            continue
                        if resp.status_code == 200:
                            ignores_range = True
                        # 416 на возобновлении: запрошенный диапазон за концом
                        # файла — состояние с прошлой попытки не соответствует
                        # этой ссылке (другой itag/битрейт). Целостность важнее
                        # экономии трафика: качаем с нуля.
                        if resp.status_code == 416 and size > 0:
                            logger.info(
                                "stale resume state for %s (416 @%d), restarting",
                                url, size,
                            )
                            fh.seek(0)
                            fh.truncate()
                            size = 0
                            total = None
                            stalled = 0
                            continue
                        resp.raise_for_status()
                        if total is None:
                            total = _content_range_total(
                                resp.headers.get("content-range")
                            )
                        async for chunk in resp.aiter_bytes(256 * 1024):
                            record_proxy_traffic(proxy, len(chunk))
                            fh.write(chunk)
                            size += len(chunk)
                            got += len(chunk)
                            if MAX_AUDIO_BYTES and size > MAX_AUDIO_BYTES:
                                raise _TooLarge()
                except httpx.HTTPError as exc:
                    # Обрыв/таймаут внутри сегмента: то, что успели записать,
                    # уже на диске. Повторяем сегмент с новой позиции.
                    if got == 0:
                        stalled += 1
                        if stalled > _SEGMENT_RETRIES:
                            raise
                        logger.info(
                            "archive segment @%d failed for %s (%s), retry %d/%d",
                            size, url, exc, stalled, _SEGMENT_RETRIES,
                        )
                        continue
                    logger.info(
                        "archive segment @%d truncated for %s (%s), continuing",
                        size, url, exc,
                    )
                else:
                    # Пустой ответ без ошибки — тоже отсутствие прогресса,
                    # иначе цикл мог бы вращаться вечно на мёртвой ссылке.
                    if got == 0:
                        stalled += 1
                        if stalled > _SEGMENT_RETRIES:
                            break
                        continue
                fh.flush()
                stalled = 0
                try:
                    open(state_path, "w").write(str(size))
                except OSError:
                    pass
                # Ответ 200 — тело было целым файлом, докачивать нечего.
                if ignores_range:
                    break
                # Размер неизвестен (CDN не отдал content-range), а последний
                # сегмент оказался короче запрошенного — значит это конец файла.
                if total is None and got < _SEGMENT:
                    break

        # Недокачанный файл наверх не отдаём. Транскод усечённого аудио может
        # завершиться «успешно» (а при недоступном ffmpeg вообще идёт
        # passthrough), и в MinIO уехал бы обрезанный трек — навсегда, т.к.
        # архивный объект считается готовым и больше не перекачивается.
        # Прогресс на диске остаётся: следующая попытка продолжит с resume.
        if total is not None and size < total:
            raise httpx.RemoteProtocolError(
                f"incomplete download: {size} of {total} bytes"
            )

        ok = True
        return tmp_path, size
    finally:
        # Чистим state-файл при успехе
        if ok and os.path.exists(state_path):
            try:
                os.remove(state_path)
            except OSError:
                pass
        if not ok:
            # Оставляем temp-файл для resume на следующей попытке
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
    resume_path: Optional[str] = None,
    force_resolve: bool = False,
) -> tuple[str, Optional[str]]:
    """Архивирует один внешний трек в MinIO и обновляет запись в БД.

    Возвращает (статус, tmp_path). tmp_path сохраняется для retry с resume.
    Идемпотентно: уже заархивированный трек (file_path вида minio://) не трогается.
    ``force_resolve`` — резолвить ссылку заново, минуя кэш (см. _resolve_for_track).
    """
    from app.routers.ytdlp import BotCheckError, TrackUnavailable, TransientResolveError

    if track.source == "local":
        return ArchiveResult.LOCAL, None
    if storage.is_minio_path(track.file_path):
        return ArchiveResult.ALREADY, None
    if track.source not in ARCHIVABLE_SOURCES:
        return ArchiveResult.UNSUPPORTED, None
    if not track.external_id:
        return ArchiveResult.NO_ID, None

    storage.ensure_buckets()

    owns_client = client is None
    client = client or httpx.AsyncClient(timeout=_DL_TIMEOUT, follow_redirects=True)
    saved_tmp = None
    try:
        try:
            url, ext, _total = await _resolve_for_track(track, force=force_resolve)
        except TrackUnavailable:
            return ArchiveResult.UNAVAILABLE, None
        except BotCheckError:
            # Раньше проваливалось в TransientResolveError (BotCheckError — его
            # подкласс) и ретраилось 4 раза по 2с, то есть архивация сама
            # доливала запросов в уже сработавший rate-limit.
            return ArchiveResult.BLOCKED, None
        except TransientResolveError:
            return ArchiveResult.TRANSIENT, None
        except _NoPermalink:
            return ArchiveResult.NO_PERMALINK, None
        except _Unsupported:
            return ArchiveResult.UNSUPPORTED, None

        key = f"external/{track.source}/{track.external_id}{ext}"
        dl_client, dl_owned = _download_client(url, client)
        try:
            tmp_path, _size = await _download_to_temp(url, ext, dl_client, resume_path=resume_path)
            saved_tmp = tmp_path
        except _TooLarge:
            logger.info("archive: трек %s превысил лимит размера, пропуск", track.id)
            return ArchiveResult.TOO_LARGE, None
        finally:
            if dl_owned:
                await dl_client.aclose()

        # Transcode to AAC for smaller, faster-loading files
        aac_path = transcode_to_aac(tmp_path)
        if aac_path != tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            tmp_path = aac_path
            ext = AAC_EXT
            key = f"external/{track.source}/{track.external_id}{ext}"

        acoustic_features = await asyncio.to_thread(analyze_file, tmp_path)

        try:
            file_path = storage.upload_music_file(tmp_path, key, _audio_content_type(ext))
        finally:
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass

        await _note_archived(track.source, track.external_id, file_path)
        await _note_acoustic_features(
            track.source, track.external_id, acoustic_features
        )

        # Обложку архивируем отдельно и best-effort: её отсутствие не должно
        # ронять архивацию аудио.
        new_cover = await _archive_cover(track, f"{track.source}/{track.external_id}", client)

        # Обновляем запись атомарно: file_path → MinIO, source сохраняем.
        track.file_path = file_path
        if acoustic_features:
            track.acoustic_features = acoustic_features
            track.acoustic_analyzed_at = datetime.now(timezone.utc)
            track.acoustic_analyzer_version = ANALYZER_VERSION
        if new_cover:
            track.cover_url = new_cover
        db.commit()
        return ArchiveResult.ARCHIVED, None
    except Exception:
        db.rollback()
        logger.exception("archive: не удалось заархивировать трек %s", track.id)
        return ArchiveResult.FAILED, saved_tmp
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
                resume_tmp = None
                for attempt in range(_MAX_RETRIES + 1):
                    # Ссылку из кэша берём только на первой попытке: если
                    # скачивание не пошло, самая вероятная причина — протухшая
                    # ссылка CDN, и повторять её из кэша бессмысленно.
                    status, tmp_path = await archive_track(
                        db, track, resume_path=resume_tmp, force_resolve=attempt > 0
                    )
                    if status not in (ArchiveResult.TRANSIENT, ArchiveResult.FAILED):
                        # Clean up any leftover temp file on success
                        if tmp_path and os.path.exists(tmp_path):
                            try:
                                os.remove(tmp_path)
                            except OSError:
                                pass
                        break
                    resume_tmp = tmp_path
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
    resume_path: Optional[str] = None,
    force_resolve: bool = False,
) -> tuple[str, Optional[str]]:
    """Резолвит → скачивает → кладёт внешний трек в MinIO по (source, external_id).

    Возвращает (статус, tmp_path). tmp_path сохраняется для retry с resume.
    Не требует DB-записи: ключ объекта детерминирован (external/<source>/<id>).
    Если track передан — обновляет его file_path/cover_url, чтобы повторные
    прослушивания шли через /tracks/{id}/stream уже из MinIO.
    ``force_resolve`` — резолвить ссылку заново, минуя кэш (см. _resolve_for_track).
    """
    from app.routers.ytdlp import BotCheckError, TrackUnavailable, TransientResolveError

    client = httpx.AsyncClient(timeout=_DL_TIMEOUT, follow_redirects=True)
    saved_tmp = None
    try:
        try:
            if source == "ytmusic":
                # _resolve_cached, а не _resolve_audio: см. _resolve_for_track —
                # стрим-эндпоинт, из которого нас и позвали, только что
                # резолвил этот ролик, и его результат (как и негативную
                # запись про bot-check) надо переиспользовать, а не идти к
                # YouTube второй раз.
                from app.routers.ytdlp import _resolve_cached as _resolve_yt

                url, ext, _total, _fresh = await _resolve_yt(
                    external_id, force=force_resolve
                )
            elif source == "soundcloud":
                if not permalink:
                    return ArchiveResult.NO_PERMALINK, None
                from app.routers.soundcloud import _resolve_cached

                url, ext, _total, _fresh = await _resolve_cached(
                    external_id, permalink, force=force_resolve
                )
            else:
                return ArchiveResult.UNSUPPORTED, None
        except TrackUnavailable:
            return ArchiveResult.UNAVAILABLE, None
        except BotCheckError:
            # Не TRANSIENT: ретраить bot-check нельзя, см. ArchiveResult.BLOCKED.
            return ArchiveResult.BLOCKED, None
        except TransientResolveError:
            return ArchiveResult.TRANSIENT, None

        storage.ensure_buckets()
        key = f"external/{source}/{external_id}{ext}"
        dl_client, dl_owned = _download_client(url, client)
        try:
            tmp_path, _size = await _download_to_temp(url, ext, dl_client, resume_path=resume_path)
            saved_tmp = tmp_path
        except _TooLarge:
            logger.info("archive-ext: %s/%s превысил лимит размера, пропуск", source, external_id)
            return ArchiveResult.TOO_LARGE, None
        finally:
            if dl_owned:
                await dl_client.aclose()

        # Transcode to AAC for smaller, faster-loading files
        aac_path = transcode_to_aac(tmp_path)
        if aac_path != tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            tmp_path = aac_path
            ext = AAC_EXT
            key = f"external/{source}/{external_id}{ext}"

        # Compute the content profile while the downloaded bytes are still
        # local.  The archive path may later be linked to a Track row; retain
        # the result there when one is already materialized.
        acoustic_features = await asyncio.to_thread(analyze_file, tmp_path)

        try:
            file_path = storage.upload_music_file(tmp_path, key, _audio_content_type(ext))
        finally:
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass

        await _note_archived(source, external_id, file_path)
        await _note_acoustic_features(source, external_id, acoustic_features)

        # Если трек уже материализован — привязываем объект к записи и архивируем
        # обложку. Если записи нет (трек играется из поиска/потока) — объект
        # просто лежит в MinIO и будет подхвачен при последующем импорте (find_music_object).
        if track is not None and not storage.is_minio_path(track.file_path):
            track.file_path = file_path
            if acoustic_features:
                track.acoustic_features = acoustic_features
                track.acoustic_analyzed_at = datetime.now(timezone.utc)
                track.acoustic_analyzer_version = ANALYZER_VERSION
            new_cover = await _archive_cover(track, f"{source}/{external_id}", client)
            if new_cover:
                track.cover_url = new_cover
            db.commit()
        return ArchiveResult.ARCHIVED, None
    except Exception:
        db.rollback()
        logger.exception("archive-ext: не удалось заархивировать %s/%s", source, external_id)
        return ArchiveResult.FAILED, saved_tmp
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
            # Наличие объекта берём через кэш пути (Redis), который читает и сам
            # стрим — на повторных прослушиваниях это вообще без сети к MinIO.
            # Проверка ПОД семафором: до него сетевой вызов замедлял бы каждый
            # стрим-запрос, а под нагрузкой блокировал очередь архиваций.
            from app.routers.ytdlp import archived_music_path

            existing = await archived_music_path(f"{source}/{external_id}")
            db = SessionLocal()
            try:
                # SQL — блокирующий вызов, а мы висим на том же event loop, что
                # и живые стримы (архивация запускается из стрим-эндпоинта).
                track = await asyncio.to_thread(
                    lambda: db.query(Track)
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
                resume_tmp = None
                for attempt in range(_MAX_RETRIES + 1):
                    # force_resolve со второй попытки — см. schedule_archive.
                    status, tmp_path = await _archive_external_core(
                        db, source, external_id, permalink, track,
                        resume_path=resume_tmp, force_resolve=attempt > 0,
                    )
                    if status not in (ArchiveResult.TRANSIENT, ArchiveResult.FAILED):
                        if tmp_path and os.path.exists(tmp_path):
                            try:
                                os.remove(tmp_path)
                            except OSError:
                                pass
                        break
                    resume_tmp = tmp_path
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
