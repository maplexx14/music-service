"""Персональный поток («Моя волна»).

Генерирует бесконечную персональную очередь: смесь «разведки» (похожие треки
через радио YouTube Music от сидов пользователя) и «эксплуатации» (локальная
библиотека по любимым артистам/жанрам). Фронт подгружает следующую порцию,
когда очередь подходит к концу, передавая exclude-список уже сыгранного.
"""

import asyncio
import logging
import math
import random
import re
from typing import List, Optional

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import desc, or_
from sqlalchemy.orm import Session

from app.cache import get_cache, set_cache
from app.database import get_db
from app.dependencies import get_current_active_user
from app.models import Track, User, user_liked_tracks, user_track_plays, user_track_skips
from app.routers import ytdlp
from app.routers.ytdlp import clean_title
from app.schemas import ExternalTrackResponse, TrackResponse

logger = logging.getLogger(__name__)

router = APIRouter()

# Сколько последних прослушиваний исключаем из потока (свежесть).
_RECENT_PLAYS_EXCLUDE = 40
# Доля «разведки» (радио-кандидаты) в миксе.
_EXPLORE_RATIO = 0.6
# Кэш радио-пула на сид: радио YT Music стабильно на коротком горизонте,
# нет смысла дёргать его на каждую подгрузку.
_RADIO_TTL = 1800
_RADIO_LIMIT = 50


def _norm_key(artist: str, title: str) -> tuple:
    """Нормализованный ключ (артист, название) для дедупа между источниками."""

    def norm(s: str) -> str:
        s = clean_title(s or "").lower()
        s = re.sub(r"\bfeat\.?\b.*$", "", s)
        s = re.sub(r"[^\w\s]", "", s)
        s = re.sub(r"\s+", " ", s).strip()
        return s

    return (norm(artist), norm(title))


def _taste_profile(db: Session, user_id: int) -> dict:
    """Собирает профиль вкуса пользователя из лайков и истории (блокирующая)."""
    liked = (
        db.query(Track, user_liked_tracks.c.liked_at)
        .join(user_liked_tracks, user_liked_tracks.c.track_id == Track.id)
        .filter(user_liked_tracks.c.user_id == user_id)
        .order_by(desc(user_liked_tracks.c.liked_at))
        .limit(60)
        .all()
    )
    played = (
        db.query(Track, user_track_plays.c.play_count)
        .join(user_track_plays, user_track_plays.c.track_id == Track.id)
        .filter(user_track_plays.c.user_id == user_id)
        .order_by(desc(user_track_plays.c.last_played))
        .limit(60)
        .all()
    )

    # Скипы — негативный сигнал (фронт шлёт их только при <25% прослушивания).
    skipped = (
        db.query(Track, user_track_skips.c.skip_count)
        .join(user_track_skips, user_track_skips.c.track_id == Track.id)
        .filter(user_track_skips.c.user_id == user_id)
        .order_by(desc(user_track_skips.c.last_skipped))
        .limit(120)
        .all()
    )

    artist_weight: dict = {}
    genres: set = set()
    seeds: List[str] = []  # video_id ytmusic-треков, свежие первыми
    seen_seed = set()

    for track, _liked_at in liked:
        artist_weight[track.artist] = artist_weight.get(track.artist, 0) + 3.0
        if track.genre:
            genres.add(track.genre)
        if track.source == "ytmusic" and track.external_id and track.external_id not in seen_seed:
            seeds.append(track.external_id)
            seen_seed.add(track.external_id)

    for track, play_count in played:
        w = 1.0 + math.log1p(play_count or 1)
        artist_weight[track.artist] = artist_weight.get(track.artist, 0) + w
        if track.genre:
            genres.add(track.genre)
        if track.source == "ytmusic" and track.external_id and track.external_id not in seen_seed:
            seeds.append(track.external_id)
            seen_seed.add(track.external_id)

    # Штраф за скипы: сам трек исключаем из волны совсем, артисту снижаем вес
    # (задолбавший артист вылетает из топа, а сид от его трека не выбирается).
    skipped_ids: set = set()
    skipped_keys: set = set()
    skipped_video_ids: set = set()
    for track, skip_count in skipped:
        skipped_ids.add(track.id)
        skipped_keys.add(_norm_key(track.artist, track.title))
        if track.external_id:
            skipped_video_ids.add(track.external_id)
        artist_weight[track.artist] = (
            artist_weight.get(track.artist, 0) - 1.5 * math.log1p(skip_count or 1)
        )

    # Сиды от скипнутых треков не годятся — радио от них тянет то же самое.
    seeds = [s for s in seeds if s not in skipped_video_ids]

    # Недавно игранное — исключаем из потока, чтобы волна не повторялась.
    recent = (
        db.query(Track)
        .join(user_track_plays, user_track_plays.c.track_id == Track.id)
        .filter(user_track_plays.c.user_id == user_id)
        .order_by(desc(user_track_plays.c.last_played))
        .limit(_RECENT_PLAYS_EXCLUDE)
        .all()
    )
    recent_ids = {t.id for t in recent} | skipped_ids
    recent_keys = {_norm_key(t.artist, t.title) for t in recent} | skipped_keys
    recent_video_ids = {t.external_id for t in recent if t.external_id} | skipped_video_ids

    # Холодный старт: нет своих сидов — берём популярные ytmusic-треки сервиса.
    if not seeds:
        popular_yt = (
            db.query(Track)
            .filter(Track.source == "ytmusic", Track.external_id.isnot(None))
            .order_by(desc(Track.play_count))
            .limit(5)
            .all()
        )
        seeds = [t.external_id for t in popular_yt if t.external_id not in skipped_video_ids]

    # В топ идут только артисты с положительным итоговым весом.
    top_artists = [
        a
        for a, w in sorted(artist_weight.items(), key=lambda kv: kv[1], reverse=True)
        if w > 0
    ][:12]
    # Артисты, ушедшие в минус, — фильтр для радио-кандидатов.
    banned_artists = {a.lower() for a, w in artist_weight.items() if w < 0}

    return {
        "seeds": seeds,
        "artists": top_artists,
        "genres": list(genres),
        "banned_artists": banned_artists,
        "recent_ids": recent_ids,
        "recent_keys": recent_keys,
        "recent_video_ids": recent_video_ids,
    }


