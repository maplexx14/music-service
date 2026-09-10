"""Фоновое наполнение библиотеки: треки известных артистов через Soulseek.

«Известные» — артисты, уже представленные в библиотеке (DISTINCT artist из
Track): собираем не весь мир, а то, что пользователь реально слушает. Для
очередного артиста берём его каталог из YouTube Music (метаданные; тот же
путь, что страница артиста), каждую песню матчим в Soulseek
(find_soulseek_equivalent — общий с воспроизведением кэш, окно по
длительности и ремикс-фильтр) и ставим закачку. Завершённые закачки
уносятся в MinIO (adopt_local_file под ytmusic/{video_id}, как при обычном
воспроизведении) и материализуются в БД (get_or_create_external_track —
идемпотентный апсерт, поэтому цикл безопасно прерывать и перезапускать).

Темп: один артист за проход, интервал SLSK_HARVEST_INTERVAL_SEC, повтор к
тому же артисту не раньше чем через SLSK_HARVEST_REVISIT_DAYS (выйдут новые
релизы, появятся пиры). Лидер-выборы в Redis — как в соседних циклах
main.py: при нескольких репликах бэкенда качает одна.
"""

import asyncio
import logging
import os
import time
import uuid
from typing import Optional

from app.cache import redis_client
from app.database import SessionLocal
from app.schemas import ExternalTrackImport

logger = logging.getLogger("slsk_harvest")

_MARK_PREFIX = "harvest:slsk:artist:"
# Закачка живёт в slskd, а не в стриме: успеть может и за минуты, и не успеть
# за полчаса — но дольше ждать незачем, следующий проход доберёт.
_WATCH_POLL = 10.0
_WATCH_TIMEOUT = 45 * 60


def _pick_artist(revisit_seconds: int) -> Optional[str]:
    """Следующий артист для прохода: самый представленный в библиотеке из тех,
    кого давно не собирали. None — собирать пока некого."""
    from sqlalchemy import func

    from app.models import Track

    db = SessionLocal()
    try:
        rows = (
            db.query(Track.artist, func.count(Track.id))
            .filter(Track.artist.isnot(None))
            .group_by(Track.artist)
            .order_by(func.count(Track.id).desc())
            .limit(200)
            .all()
        )
    finally:
        db.close()
    names = [
        name
        for name, _count in rows
        if name and name.strip() and name.lower() != "unknown artist"
    ]
    if not names:
        return None
    # Метки прошлых сборов — одним mget, а не GET на кандидата.
    marks = redis_client.mget([_MARK_PREFIX + n for n in names]) or []
    now = time.time()
    for name, mark in zip(names, marks):
        try:
            if mark is None or now - float(mark) >= revisit_seconds:
                return name
        except (TypeError, ValueError):
            return name  # битая метка — считаем просроченной
    return None


def _materialize(track) -> None:
    """Материализует ytmusic-трек в БД (идемпотентный апсерт по video_id)."""
    from app.routers.tracks import get_or_create_external_track

    db = SessionLocal()
    try:
        get_or_create_external_track(
            db,
            ExternalTrackImport(
                source="ytmusic",
                external_id=track["external_id"],
                title=track["title"],
                artist=track["artist"],
                album=track["album"],
                duration=track["duration"],
                cover_url=track["cover_url"],
                is_explicit=track["is_explicit"],
            ),
        )
    except Exception:  # noqa: BLE001 — один трек не должен ронять проход
        logger.exception("harvest: не удалось материализовать %s", track.get("external_id"))
    finally:
        db.close()


def _track_meta(track, fallback_artist: str) -> dict:
    """Метаданные трека каталога для материализации (model_dump без хвостов)."""
    return {
        "external_id": track.external_id,
        "title": track.title or "",
        "artist": track.artist or fallback_artist,
        "album": track.album,
        "duration": track.duration or 0,
        "cover_url": track.cover_url,
        "is_explicit": bool(track.is_explicit),
    }


async def _watch_and_adopt(video_id: str, token: str, meta: dict) -> None:
    """Ждёт завершения закачки и уносит трек в MinIO + БД.

    Как и soulseek._adopt_when_done, переживает уход стрима/клиента: закачка
    живёт в slskd. Отличие — материализация: харвест создаёт записи в БД, а
    не только архивирует байты.
    """
    from app import external_archive
    from app.routers import soulseek

    try:
        username, filename, size = soulseek._token_decode(token)
    except Exception:  # noqa: BLE001 — битый токен, матч перещёлкнется TTL-ом
        return
    # Матчер мог не ставить закачку (SLSK_MATCH_PREFETCH=0) — ставим сами;
    # повторный enqueue для уже стоящего в очереди slskd просто вернёт ошибку.
    await soulseek._enqueue_download(
        soulseek._slskd_client, username, filename, size
    )

    loop = asyncio.get_running_loop()
    deadline = loop.time() + _WATCH_TIMEOUT
    while True:
        finished = await soulseek._transfer_finished(
            soulseek._slskd_client, username, filename
        )
        if finished is False:
            logger.info("harvest: закачка %s не удалась (ytmusic %s)", filename, video_id)
            return
        if finished is True:
            break
        if loop.time() >= deadline:
            logger.info("harvest: закачка %s не завершилась вовремя", filename)
            return
        await asyncio.sleep(_WATCH_POLL)

    path = soulseek._find_local_path(filename)
    if not path or not os.path.exists(path):
        return
    # Сначала запись в БД, потом архив: adopt_local_file привязывает file_path
    # по (source, external_id), поэтому строка к этому моменту должна быть.
    await asyncio.to_thread(_materialize, meta)
    if await external_archive.adopt_local_file("ytmusic", video_id, path):
        logger.info("harvest: %s — %s в MinIO", meta["artist"], meta["title"])


