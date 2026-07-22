"""Массовая архивация внешних треков (ytmusic) в MinIO.

Скачивает аудио каждого внешнего трека и кладёт в объектное хранилище, после
чего трек играется presigned-ссылкой напрямую из MinIO (без живого резолва
через yt-dlp на каждое воспроизведение). source в БД сохраняется.

Запуск (внутри контейнера backend):
    docker compose exec backend python -m app.scripts.archive_external_to_minio
    docker compose exec backend python -m app.scripts.archive_external_to_minio --dry-run
    docker compose exec backend python -m app.scripts.archive_external_to_minio --concurrency 4 --limit 200

Требуется STORAGE_BACKEND=minio (иначе заливать некуда).

Идемпотентно и возобновляемо: уже заархивированные треки (file_path вида
minio://) пропускаются, поэтому скрипт можно прерывать и запускать повторно.
Soulseek и прочие источники без детерминированного резолва пропускаются.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
from collections import Counter

import httpx

from app.database import SessionLocal
from app.external_archive import (
    ARCHIVABLE_SOURCES,
    ArchiveResult,
    _DL_TIMEOUT,
    archive_track,
)
from app.models import Track
from app import storage

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("archive_external_to_minio")


def _candidate_ids(limit: int | None, playlists_only: bool = False) -> list[int]:
    """id внешних треков, которые ещё не в MinIO и относятся к архивируемым источникам."""
    db = SessionLocal()
    try:
        q = (
            db.query(Track.id)
            .filter(Track.source.in_(tuple(ARCHIVABLE_SOURCES)))
            # file_path пуст (не архивирован) ИЛИ не minio:// (лежит иначе).
            .filter(
                (Track.file_path.is_(None))
                | (~Track.file_path.like("minio://%"))
            )
            .order_by(Track.id)
        )
        if playlists_only:
            # Только треки, лежащие хоть в одном плейлисте (включая
            # «Понравившиеся») — то, что пользователи реально слушают.
            # Полный прогон по всем внешним трекам БД в разы дольше и в
            # основном греет треки, к которым никто не вернётся.
            from app.models import playlist_tracks

            q = q.join(playlist_tracks, playlist_tracks.c.track_id == Track.id).distinct()
        if limit:
            q = q.limit(limit)
        return [row[0] for row in q.all()]
    finally:
        db.close()


async def _worker(
    track_id: int,
    sem: asyncio.Semaphore,
    client: httpx.AsyncClient,
    stats: Counter,
    counter: dict,
    total: int,
) -> None:
    async with sem:
        # Своя сессия на воркер: SQLAlchemy Session не рассчитан на
        # одновременное использование несколькими корутинами.
        db = SessionLocal()
        try:
            track = db.get(Track, track_id)
            if track is None:
                stats["missing"] += 1
                return
            title = f"{track.artist} — {track.title}"
            status = await archive_track(db, track, client=client)
        finally:
            db.close()

        stats[status] += 1
        counter["done"] += 1
        logger.info("[%d/%d] %s → %s", counter["done"], total, title, status)


async def _run(
    dry_run: bool, concurrency: int, limit: int | None, playlists_only: bool = False
) -> None:
    if not storage.is_minio_backend():
        raise SystemExit(
            "STORAGE_BACKEND != minio — заливать некуда. "
            "Запустите с STORAGE_BACKEND=minio и настроенными MINIO_*."
        )

    ids = _candidate_ids(limit, playlists_only=playlists_only)
    total = len(ids)
    logger.info("Кандидатов на архивацию: %d (источники: %s)", total, ", ".join(sorted(ARCHIVABLE_SOURCES)))

    if total == 0:
        logger.info("Нечего архивировать.")
        return

    if dry_run:
        logger.info("[dry-run] Будет заархивировано до %d треков. Изменения не применяются.", total)
        return

    storage.ensure_buckets()

    stats: Counter = Counter()
    counter = {"done": 0}
    sem = asyncio.Semaphore(concurrency)
    async with httpx.AsyncClient(timeout=_DL_TIMEOUT, follow_redirects=True) as client:
        await asyncio.gather(
            *(_worker(tid, sem, client, stats, counter, total) for tid in ids)
        )

    logger.info("─── Итог ───")
    for status, count in sorted(stats.items(), key=lambda kv: kv[0]):
        logger.info("  %-28s %d", status, count)
    logger.info(
        "Готово. Заархивировано: %d из %d.",
        stats.get(ArchiveResult.ARCHIVED, 0),
        total,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Архивация внешних треков в MinIO")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Показать число кандидатов без скачивания/изменений в БД",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=3,
        help="Сколько треков качать параллельно (по умолчанию 3; не завышайте, чтобы не ловить 429 от YouTube)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Ограничить число обрабатываемых треков (для пробного прогона)",
    )
    parser.add_argument(
        "--playlists-only",
        action="store_true",
        help="Только треки из плейлистов (включая «Понравившиеся»)",
    )
    args = parser.parse_args()
    asyncio.run(
        _run(
            dry_run=args.dry_run,
            concurrency=max(1, args.concurrency),
            limit=args.limit,
            playlists_only=args.playlists_only,
        )
    )


if __name__ == "__main__":
    main()
