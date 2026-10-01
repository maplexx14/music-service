"""Как юзер на деле принимает новых артистов в волне.

Ползунок ``User.discovery_ratio`` — это просьба, а не факт. Телеметрия волны
показала, что при ползунке 0.55 новые артисты занимали ~43% порции и
дослушивались в 3 раза реже знакомых. Здесь считается отношение долей
«хороших» исходов (дослушал до ``GOOD_COMPLETION`` или лайкнул) у новых и
знакомых артистов за последние ``WINDOW_DAYS``; ``effective_discovery_ratio``
сжимает им запрошенную новизну.

Новизна берётся из ``recommendation_impressions.features["novel"]`` — так её
видел ранкер в момент отдачи. У строк до появления features её восстанавливаем
по истории: был ли у юзера положительный сигнал по артисту раньше показа.

Оценка сглажена к общей доле хороших исходов с весом ``PRIOR_WEIGHT``: пока
исходов мало, фактор близок к 1 и ползунок работает как раньше.
"""
from __future__ import annotations

import logging
from bisect import bisect_left
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.cache import get_cache, set_cache
from app.feedback_labels import FEEDBACK_EVENT_TYPES, GOOD_COMPLETION, OutcomeTracker
from app.models import (
    Playlist,
    Track,
    playlist_tracks,
    recommendation_events,
    recommendation_impressions,
    user_play_events,
)

logger = logging.getLogger(__name__)

WINDOW_DAYS = 30
PRIOR_WEIGHT = 50.0
MIN_FACTOR = 0.2
# Меньше знакомых артистов — фактор не применяется. У тонкого профиля
# «знакомые» — это горстка имён, выбранных самим юзером, и сравнение с ними
# нечестно: новинки подобраны плохо просто потому, что угадывать не из чего.
# Сжатие новизны здесь закрыло бы юзеру ровно тот путь, которым профиль растёт.
MIN_FAMILIAR_ARTISTS = 10
_CACHE_KEY = "discovery:acceptance:v1:{}"
_CACHE_TTL = 3600


