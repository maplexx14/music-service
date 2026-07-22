"""Массовый транскодинг аудиофайлов в AAC.

Конвертирует все аудиофайлы в MinIO в AAC (128kbps) для уменьшения размера
и ускорения загрузки. Идемпотентно: уже AAC-файлы пропускаются.

Запуск (внутри контейнера backend):
    docker compose exec backend python -m app.scripts.transcode_to_aac
    docker compose exec backend python -m app.scripts.transcode_to_aac --dry-run
    docker compose exec backend python -m app.scripts.transcode_to_aac --bitrate 192
    docker compose exec backend python -m app.scripts.transcode_to_aac --concurrency 2 --limit 50

Требуется STORAGE_BACKEND=minio и ffmpeg в контейнере.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import tempfile
from collections import Counter
from typing import Optional

from app.database import SessionLocal
from app.models import Track
from app import storage
from app.transcode import (
    transcode_to_aac,
    AAC_EXT,
    AAC_CONTENT_TYPE,
    TRANSCODE_ENABLED,
    _ffmpeg_available,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("transcode_to_aac")

# Маппинг расширений → content-type (из external_archive)
_AUDIO_CT = {
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".mp3": "audio/mpeg",
    ".opus": "audio/ogg",
    ".ogg": "audio/ogg",
    ".webm": "audio/webm",
}


def _candidate_tracks(limit: Optional[int] = None) -> list[Track]:
    """Треки в MinIO, которые ещё не AAC."""
    db = SessionLocal()
    try:
        q = (
            db.query(Track)
            .filter(Track.file_path.like("minio://%"))
            .order_by(Track.id)
        )
        if limit:
            q = q.limit(limit)
        tracks = q.all()
        # Фильтруем уже AAC (сделаем это после проверки ffmpeg)
        return tracks
    finally:
        db.close()


def _audio_ext_from_path(file_path: str) -> str:
    """Извлечь расширение аудио из minio://bucket/key."""
    bucket, key = storage.parse_object_path(file_path)
    _, ext = os.path.splitext(key)
    return ext.lower()


async def _transcode_one(
    track: Track,
    sem: asyncio.Semaphore,
    stats: Counter,
    counter: dict,
    total: int,
    bitrate: str,
) -> None:
    async with sem:
        title = f"{track.artist} — {track.title}"
        ext = _audio_ext_from_path(track.file_path)

        # Уже AAC — пропускаем
        if ext in (".m4a", ".aac"):
            stats["skipped:aac"] += 1
            counter["done"] += 1
            logger.info("[%d/%d] %s — уже AAC, пропуск", counter["done"], total, title)
            return

        bucket, key = storage.parse_object_path(track.file_path)
        client = storage._get_internal_client()

        # Скачиваем файл из MinIO во временный файл
        fd, tmp_path = tempfile.mkstemp(suffix=ext)
        os.close(fd)
        try:
            client.fget_object(bucket, key, tmp_path)
        except Exception:
            logger.exception("[%d/%d] %s — ошибка скачивания из MinIO", counter["done"] + 1, total, title)
            stats["error:download"] += 1
            counter["done"] += 1
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            return

        # Транскодим в AAC
        aac_fd, aac_path = tempfile.mkstemp(suffix=AAC_EXT)
        os.close(aac_fd)
        try:
            # Сохраняем размер ДО транскодинга (пока старый объект ещё существует)
            old_size = 0
            if key:
                try:
                    old_size = client.stat_object(bucket, key).size
                except Exception:
                    pass

            result_path = transcode_to_aac(tmp_path, aac_path, bitrate=bitrate)
            if result_path == tmp_path:
                stats["error:transcode"] += 1
                counter["done"] += 1
                logger.warning("[%d/%d] %s — транскодинг не удался", counter["done"], total, title)
                return

            # Заливаем обратно в MinIO (с новым расширением)
            new_key = os.path.splitext(key)[0] + AAC_EXT
            client.fput_object(bucket, new_key, aac_path, content_type=AAC_CONTENT_TYPE)

            # Удаляем старый объект если расширение изменилось
            if new_key != key:
                try:
                    client.remove_object(bucket, key)
                except Exception:
                    pass

            # Обновляем БД
            new_file_path = storage.make_object_path(bucket, new_key)
            new_size = os.path.getsize(aac_path)
            track.file_path = new_file_path
            db = SessionLocal()
            try:
                db.merge(track)
                db.commit()
            finally:
                db.close()

            stats["transcoded"] += 1
            counter["done"] += 1
            saved_pct = (1 - new_size / old_size) * 100 if old_size else 0
            logger.info(
                "[%d/%d] %s — %s → AAC (%s kbps, %.0f%% economy)",
                counter["done"], total, title, ext, bitrate, saved_pct,
            )
        finally:
            for p in (tmp_path, aac_path):
                try:
                    os.unlink(p)
                except OSError:
                    pass


async def _run(
    dry_run: bool,
    concurrency: int,
    limit: Optional[int],
    bitrate: str,
) -> None:
    if not TRANSCODE_ENABLED:
        raise SystemExit("TRANSCODE_ENABLED=0 — транскодинг отключён.")

    if not _ffmpeg_available():
        raise SystemExit("ffmpeg не найден в контейнере. Установите ffmpeg.")

    if not storage.is_minio_backend():
        raise SystemExit(
            "STORAGE_BACKEND != minio — файлы не в объектном хранилище. "
            "Запустите с STORAGE_BACKEND=minio."
        )

    tracks = _candidate_tracks(limit)
    # Фильтруем уже AAC
    non_aac = [t for t in tracks if _audio_ext_from_path(t.file_path) not in (".m4a", ".aac")]
    total = len(non_aac)
    logger.info("Кандидатов на транскодинг: %d (битрейт: %s kbps)", total, bitrate)

    if total == 0:
        logger.info("Все файлы уже в AAC или нечего транскодировать.")
        return

    if dry_run:
        for t in non_aac[:20]:
            ext = _audio_ext_from_path(t.file_path)
            logger.info("  %s — %s%s", f"{t.artist} — {t.title}", ext, "")
        if total > 20:
            logger.info("  ... и ещё %d", total - 20)
        logger.info("[dry-run] Будет транскодировано до %d треков.", total)
        return

    storage.ensure_buckets()

    stats: Counter = Counter()
    counter = {"done": 0}
    sem = asyncio.Semaphore(concurrency)

    await asyncio.gather(
        *(
            _transcode_one(t, sem, stats, counter, total, bitrate)
            for t in non_aac
        )
    )

    logger.info("─── Итог ───")
    for status, count in sorted(stats.items(), key=lambda kv: kv[0]):
        logger.info("  %-28s %d", status, count)
    logger.info(
        "Готово. Транскодировано: %d из %d.",
        stats.get("transcoded", 0),
        total,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Массовый транскодинг аудио в AAC")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Показать число кандидатов без изменений",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=2,
        help="Сколько треков транскодировать параллельно (по умолчанию 2)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Ограничить число обрабатываемых треков",
    )
    parser.add_argument(
        "--bitrate",
        type=str,
        default="128",
        help="Битрейт AAC в kbps (по умолчанию 128)",
    )
    args = parser.parse_args()
    asyncio.run(
        _run(
            dry_run=args.dry_run,
            concurrency=max(1, args.concurrency),
            limit=args.limit,
            bitrate=args.bitrate,
        )
    )


if __name__ == "__main__":
    main()