def _local_candidates(db: Session, profile: dict, limit: int) -> List[Track]:
    """Локальные кандидаты: треки любимых артистов/жанров + популярное (блокирующая)."""
    filters = []
    if profile["artists"]:
        filters.append(Track.artist.in_(profile["artists"]))
    if profile["genres"]:
        filters.append(Track.genre.in_(profile["genres"]))

    candidates: List[Track] = []
    if filters:
        q = db.query(Track).filter(or_(*filters))
        if profile["recent_ids"]:
            q = q.filter(~Track.id.in_(profile["recent_ids"]))
        candidates = q.order_by(desc(Track.play_count)).limit(limit * 3).all()

    # Добор популярным, если по вкусу нашлось мало.
    if len(candidates) < limit:
        skip = {t.id for t in candidates} | profile["recent_ids"]
        q = db.query(Track)
        if skip:
            q = q.filter(~Track.id.in_(skip))
        candidates.extend(q.order_by(desc(Track.play_count)).limit(limit * 2).all())

    return candidates


def _normalize_watch_item(item: dict) -> Optional[ExternalTrackResponse]:
    """Трек из get_watch_playlist → ExternalTrackResponse (ключи отличаются от search)."""
    video_id = item.get("videoId")
    if not video_id:
        return None
    title = clean_title(item.get("title") or "Unknown")
    artists = item.get("artists") or []
    artist = ", ".join(a.get("name", "") for a in artists if a.get("name")).strip() or "Unknown Artist"
    album = None
    alb = item.get("album")
    if isinstance(alb, dict):
        album = alb.get("name")

    # length: строка "3:26"
    dur = 0
    for p in (item.get("length") or "").split(":"):
        if p.strip().isdigit():
            dur = dur * 60 + int(p)

    thumbs = item.get("thumbnail") or item.get("thumbnails") or []
    cover = ytdlp._thumb(thumbs)

    return ExternalTrackResponse(
        id=f"ytmusic:{video_id}",
        source="ytmusic",
        external_id=video_id,
        title=title,
        artist=artist,
        album=album,
        duration=dur,
        cover_url=cover,
        stream_url="",  # заполняется в эндпоинте
        download_url=None,
        download_allowed=False,
    )


def _fetch_radio(seed_video_id: str) -> List[dict]:
    """Радио YT Music от сида (блокирующая). Возвращает сырые items."""
    if ytdlp._ytmusic is None:
        return []
    wp = ytdlp._ytmusic.get_watch_playlist(seed_video_id, radio=True, limit=_RADIO_LIMIT)
    return wp.get("tracks") or []


