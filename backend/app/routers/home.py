"""Полки главной, которые дают повод зайти снова.

Зачем: новички пробуют сервис и уходят за 1–4 дня — главная каждый раз
выглядит одинаково, и нового на ней нет (замер 2026-10-21, см. app/push.py).
Каждая полка — свой повод открыть приложение:

* ``/releases`` — свежие релизы любимых артистов (тот же Deezer и тот же
  список артистов, что у push-уведомлений, только окно шире);
* ``/weekly`` — «Открытия недели»: артисты, похожие на любимых, которых юзер
  ещё не слушал. Подборка замораживается на ISO-неделю — обновление по
  понедельникам само по себе повод вернуться;
* ``/rediscover`` — лайки, которые давно не звучали: почти всегда попадание,
  в отличие от незнакомого.

Пустая полка возвращает [] — фронт её просто не рисует.
"""
import asyncio
import logging
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import List

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import artist_cards, push
from app.artist_utils import artist_key
from app.cache import get_cache_async, set_cache_async
from app.database import get_db
from app.dependencies import get_current_active_user
from app.models import Track, User, playlist_tracks, user_track_plays, user_track_skips
from app.playlist_signals import find_liked_playlist_id
from app.recommendation_scoring import stable_jitter
from app.schemas import TrackResponse

logger = logging.getLogger(__name__)

router = APIRouter()

RELEASE_WINDOW_DAYS = 30
RELEASE_LIMIT = 12
RELEASES_TTL = 3600

WEEKLY_SEED_ARTISTS = 6
WEEKLY_SIMILAR_PER_SEED = 8
WEEKLY_PER_ARTIST = 2
WEEKLY_LIMIT = 25
# Меньше — это не подборка, а случайные треки: полку лучше не показывать.
WEEKLY_MIN = 8
WEEKLY_TTL = 8 * 24 * 3600
WEEKLY_EMPTY_TTL = 3600

REDISCOVER_AFTER_DAYS = 30
REDISCOVER_LIMIT = 20
REDISCOVER_MIN = 6

_NETWORK_TIMEOUT = 5.0


async def _favorites(db: Session, user: User) -> List[str]:
    return await asyncio.to_thread(push.favorite_artists, db, user)


# ─────────────────────────────── релизы ───────────────────────────────


def recent_releases(releases, today: date, window_days: int = RELEASE_WINDOW_DAYS) -> List[dict]:
    """Вышедшие за окно, свежие первыми, без дублей. Будущая дата — анонс."""
    since = (today - timedelta(days=window_days)).isoformat()
    until = today.isoformat()
    unique = {}
    for item in releases:
        if since <= item["date"] <= until:
            unique.setdefault(item["id"], item)
    return sorted(unique.values(), key=lambda item: item["date"], reverse=True)


@router.get("/releases")
async def home_releases(
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db),
):
    cache_key = f"home:releases:v1:{current_user.id}"
    cached = await get_cache_async(cache_key)
    if isinstance(cached, list):
        return cached

    artists = await _favorites(db, current_user)
    tasks = [asyncio.ensure_future(push.artist_releases(name)) for name in artists]
    releases: List[dict] = []
    if tasks:
        done, _ = await asyncio.wait(tasks, timeout=_NETWORK_TIMEOUT)
        for task in done:
            if not task.cancelled() and task.exception() is None:
                releases.extend(task.result())
    result = recent_releases(releases, datetime.now(timezone.utc).date())[:RELEASE_LIMIT]
    # Не всё успело — короткий кэш: досчитанные задачи допишут кэш релизов
    # артистов, и следующий заход их увидит.
    complete = all(task.done() for task in tasks)
    await set_cache_async(cache_key, result, expire=RELEASES_TTL if complete else 120)
    return result


# ─────────────────────────────── открытия недели ───────────────────────────────


def _week_tag(now: datetime) -> str:
    year, week, _ = now.isocalendar()
    return f"{year}-W{week:02d}"


def _heard_artist_keys(db: Session, user_id: int) -> set:
    rows = db.execute(
        select(func.lower(Track.artist))
        .join(user_track_plays, user_track_plays.c.track_id == Track.id)
        .where(user_track_plays.c.user_id == user_id)
        .distinct()
    ).scalars()
    heard = {artist_key(name) for name in rows if name}
    liked_id = find_liked_playlist_id(db, user_id)
    if liked_id:
        rows = db.execute(
            select(func.lower(Track.artist))
            .join(playlist_tracks, playlist_tracks.c.track_id == Track.id)
            .where(playlist_tracks.c.playlist_id == liked_id)
            .distinct()
        ).scalars()
        heard |= {artist_key(name) for name in rows if name}
    return heard


def pick_new_artists(similar_lists: List[List[str]], blocked: set, limit: int) -> List[str]:
    """Ключи артистов по очереди из списков похожих (самые похожие на каждого
    любимого — первыми), без уже слышанных."""
    picked: List[str] = []
    seen = set(blocked)
    depth = max((len(names) for names in similar_lists), default=0)
    for i in range(depth):
        for names in similar_lists:
            if i >= len(names):
                continue
            key = artist_key(names[i])
            if not key or key in seen:
                continue
            seen.add(key)
            picked.append(key)
            if len(picked) >= limit:
                return picked
    return picked


