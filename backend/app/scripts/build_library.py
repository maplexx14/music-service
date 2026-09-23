"""Наполнение библиотеки в MinIO из бесплатных источников («бюджетная» сборка).

Идея: та же архивация, что уже работает лениво при прослушивании
(app.external_archive), только запускается ЗАРАНЕЕ и для целых коллекций.
Метаданные берём из Spotify (страница встроенного плеера — без ключей и
подписки), аудио подбирается матчингом в YouTube Music / SoundCloud ровно тем
же путём, что и в обычном импорте (importer._entry_to_import), после чего трек
один раз скачивается в MinIO. Дальше он отдаётся из объектного хранилища за
доли секунды, а не резолвится на каждое воспроизведение.

Это дешёвая замена «скачать дискографию в FLAC с Tidal/Qobuz»: максимального
качества не будет и подписка не нужна, зато холодный путь (главный источник
задержки «тап → звук», замерен 1.2–11.8 с) для этих треков исчезает совсем.

Запуск (внутри контейнера backend):
    docker compose exec backend python -m app.scripts.build_library \\
        https://open.spotify.com/album/XXXX
    docker compose exec backend python -m app.scripts.build_library \\
        --from-file urls.txt --concurrency 3
    docker compose exec backend python -m app.scripts.build_library \\
        https://open.spotify.com/playlist/XXXX --dry-run

Требуется STORAGE_BACKEND=minio (иначе заливать некуда).

Ограничения:
    * Дискографию артиста одним куском собрать нельзя. Spotify отдаёт
      «топ-треки» только через Web API (нужны SPOTIFY_CLIENT_ID/SECRET) и
      всего 10 штук; без ключей доступны album/playlist/track через embed.
      Дискографию собирайте списком ссылок на альбомы (--from-file).
    * Архивируются только источники с детерминированным резолвером
      (ARCHIVABLE_SOURCES: ytmusic, soundcloud). Матч обычно даёт ytmusic,
      изредка soundcloud — оба архивируются. Soulseek не архивируется: файл
      живёт, лишь пока раздающий пир онлайн.
    * Плейлисты не создаются: скрипт наполняет библиотеку (строки Track +
      объекты в MinIO). Разложить по плейлистам можно в приложении.

Идемпотентно и возобновляемо: get_or_create_external_track апсертит по
(source, external_id), archive_track пропускает уже заархивированное
(file_path вида minio://), поэтому прогон можно прерывать и запускать заново.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
from collections import Counter
from typing import List, Optional, Tuple

import httpx

from app import storage
from app.database import SessionLocal
from app.external_archive import (
    ARCHIVABLE_SOURCES,
    ArchiveResult,
    _DL_TIMEOUT,
    archive_track,
)
from app.models import Track
from app.routers import importer
from app.routers.tracks import get_or_create_external_track

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("build_library")

# Базовый адрес для stream_url, который матчинг кладёт в трек. Значения
# относительные (см. soundcloud._normalize: base_url + "/api/..."), поэтому
# конкретный хост роли не играет — важно лишь, чтобы путь склеился.
_SHIM_BASE_URL = "http://localhost/api"


class _RequestShim:
    """Заглушка starlette.Request для матчинга.

    importer._entry_to_import и его калеи читают у request ровно одно поле —
    base_url (из него собирается stream_url отдачи: ytdlp.search_ytmusic,
    soundcloud._normalize). Полноценный Request тут не нужен: скрипт идёт не
    через HTTP-стек, а прямо по внутренним функциям.
    """

    def __init__(self, base_url: str = _SHIM_BASE_URL) -> None:
        self.base_url = base_url


async def _collect(
    url: str, request: _RequestShim, sem: asyncio.Semaphore
) -> Tuple[Optional[str], List[int], int, int]:
    """Ссылка на коллекцию → (название, id материализованных треков, matched, skipped).

    Повторяет путь importer.import_collection, но без пользователя и плейлиста:
    метаданные → матчинг в ytmusic/soundcloud → строки Track в БД.
    """
    normalized = await importer._normalize_url(url)
    source, kind = importer._detect(normalized)

    title, _cover, entries = await importer._extract_collection(
        request, normalized, source, kind
    )
    if not entries:
        logger.warning("%s: треков не найдено", url)
        return title, [], 0, 0

    logger.info("%s → %s: %d трек(ов), матчинг...", url, title or "?", len(entries))

    # Матчинг упирается в сеть (поиск в YouTube Music) — ограничиваем
    # одновременность, иначе большой альбом заваливает источник запросами.
    async def resolve(entry: dict):
        async with sem:
            return await importer._entry_to_import(request, source, entry)

    resolved = await asyncio.gather(*(resolve(e) for e in entries))

    db = SessionLocal()
    try:
        ids: List[int] = []
        seen: set = set()
        matched = skipped = 0
        for payload, was_matched in resolved:
            if payload is None:
                skipped += 1
                continue
            if was_matched:
                matched += 1
            track = get_or_create_external_track(db, payload)
            if track.id in seen:
                continue  # несколько треков коллекции свелись к одному матчу
            seen.add(track.id)
            ids.append(track.id)
    finally:
        db.close()

    logger.info(
        "%s: материализовано %d (матчингом %d), пропущено %d",
        title or url, len(ids), matched, skipped,
    )
    return title, ids, matched, skipped


async def _archive(
    track_ids: List[int], sem: asyncio.Semaphore, client: httpx.AsyncClient, stats: Counter
) -> None:
    """Архивирует треки в MinIO. Каждому воркеру — своя сессия БД."""
    async def worker(track_id: int) -> None:
        async with sem:
            db = SessionLocal()
            try:
                track = db.get(Track, track_id)
                if track is None:
                    stats["missing"] += 1
                    return
                if track.source not in ARCHIVABLE_SOURCES:
                    stats[ArchiveResult.UNSUPPORTED] += 1
                    return
                # force_resolve: массовый прогон не имеет retry-цикла, а треки
                # здесь никто не слушает — ссылка в кэше резолва могла
                # пролежать часы. Тот же приём, что в
                # scripts/archive_external_to_minio.py.
                status, tmp_path = await archive_track(
                    db, track, client=client, force_resolve=True
                )
                if tmp_path and os.path.exists(tmp_path):
                    try:
                        os.remove(tmp_path)
                    except OSError:
                        pass
                label = f"{track.artist} — {track.title}"
            finally:
                db.close()
            stats[status] += 1
            logger.info("  %s → %s", label, status)

    await asyncio.gather(*(worker(tid) for tid in track_ids))


def _read_urls(path: str) -> List[str]:
    """Файл со ссылками: по одной в строке, # — комментарий."""
    with open(path, encoding="utf-8") as fh:
        return [
            line.strip()
            for line in fh
            if line.strip() and not line.lstrip().startswith("#")
        ]