async def _radio_pool(seed_video_id: str) -> List[ExternalTrackResponse]:
    """Радио-пул от сида с кэшем в Redis (включая негативный — не у каждого
    videoId есть радио, и не гоняем неудачные сиды повторно)."""
    key = f"flow:radio:{seed_video_id}"
    cached = get_cache(key)
    if cached is not None:
        return [ExternalTrackResponse(**t) for t in cached]

    try:
        raw = await asyncio.to_thread(_fetch_radio, seed_video_id)
    except Exception:  # noqa: BLE001
        logger.warning("flow radio failed for seed %s", seed_video_id)
        set_cache(key, [], expire=600)  # негативный кэш — сид без радио
        return []

    pool = []
    for item in raw:
        t = _normalize_watch_item(item)
        # Сам сид тоже приходит первым треком — не отбрасываем, дедуп ниже разберётся.
        if t:
            pool.append(t)

    set_cache(key, [t.model_dump() for t in pool], expire=_RADIO_TTL)
    return pool


def _parse_exclude(exclude: str) -> tuple:
    """'12,ytmusic:abc,...' → (numeric_ids, video_ids)."""
    numeric, videos = set(), set()
    for part in (exclude or "").split(","):
        part = part.strip()
        if not part:
            continue
        if part.isdigit():
            numeric.add(int(part))
        elif ":" in part:
            videos.add(part.split(":", 1)[1])
    return numeric, videos


@router.get("/flow")
async def get_flow(
    request: Request,
    limit: int = Query(20, ge=5, le=50),
    exclude: str = Query("", max_length=4000),
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db),
):
    """Порция персонального потока. exclude — id уже находящихся в очереди."""
    base_url = str(request.base_url).rstrip("/")
    excl_ids, excl_videos = _parse_exclude(exclude)

    profile = await asyncio.to_thread(_taste_profile, db, current_user.id)
    excl_ids |= profile["recent_ids"]
    excl_videos |= profile["recent_video_ids"]
    seen_keys = set(profile["recent_keys"])

    # --- разведка: радио от 1–2 случайных сидов из свежих ---
    # Не у каждого videoId есть радио, поэтому перебираем сиды волнами по 2,
    # пока не соберём хотя бы один непустой пул (максимум 3 волны).
    explore: List[ExternalTrackResponse] = []
    seeds = profile["seeds"][:10]
    if seeds:
        order = random.sample(seeds, len(seeds))
        merged: List[ExternalTrackResponse] = []
        for wave in range(0, min(len(order), 6), 2):
            batch = order[wave : wave + 2]
            pools = await asyncio.gather(*(_radio_pool(s) for s in batch))
            merged.extend(t for pool in pools for t in pool)
            if merged:
                break
        random.shuffle(merged)
        banned = profile["banned_artists"]
        for t in merged:
            key = _norm_key(t.artist, t.title)
            if t.external_id in excl_videos or key in seen_keys:
                continue
            # Артист, заскипанный в минус, не попадает в волну и из радио.
            if banned and any(a.strip().lower() in banned for a in t.artist.split(",")):
                continue
            seen_keys.add(key)
            excl_videos.add(t.external_id)
            t.stream_url = f"{base_url}/api/ytdlp/stream/{t.external_id}"
            explore.append(t)

    # --- эксплуатация: локальная библиотека по вкусу ---
    local = await asyncio.to_thread(_local_candidates, db, profile, limit)
    exploit: List[Track] = []
    for t in local:
        key = _norm_key(t.artist, t.title)
        if t.id in excl_ids or key in seen_keys:
            continue
        if t.external_id and t.external_id in excl_videos:
            continue
        if profile["banned_artists"] and t.artist.strip().lower() in profile["banned_artists"]:
            continue
        seen_keys.add(key)
        excl_ids.add(t.id)
        exploit.append(t)

    # --- микс: ~60% разведка / 40% знакомое, добор из того, что осталось ---
    n_explore = min(len(explore), round(limit * _EXPLORE_RATIO))
    n_exploit = min(len(exploit), limit - n_explore)
    n_explore = min(len(explore), limit - n_exploit)  # добор разведкой

    random.shuffle(exploit)
    mix: List[dict] = []
    mix.extend(t.model_dump() for t in explore[:n_explore])
    mix.extend(
        TrackResponse.model_validate(t).model_dump(mode="json") for t in exploit[:n_exploit]
    )
    random.shuffle(mix)
    return mix
