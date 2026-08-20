"""Time-of-day taste profiles used by recommendation surfaces.

The profile is deliberately small and explainable: feedback in the current
time bucket is aggregated by artist and genre, with both event strength and
recency decay.  It is a ranking hint, never a hard filter.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.artist_utils import artist_key
from app.models import Track, recommendation_events

BUCKET_HOURS = {
    "morning": tuple(range(5, 11)),
    "day": tuple(range(11, 17)),
    "evening": tuple(range(17, 23)),
    "night": (23, 0, 1, 2, 3, 4),
}

_EVENT_WEIGHTS = {
    "play": 1.0,
    "listen": 1.0,
    "like": 2.2,
    "playlist_add": 1.8,
    "skip": -1.25,
    "dislike": -2.4,
}
_HALF_LIFE_DAYS = 45.0
_WINDOW_DAYS = 120
_MAX_ROWS = 5000


def hour_bucket(hour: Optional[int]) -> Optional[str]:
    if hour is None:
        return None
    hour = int(hour)
    if 5 <= hour < 11:
        return "morning"
    if 11 <= hour < 17:
        return "day"
    if 17 <= hour < 23:
        return "evening"
    return "night"


def _utc(value: Any, fallback: datetime) -> datetime:
    if not isinstance(value, datetime):
        return fallback
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _normalise(value: Any) -> str:
    return " ".join(str(value or "").strip().lower().split())


def build_context_profile(
    db: Session,
    user_id: int,
    bucket: Optional[str],
    *,
    now: Optional[datetime] = None,
) -> dict[str, dict[str, float]]:
    """Return bounded artist/genre affinities for one time-of-day bucket."""
    if not bucket or bucket not in BUCKET_HOURS:
        return {"artist": {}, "genre": {}}
    now_utc = _utc(now, datetime.now(timezone.utc))
    cutoff = now_utc - timedelta(days=_WINDOW_DAYS)
    stmt = (
        select(
            recommendation_events.c.artist,
            recommendation_events.c.event_type,
            recommendation_events.c.value,
            recommendation_events.c.occurred_at,
            Track.artist,
            Track.genre,
        )
        .select_from(
            recommendation_events.outerjoin(Track, Track.id == recommendation_events.c.track_id)
        )
        .where(
            recommendation_events.c.user_id == user_id,
            recommendation_events.c.client_hour.in_(BUCKET_HOURS[bucket]),
            recommendation_events.c.occurred_at >= cutoff,
        )
        .order_by(recommendation_events.c.occurred_at.desc())
        .limit(_MAX_ROWS)
    )
    artist_scores: dict[str, float] = {}
    genre_scores: dict[str, float] = {}
    for event_artist, event_type, value, occurred_at, track_artist, genre in db.execute(stmt):
        weight = _EVENT_WEIGHTS.get(str(event_type or "").lower())
        if weight is None:
            continue
        try:
            value_scale = max(0.25, min(2.0, abs(float(value)))) if value is not None else 1.0
        except (TypeError, ValueError):
            value_scale = 1.0
        age_days = max(0.0, (now_utc - _utc(occurred_at, now_utc)).total_seconds() / 86400.0)
        signal = weight * value_scale * math.exp(-math.log(2.0) * age_days / _HALF_LIFE_DAYS)
        key = artist_key(event_artist or track_artist)
        if key:
            artist_scores[key] = artist_scores.get(key, 0.0) + signal
        genre_key = _normalise(genre)
        if genre_key:
            genre_scores[genre_key] = genre_scores.get(genre_key, 0.0) + signal

    def bounded(scores: dict[str, float]) -> dict[str, float]:
        # tanh prevents one intense session from overpowering the regular taste profile.
        return {key: math.tanh(value / 3.0) for key, value in scores.items()}

    return {"artist": bounded(artist_scores), "genre": bounded(genre_scores)}


def context_bonus(track: Any, profile: dict[str, dict[str, float]]) -> float:
    """Combine artist and genre context into a bounded ranking hint."""
    artist = artist_key(getattr(track, "artist", None) if not isinstance(track, dict) else track.get("artist"))
    genre = _normalise(getattr(track, "genre", None) if not isinstance(track, dict) else track.get("genre"))
    artist_score = (profile.get("artist") or {}).get(artist, 0.0)
    genre_score = (profile.get("genre") or {}).get(genre, 0.0)
    return max(-1.0, min(1.0, 0.7 * artist_score + 0.3 * genre_score))
