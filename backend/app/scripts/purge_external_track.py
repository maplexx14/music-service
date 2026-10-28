"""Удаляет кэш одного внешнего трека: локальные копии, архив в S3 и Redis.

Зачем: до фикса 2026-10-28 HLS-only треки SoundCloud могли собираться дважды
одновременно — прогрев и /stream обслуживают разные воркеры gunicorn, а
временный файл у них был общий. В кэш (а затем и в S3 через
external_archive.adopt_local_file) попадал битый файл, и трек больше не играл
никогда: локальный диск-кэш проверяется раньше резолва, архив в S3 — сразу
после него. Сам фикс исключает повторение, но уже испорченные копии надо
убрать руками — по одной на трек.

Запуск (в контейнере backend):
    docker compose -f docker-compose.prod.yml exec backend \
        python -m app.scripts.purge_external_track soundcloud 2408268198
    docker compose -f docker-compose.prod.yml exec backend \
        python -m app.scripts.purge_external_track ytmusic UFJETV1OVuY --dry-run

Что чистится:
  * ``/app/ytdlp_cache/<cache_id>.*`` — собранный HLS и warm/part-файлы;
  * S3-объект ``external/<source>/<id>.<ext>`` (через storage.remove_object_path,
    чтобы заодно сбросить локальный disk-кэш S3 и stat-кэш);
  * Redis: ``archive:path:<source>/<id>``, ``archive:acoustic:<source>/<id>``
    и резолв-кэш провайдера.

Запись в БД (``Track.file_path`` на удалённый объект) отвяжется сама при
следующем /tracks/{id}/stream: стрим ловит ObjectMissing и зовёт
_unlink_missing_object (см. routers/tracks.py).
"""

from __future__ import annotations

import argparse
import glob
import logging
import os

from app import storage
from app.cache import delete_cache

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("purge_external_track")

# Тот же каталог, что у routers.ytdlp, но без импорта роутера: он на импорте
# поднимает YTMusic-клиент и падает, если auth-файл недоступен (а скрипту он
# не нужен — чистим SoundCloud/архив).
CACHE_DIR = os.getenv(
    "YTDLP_CACHE_DIR",
    os.path.join(os.path.dirname(__file__), "..", "..", "ytdlp_cache"),
)

# Сколько объектов с одним id может лежать в хранилище: оригинал + старые
# копии с другим контейнером. Потолок нужен только чтобы цикл удаления не
# крутился вечно, если хранилище врёт и объект «не исчезает».
_MAX_ARCHIVE_OBJECTS = 16


def _cache_id(source: str, external_id: str) -> str:
    """Имя файла в дисковом кэше — как в stream_cached_audio."""
    return f"sc{external_id}" if source == "soundcloud" else external_id


def _resolve_cache_keys(source: str, external_id: str) -> list[str]:
    if source == "soundcloud":
        return [f"soundcloud:resolve:{external_id}"]
    if source == "ytmusic":
        return [f"ytdlp:resolve:v2:{external_id}"]
    return []


def purge(
    source: str,
    external_id: str,
    cache_id: str | None = None,
    dry_run: bool = False,
) -> int:
    """Возвращает число удалённых артефактов (0 — чистить было нечего)."""
    cache_id = cache_id or _cache_id(source, external_id)
    removed = 0

    # 1. Дисковый кэш стрима. Берём ВСЕ файлы с этим id: .m4a, .mp3, .warm,
    # брошенные .part от упавших воркеров.
    pattern = os.path.join(CACHE_DIR, f"{glob.escape(cache_id)}.*")
    for path in sorted(glob.glob(pattern)):
        logger.info("%s локальный кэш %s", "удалил бы" if dry_run else "удаляю", path)
        removed += 1
        if not dry_run:
            try:
                os.remove(path)
            except OSError:
                logger.exception("не удалось удалить %s", path)

    # 2. Архив в S3. Ищем по префиксу (расширение заранее неизвестно), удаляем
    # по одному: find_music_object отдаёт только «оригинал», а не .low-вариант.
    archive_prefix = f"external/{source}/{external_id}"
    if not storage.is_minio_backend():
        logger.info(
            "STORAGE_BACKEND=%s: архивы в объектном хранилище не используются",
            os.getenv("STORAGE_BACKEND", "local"),
        )
    else:
        seen: set[str] = set()
        for _ in range(_MAX_ARCHIVE_OBJECTS):
            path = storage.find_music_object(archive_prefix)
            # В dry-run ничего не удаляется, поэтому второй запрос вернёт тот же
            # объект — на этом и останавливаемся.
            if not path or path in seen:
                break
            seen.add(path)
            logger.info("%s архив %s", "удалил бы" if dry_run else "удаляю", path)
            removed += 1
            if not dry_run:
                storage.remove_object_path(path)

    # 3. Redis: путь архива и резолв провайдера. Без этого стрим ещё до
    # ARCHIVE_PATH_TTL ходил бы за удалённым объектом, а резолв — за
    # закэшированным transient-маркером.
    keys = [
        f"archive:path:{source}/{external_id}",
        f"archive:acoustic:{source}/{external_id}",
        *_resolve_cache_keys(source, external_id),
    ]
    for key in keys:
        logger.info("%s ключ Redis %s", "удалил бы" if dry_run else "удаляю", key)
        if not dry_run:
            delete_cache(key)

    return removed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", help="источник: soundcloud, ytmusic, …")
    parser.add_argument("external_id", help="id трека у источника")
    parser.add_argument(
        "--cache-id",
        default=None,
        help="файл в дисковом кэше (по умолчанию sc<id> для soundcloud, иначе <id>)",
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="только показать, что будет удалено"
    )
    args = parser.parse_args()

    removed = purge(
        args.source, args.external_id, cache_id=args.cache_id, dry_run=args.dry_run
    )
    if args.dry_run:
        logger.info("dry-run: удалено было бы %d файлов/объектов", removed)
    elif not removed:
        logger.info(
            "файлов и архивов для %s/%s не найдено (ключи Redis сброшены)",
            args.source,
            args.external_id,
        )
    else:
        logger.info("готово: удалено %d файлов/объектов", removed)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