def _weekly_track_ids(db: Session, user: User, artist_keys: List[str], week: str) -> List[int]:
    if not artist_keys:
        return []
    skipped = set(
        db.execute(
            select(user_track_skips.c.track_id).where(user_track_skips.c.user_id == user.id)
        ).scalars()
    )
    rows = db.execute(
        select(Track.id, Track.artist, Track.unique_listener_count, Track.play_count)
        .where(func.lower(Track.artist).in_(artist_keys))
    ).all()
    by_artist = defaultdict(list)
    for row in rows:
        if row.id not in skipped:
            by_artist[artist_key(row.artist)].append(row)
    order = {key: i for i, key in enumerate(artist_keys)}
    picked = []
    for key in sorted(by_artist, key=lambda k: order.get(k, len(order))):
        best = sorted(
            by_artist[key],
            key=lambda r: (-(r.unique_listener_count or 0), -(r.play_count or 0), r.id),
        )
        picked.extend(row.id for row in best[:WEEKLY_PER_ARTIST])
    # Внутри недели порядок перемешан, но стабилен: подборка не «прыгает»
    # между заходами, а соседние треки — от разных артистов.
    picked.sort(key=lambda track_id: stable_jitter(f"weekly:{user.id}:{week}", track_id))
    return picked[:WEEKLY_LIMIT]


def _load_tracks(db: Session, ids: List[int]) -> List[Track]:
    if not ids:
        return []
    found = {track.id: track for track in db.query(Track).filter(Track.id.in_(ids)).all()}
    return [found[i] for i in ids if i in found]


@router.get("/weekly", response_model=List[TrackResponse])
async def home_weekly(
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db),
):
    week = _week_tag(datetime.now(timezone.utc))
    cache_key = f"home:weekly:v1:{current_user.id}:{week}"
    cached = await get_cache_async(cache_key)
    if isinstance(cached, list):
        return await asyncio.to_thread(_load_tracks, db, cached)

    favorites = await _favorites(db, current_user)
    seeds = favorites[:WEEKLY_SEED_ARTISTS]
    tasks = [
        asyncio.ensure_future(artist_cards.similar_cards(name, limit=WEEKLY_SIMILAR_PER_SEED))
        for name in seeds
    ]
    similar_lists: List[List[str]] = []
    complete = True
    if tasks:
        done, pending = await asyncio.wait(tasks, timeout=_NETWORK_TIMEOUT)
        complete = not pending
        for task in tasks:
            if task in done and not task.cancelled() and task.exception() is None:
                similar_lists.append([card["name"] for card in task.result() if card.get("name")])

    def compute():
        heard = _heard_artist_keys(db, current_user.id)
        blocked = heard | {artist_key(a) for a in favorites}
        keys = pick_new_artists(similar_lists, blocked, WEEKLY_LIMIT)
        return _weekly_track_ids(db, current_user, keys, week)

    ids = await asyncio.to_thread(compute)
    if len(ids) < WEEKLY_MIN:
        ids = []
    # Подборку замораживаем на неделю, только если похожие успели прийти все:
    # иначе неделя застряла бы на неполной выдаче.
    ttl = WEEKLY_TTL if ids and complete else WEEKLY_EMPTY_TTL
    await set_cache_async(cache_key, ids, expire=ttl)
    return await asyncio.to_thread(_load_tracks, db, ids)


# ─────────────────────────────── давно не слушали ───────────────────────────────


@router.get("/rediscover", response_model=List[TrackResponse])
def home_rediscover(
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db),
):
    liked_id = find_liked_playlist_id(db, current_user.id)
    if not liked_id:
        return []
    now = datetime.now(timezone.utc)
    since = now - timedelta(days=REDISCOVER_AFTER_DAYS)
    plays = (
        select(user_track_plays.c.track_id, user_track_plays.c.last_played)
        .where(user_track_plays.c.user_id == current_user.id)
        .subquery()
    )
    disliked = select(user_track_skips.c.track_id).where(
        user_track_skips.c.user_id == current_user.id,
        user_track_skips.c.disliked.is_(True),
    )
    ids = list(
        db.execute(
            select(playlist_tracks.c.track_id)
            .outerjoin(plays, plays.c.track_id == playlist_tracks.c.track_id)
            .where(
                playlist_tracks.c.playlist_id == liked_id,
                (plays.c.last_played.is_(None)) | (plays.c.last_played < since),
                playlist_tracks.c.track_id.not_in(disliked),
            )
        ).scalars()
    )
    if len(ids) < REDISCOVER_MIN:
        return []
    # Новая выборка каждый день, но одна и та же в течение дня.
    day = now.date().isoformat()
    ids.sort(key=lambda track_id: stable_jitter(f"rediscover:{current_user.id}:{day}", track_id))
    return _load_tracks(db, ids[:REDISCOVER_LIMIT])