async def _harvest_pass(artist: str, tracks_per_artist: int) -> bool:
    """Один проход: каталог артиста → матчи → закачки с наблюдателями.

    False — проход не состоялся (slskd недоступен): артиста нельзя помечать
    «собранным», к нему нужно вернуться после оживания.
    """
    from app.routers import soulseek, ytdlp

    # slskd недоступен (предохранитель, см. soulseek._slskd_unreachable) —
    # проход бессмыслен: все find_soulseek_equivalent вернут None.
    if not soulseek._slskd_available():
        logger.info("harvest: slskd недоступен, пропуск %s", artist)
        return False

    catalog = await ytdlp._fetch_artist_catalog(artist, limit=tracks_per_artist)
    if not catalog:
        logger.info("harvest: каталог %s пуст", artist)
        return True

    matched = 0
    for track in catalog:
        video_id = track.external_id
        if not video_id:
            continue
        # Уже заархивировано (играли/собирали раньше) — байты на месте, нужно
        # только убедиться, что запись в БД существует.
        if await ytdlp.archived_music_path(f"ytmusic/{video_id}"):
            await asyncio.to_thread(_materialize, _track_meta(track, artist))
            continue
        token = await soulseek.find_soulseek_equivalent(
            video_id, track.title, track.artist, track.duration
        )
        if not token:
            continue
        matched += 1
        asyncio.create_task(
            _watch_and_adopt(video_id, token, _track_meta(track, artist))
        )
    logger.info(
        "harvest: %s — %d трек(ов) в каталоге, %d заматчено в soulseek",
        artist, len(catalog), matched,
    )
    return True


async def start() -> None:
    """Запуск цикла (вызывается из startup main.py). Читает env на старте,
    чтобы выключение не требовало правок кода (см. conftest тестов)."""
    if os.getenv("SLSK_HARVEST", "1") not in ("1", "true", "yes", "on"):
        logger.info("slsk harvest disabled (SLSK_HARVEST)")
        return
    from app.routers import soulseek

    if not soulseek.SOULSEEK_USERNAME:
        logger.info("slsk harvest disabled (Soulseek не настроен)")
        return
    interval = int(os.getenv("SLSK_HARVEST_INTERVAL_SEC", "1800"))
    if interval <= 0:
        logger.info("slsk harvest disabled (SLSK_HARVEST_INTERVAL_SEC <= 0)")
        return
    tracks_per_artist = int(os.getenv("SLSK_HARVEST_TRACKS_PER_ARTIST", "30"))
    revisit = max(1, int(os.getenv("SLSK_HARVEST_REVISIT_DAYS", "14"))) * 86400

    # Лидер-выборы с продлением — см. _artist_probe_loop в main.py: ключ
    # держит токен владельца, владелец продлевает TTL на каждой итерации.
    lock_key = "background:slsk_harvest:leader"
    token = f"{os.getpid()}:{uuid.uuid4().hex}"
    # Запас на длительность самого прохода: каталог + матчи могут тянуться
    # минутами (slskd-поиски по 15с), терять лидерство посреди незачем.
    lock_ttl = interval + max(300, interval)

    def _acquire() -> bool:
        if redis_client.set(lock_key, token, nx=True, ex=lock_ttl):
            return True
        if redis_client.get(lock_key) == token:
            redis_client.expire(lock_key, lock_ttl)
            return True
        return False

    async def _loop() -> None:
        while True:
            try:
                if await asyncio.to_thread(_acquire):
                    artist = await asyncio.to_thread(_pick_artist, revisit)
                    if artist:
                        if await _harvest_pass(artist, tracks_per_artist):
                            redis_client.set(
                                _MARK_PREFIX + artist, time.time(), ex=revisit
                            )
            except Exception:  # noqa: BLE001 — фон не должен умирать навсегда
                logger.exception("slsk harvest pass failed")
            await asyncio.sleep(interval)

    asyncio.create_task(_loop())
    logger.info(
        "slsk harvest loop started (interval=%ss, tracks/artist=%d, revisit=%dd)",
        interval, tracks_per_artist, revisit // 86400,
    )