def _utc(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _identity(track_id, source, external_id) -> Optional[str]:
    if track_id is not None:
        return f"local:{track_id}"
    if source and external_id:
        return f"{source}:{external_id}"
    return None


def _artist(value) -> str:
    return str(value or "").strip().lower()


def delivery_outcomes(
    db: Session,
    user_id: int,
    *,
    since: datetime,
    surface: str = "flow",
) -> list[dict]:
    """Отданные позиции с исходом: новизна артиста, хорошо/плохо, features.

    Исход размечает ``app.feedback_labels``. Позиции без единого события
    (не дошёл до них) не возвращаются.
    """
    since = _utc(since)
    deliveries = db.execute(
        select(
            recommendation_impressions.c.request_id,
            recommendation_impressions.c.track_id,
            recommendation_impressions.c.source,
            recommendation_impressions.c.external_id,
            recommendation_impressions.c.artist,
            recommendation_impressions.c.shown_at,
            recommendation_impressions.c.features,
            recommendation_impressions.c.score,
            recommendation_impressions.c.position,
            recommendation_impressions.c.algorithm_version,
        ).where(
            recommendation_impressions.c.user_id == user_id,
            recommendation_impressions.c.surface == surface,
            recommendation_impressions.c.shown_at >= since,
            recommendation_impressions.c.request_id.isnot(None),
        )
    ).all()
    if not deliveries:
        return []

    outcomes: dict[tuple[str, str], OutcomeTracker] = {}
    for request_id, track_id, source, external_id, event_type, value in db.execute(
        select(
            recommendation_events.c.request_id,
            recommendation_events.c.track_id,
            recommendation_events.c.source,
            recommendation_events.c.external_id,
            recommendation_events.c.event_type,
            recommendation_events.c.value,
        ).where(
            recommendation_events.c.user_id == user_id,
            recommendation_events.c.surface == surface,
            recommendation_events.c.occurred_at >= since,
            recommendation_events.c.request_id.isnot(None),
            recommendation_events.c.event_type.in_(FEEDBACK_EVENT_TYPES),
        ).order_by(recommendation_events.c.occurred_at, recommendation_events.c.id)
    ).all():
        ident = _identity(track_id, source, external_id)
        if ident is None:
            continue
        outcomes.setdefault((request_id, ident), OutcomeTracker()).add(event_type, value)
    # Внешний трек мог материализоваться между отдачей и событием: тогда в
    # событии уже track_id, а в строке показа — provider id. Сопоставляем по обоим.
    external_to_local = {}
    pairs = {(s, e) for _r, t, s, e, *_x in deliveries if t is None and s and e}
    if pairs:
        for local_id, source, external_id in db.execute(
            select(Track.id, Track.source, Track.external_id).where(
                Track.external_id.in_({e for _s, e in pairs})
            )
        ).all():
            if (source, external_id) in pairs:
                external_to_local[(source, external_id)] = local_id

    history = _positive_history(db, user_id)
    rows = []
    for (
        request_id, track_id, source, external_id, artist, shown_at, features,
        score, position, algorithm_version,
    ) in deliveries:
        state = outcomes.get((request_id, _identity(track_id, source, external_id)))
        if state is None and track_id is None:
            local_id = external_to_local.get((source, external_id))
            if local_id is not None:
                state = outcomes.get((request_id, f"local:{local_id}"))
        if state is None:
            continue
        features = features if isinstance(features, dict) else {}
        novel = features.get("novel")
        if novel is None:
            stamps = history.get(_artist(artist)) or []
            novel = bisect_left(stamps, _utc(shown_at)) == 0
        rows.append(
            {
                "novel": bool(novel),
                "good": state.good,
                "bad": state.bad,
                "completion": state.completion,
                "score": score,
                "position": position,
                "algorithm_version": algorithm_version,
                "features": features,
            }
        )
    return rows


def acceptance_counts(db: Session, user_id: int, now: Optional[datetime] = None) -> dict:
    """Исходы отданных в волне треков: новые против знакомых артистов."""
    now = _utc(now) or datetime.now(timezone.utc)
    counts = {"novel_good": 0, "novel_n": 0, "familiar_good": 0, "familiar_n": 0}
    for row in delivery_outcomes(db, user_id, since=now - timedelta(days=WINDOW_DAYS)):
        bucket = "novel" if row["novel"] else "familiar"
        counts[f"{bucket}_n"] += 1
        counts[f"{bucket}_good"] += int(row["good"])
    return counts


def _positive_history(db: Session, user_id: int) -> dict[str, list[datetime]]:
    """Когда у юзера появлялся положительный сигнал по артисту (по возрастанию)."""
    rows = db.execute(
        select(Track.artist, playlist_tracks.c.added_at)
        .select_from(
            playlist_tracks.join(Playlist, Playlist.id == playlist_tracks.c.playlist_id)
            .join(Track, Track.id == playlist_tracks.c.track_id)
        )
        .where(Playlist.owner_id == user_id)
    ).all()
    rows += db.execute(
        select(Track.artist, user_play_events.c.played_at)
        .select_from(user_play_events.join(Track, Track.id == user_play_events.c.track_id))
        .where(
            user_play_events.c.user_id == user_id,
            user_play_events.c.completion >= GOOD_COMPLETION,
        )
    ).all()
    history: dict[str, list[datetime]] = {}
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    for artist, ts in rows:
        history.setdefault(_artist(artist), []).append(_utc(ts) or epoch)
    for stamps in history.values():
        stamps.sort()
    return history


def acceptance_factor(counts: dict) -> float:
    """Во сколько раз новые артисты принимаются хуже знакомых, в [MIN_FACTOR, 1]."""
    novel_n = counts.get("novel_n", 0)
    familiar_n = counts.get("familiar_n", 0)
    total = novel_n + familiar_n
    if not total:
        return 1.0
    pooled = (counts.get("novel_good", 0) + counts.get("familiar_good", 0)) / total
    if pooled <= 0:
        return 1.0
    novel_rate = (counts.get("novel_good", 0) + PRIOR_WEIGHT * pooled) / (novel_n + PRIOR_WEIGHT)
    familiar_rate = (counts.get("familiar_good", 0) + PRIOR_WEIGHT * pooled) / (
        familiar_n + PRIOR_WEIGHT
    )
    return max(MIN_FACTOR, min(1.0, novel_rate / familiar_rate))


def cached_acceptance_factor(db: Session, user_id: int) -> float:
    """``acceptance_factor`` с часовым кэшем: история меняется медленно."""
    key = _CACHE_KEY.format(user_id)
    cached = get_cache(key)
    if isinstance(cached, (int, float)):
        return float(cached)
    try:
        factor = acceptance_factor(acceptance_counts(db, user_id))
    except Exception:  # noqa: BLE001 — телеметрия не должна ронять выдачу
        # Упавший запрос оставляет транзакцию Postgres в aborted-состоянии, а
        # сессией дальше пользуется вызывающий код.
        db.rollback()
        logger.exception("discovery acceptance failed user=%s", user_id)
        return 1.0
    set_cache(key, factor, expire=_CACHE_TTL)
    return factor


def discovery_acceptance(db: Session, user_id: int, familiar_artist_count: int) -> float:
    """Фактор приёма новизны с защитой тонкого профиля (см. MIN_FAMILIAR_ARTISTS)."""
    if familiar_artist_count < MIN_FAMILIAR_ARTISTS:
        return 1.0
    return cached_acceptance_factor(db, user_id)