async def _run(
    urls: List[str],
    dry_run: bool,
    concurrency: int,
    match_concurrency: int,
    limit: Optional[int],
) -> None:
    if not storage.is_minio_backend():
        raise SystemExit(
            "STORAGE_BACKEND != minio — заливать некуда. "
            "Запустите с STORAGE_BACKEND=minio и настроенными MINIO_*."
        )

    if not urls:
        raise SystemExit("Не передано ни одной ссылки (см. --from-file).")

    request = _RequestShim()
    match_sem = asyncio.Semaphore(match_concurrency)
    archive_sem = asyncio.Semaphore(concurrency)
    stats: Counter = Counter()
    total_ids: List[int] = []
    total_matched = total_skipped = 0

    if dry_run:
        logger.info("[dry-run] Разбираю ссылки без записи в БД и без скачивания.")

    storage.ensure_buckets()

    async with httpx.AsyncClient(timeout=_DL_TIMEOUT, follow_redirects=True) as client:
        for url in urls:
            try:
                if dry_run:
                    # В dry-run достаточно понять, что разбор и матчинг живы:
                    # материализацию не делаем, поэтому id не собираем.
                    normalized = await importer._normalize_url(url)
                    source, kind = importer._detect(normalized)
                    title, _cover, entries = await importer._extract_collection(
                        request, normalized, source, kind
                    )
                    if limit:
                        entries = entries[:limit]
                    logger.info(
                        "[dry-run] %s (%s/%s): %d трек(ов)",
                        title or url, source, kind, len(entries),
                    )
                    continue

                _title, ids, matched, skipped = await _collect(url, request, match_sem)
                if limit:
                    ids = ids[:limit]
                total_ids.extend(ids)
                total_matched += matched
                total_skipped += skipped
            except Exception:  # noqa: BLE001 — одна битая ссылка не рушит прогон
                logger.exception("%s: разбор не удался", url)

        if dry_run:
            logger.info("[dry-run] Изменения не применялись.")
            return

        if not total_ids:
            logger.info("Нечего архивировать: ни один трек не материализовался.")
            return

        logger.info(
            "─── Архивация ─── %d трек(ов), источники: %s",
            len(total_ids), ", ".join(sorted(ARCHIVABLE_SOURCES)),
        )
        await _archive(total_ids, archive_sem, client, stats)

    logger.info("─── Итог ───")
    logger.info("  материализовано треков: %d (матчингом %d)", len(total_ids), total_matched)
    logger.info("  пропущено при матчинге: %d", total_skipped)
    for status, count in sorted(stats.items()):
        logger.info("  %-28s %d", status, count)
    logger.info(
        "Готово. Заархивировано: %d из %d.",
        stats.get(ArchiveResult.ARCHIVED, 0),
        len(total_ids),
    )
    if stats.get(ArchiveResult.BLOCKED):
        # Bot-check YouTube лечится тишиной: повторный прогон сразу же только
        # продлит блокировку. Тот же смысл, что у _BOT_CHECK_TTL в ytdlp.
        logger.warning(
            "  %d трек(ов) упёрлись в bot-check YouTube — повторите прогон позже, "
            "не сразу.", stats[ArchiveResult.BLOCKED],
        )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Наполнение библиотеки (Spotify-метаданные → матчинг → MinIO)"
    )
    parser.add_argument(
        "urls",
        nargs="*",
        help="Ссылки Spotify (album/playlist/track), SoundCloud или Yandex Music",
    )
    parser.add_argument(
        "--from-file",
        help="Файл со ссылками (по одной в строке, # — комментарий)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Только разобрать ссылки, без записи в БД и скачивания",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=3,
        help="Сколько треков качать в MinIO параллельно (по умолчанию 3; не завышайте, иначе 429 от YouTube)",
    )
    parser.add_argument(
        "--match-concurrency",
        type=int,
        default=4,
        help="Сколько треков матчить в YouTube Music параллельно (по умолчанию 4)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Ограничить число треков на коллекцию (для пробного прогона)",
    )
    args = parser.parse_args()

    urls = list(args.urls)
    if args.from_file:
        urls.extend(_read_urls(args.from_file))

    asyncio.run(
        _run(
            urls=urls,
            dry_run=args.dry_run,
            concurrency=max(1, args.concurrency),
            match_concurrency=max(1, args.match_concurrency),
            limit=args.limit,
        )
    )


if __name__ == "__main__":
    main()