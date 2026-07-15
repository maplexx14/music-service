"""Перенос уже существующих локальных файлов (music_files / cover_files) в MinIO.

Идемпотентно: треки, уже указывающие на объектное хранилище (file_path вида
minio://…, cover_url — на публичный MinIO), пропускаются. Файл на диске
удаляется только после успешной заливки. Значения путей в БД обновляются
внутри одной транзакции на трек, поэтому прерывание не оставит запись в
несогласованном состоянии.

Запуск (внутри контейнера backend):
    docker compose exec backend python -m app.scripts.migrate_to_minio
    docker compose exec backend python -m app.scripts.migrate_to_minio --dry-run
    docker compose exec backend python -m app.scripts.migrate_to_minio --keep-local

Требуется STORAGE_BACKEND=minio (или хотя бы корректно заданные MINIO_*),
иначе скрипт откажется работать: заливать некуда.
"""

from __future__ import annotations

import argparse
import logging
import mimetypes
import os
from pathlib import Path

from app.database import SessionLocal
from app.models import Track
from app import storage

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("migrate_to_minio")

MUSIC_DIR = Path(
    os.getenv("MUSIC_FILES_DIR", os.path.join(os.path.dirname(__file__), "..", "..", "music_files"))
)
COVER_DIR = Path(
    os.getenv("COVER_FILES_DIR", os.path.join(os.path.dirname(__file__), "..", "..", "cover_files"))
)


def _local_music_file(file_path: str) -> Path | None:
    """Возвращает путь к аудио на диске для локального трека, либо None."""
    if not file_path or storage.is_minio_path(file_path):
        return None
    # source != local у внешних треков — у них file_path пуст, сюда не попадут.
    name = Path(file_path).name
    if not name:
        return None
    candidate = MUSIC_DIR / name
    return candidate if candidate.exists() else None


def _local_cover_file(cover_url: str | None) -> Path | None:
    """Возвращает путь к обложке на диске, либо None (пропускаем внешние/MinIO)."""
    if not cover_url:
        return None
    # Уже в объектном хранилище или внешний абсолютный URL — не трогаем.
    if "://" in cover_url or not cover_url.startswith("/cover_files/"):
        return None
    name = Path(cover_url).name
    if not name:
        return None
    candidate = COVER_DIR / name
    return candidate if candidate.exists() else None


def migrate(dry_run: bool = False, keep_local: bool = False) -> None:
    if not storage.is_minio_backend():
        raise SystemExit(
            "STORAGE_BACKEND != minio — заливать некуда. "
            "Запустите с STORAGE_BACKEND=minio и настроенными MINIO_*."
        )

    if not dry_run:
        storage.ensure_buckets()

    db = SessionLocal()
    migrated_audio = migrated_cover = skipped = 0
    try:
        # Только локальные треки: у внешних (ytmusic/soulseek) file_path пуст.
        tracks = db.query(Track).filter(Track.file_path.isnot(None)).all()
        logger.info("Кандидатов с file_path: %d", len(tracks))

        for track in tracks:
            changed = False

            music_file = _local_music_file(track.file_path)
            if music_file is not None:
                key = music_file.name
                if dry_run:
                    logger.info("[dry-run] audio #%s → minio://music/%s", track.id, key)
                else:
                    mime, _ = mimetypes.guess_type(str(music_file))
                    track.file_path = storage.upload_music_file(
                        str(music_file), key, mime or "audio/mpeg"
                    )
                    changed = True
                migrated_audio += 1

            cover_file = _local_cover_file(track.cover_url)
            if cover_file is not None:
                key = cover_file.name
                if dry_run:
                    logger.info("[dry-run] cover #%s → covers/%s", track.id, key)
                else:
                    mime, _ = mimetypes.guess_type(str(cover_file))
                    track.cover_url = storage.upload_cover_file(
                        str(cover_file), key, mime or "image/jpeg"
                    )
                    changed = True
                migrated_cover += 1

            if music_file is None and cover_file is None:
                skipped += 1
                continue

            if dry_run or not changed:
                continue

            # Коммитим ДО удаления файлов: если commit упадёт, файлы на месте.
            db.commit()

            if not keep_local:
                if music_file is not None:
                    music_file.unlink(missing_ok=True)
                if cover_file is not None:
                    cover_file.unlink(missing_ok=True)

        logger.info(
            "Готово. Аудио: %d, обложек: %d, пропущено: %d%s",
            migrated_audio,
            migrated_cover,
            skipped,
            " (dry-run, изменения не применялись)" if dry_run else "",
        )
    except Exception:
        db.rollback()
        logger.exception("Миграция прервана — незакоммиченные изменения откачены")
        raise
    finally:
        db.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Перенос локальных файлов в MinIO")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Только показать, что будет перенесено, без заливки и изменений в БД",
    )
    parser.add_argument(
        "--keep-local",
        action="store_true",
        help="Не удалять локальные файлы после успешной заливки",
    )
    args = parser.parse_args()
    migrate(dry_run=args.dry_run, keep_local=args.keep_local)


if __name__ == "__main__":
    main()
