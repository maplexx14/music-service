"""Shared, deterministic scoring primitives for recommendation surfaces.

The project intentionally keeps this layer dependency-free.  It is a stable
contract between candidate generation and ranking: both the library carousel
and the external flow use the same bounded feature scales and algorithm
version.  A learned model can replace ``score_track`` later without changing
telemetry or endpoint contracts.
"""

from __future__ import annotations

import hashlib
import math
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping, Optional

ALGORITHM_VERSION = "hybrid-v4"

# Keep popularity deliberately small.  A global counter must never overpower a
# user's explicit signal or a content match.
_POPULARITY_WEIGHT = 0.28
_FRESHNESS_WEIGHT = 0.22
_AFFINITY_WEIGHT = 2.4
_CONTENT_WEIGHT = 1.15
_SOURCE_WEIGHT = 0.18
_NOVELTY_WEIGHT = 0.16


def _as_utc(value: Any) -> Optional[datetime]:
    if not isinstance(value, datetime):
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _field(item: Any, name: str, default: Any = None) -> Any:
    """Read an attribute from ORM/Pydantic objects and provider dictionaries."""
    if isinstance(item, Mapping):
        return item.get(name, default)
    return getattr(item, name, default)


def popularity_score(play_count: Any = 0, listener_count: Any = 0) -> float:
    """Return a bounded popularity signal with diminishing returns.

    ``listener_count`` is optional for compatibility with old catalogues.  The
    unique-listener term prevents a single user's repeated plays from looking
    like broad popularity once the aggregate is available.
    """
    try:
        plays = max(0.0, float(play_count or 0))
    except (TypeError, ValueError):
        plays = 0.0
    try:
        listeners = max(0.0, float(listener_count or 0))
    except (TypeError, ValueError):
        listeners = 0.0
    # log1p keeps the signal stable; the square-root term rewards breadth but
    # is capped so a very popular item cannot dominate affinity.
    raw = math.log1p(plays) * 0.65 + math.log1p(listeners) * 0.35
    return math.tanh(raw / 5.0)


def freshness_score(track: Any, now: Optional[datetime] = None) -> float:
    """Return a 0..1 release/ingestion freshness score."""
    timestamp = _as_utc(_field(track, "release_date"))
    if timestamp is None:
        timestamp = _as_utc(_field(track, "created_at"))
    if timestamp is None:
        return 0.0
    now_utc = _as_utc(now) or datetime.now(timezone.utc)
    age_days = max(0.0, (now_utc - timestamp).total_seconds() / 86400.0)
    return math.exp(-age_days / 180.0)


def stable_jitter(user_id: Any, item_key: Any) -> float:
    """Small deterministic tie breaker; never changes the feature ordering."""
    digest = hashlib.blake2b(
        f"{user_id}:{item_key}".encode("utf-8", "ignore"), digest_size=8
    ).digest()
    return int.from_bytes(digest, "big") / float(2**64)


def source_confidence(source: Optional[str]) -> float:
    return {
        "local": 1.0,
        "ytmusic": 0.78,
        "lastfm": 0.66,
        "soundcloud": 0.58,
        "tag": 0.48,
        "cooccurrence": 0.72,
    }.get((source or "local").lower(), 0.5)


def content_match(track: Any, genres: Iterable[str] = ()) -> float:
    wanted = {str(value).strip().lower() for value in genres if value}
    if not wanted:
        return 0.0
    genre = str(_field(track, "genre", "") or "").strip().lower()
    if not genre:
        return 0.0
    if genre in wanted:
        return 1.0
    # Beets and provider metadata often use hierarchical labels.
    return 0.45 if any(value in genre or genre in value for value in wanted) else 0.0


def score_track(
    track: Any,
    *,
    user_id: Any = None,
    artist_affinity: float = 0.0,
    genres: Iterable[str] = (),
    completion: Optional[float] = None,
    skip_count: int = 0,
    disliked: bool = False,
    fatigued: bool = False,
    novelty: bool = False,
    source: Optional[str] = None,
    listener_count: int = 0,
    content_bonus: float = 0.0,
    now: Optional[datetime] = None,
) -> float:
    """Compute a bounded, explainable score for one candidate.

    All inputs are normalized before weighting.  The function is intentionally
    pure, which makes offline replay and regression tests straightforward.
    """
    affinity = math.tanh(float(artist_affinity or 0.0) / 8.0)
    match = max(0.0, min(1.0, content_match(track, genres) + float(content_bonus or 0.0)))
    popularity = popularity_score(
        _field(track, "play_count", 0),
        listener_count or _field(track, "unique_listener_count", 0),
    )
    freshness = freshness_score(track, now=now)
    source_fit = source_confidence(source or _field(track, "source"))
    completion_fit = 0.0 if completion is None else (max(0.0, min(1.0, float(completion))) - 0.5) * 0.7
    skip_penalty = min(1.5, math.log1p(max(0, int(skip_count or 0))) * 0.42)
    if disliked:
        skip_penalty += 1.5
    fatigue_penalty = 0.25 if fatigued else 0.0
    novelty_bonus = _NOVELTY_WEIGHT if novelty else 0.0
    score = (
        _AFFINITY_WEIGHT * affinity
        + _CONTENT_WEIGHT * match
        + _POPULARITY_WEIGHT * popularity
        + _FRESHNESS_WEIGHT * freshness
        + _SOURCE_WEIGHT * source_fit
        + novelty_bonus
        + completion_fit
        - skip_penalty
        - fatigue_penalty
    )
    return float(score)


def rank_items(
    items: Iterable[Any],
    scores: Mapping[Any, float],
    *,
    user_id: Any = None,
    key=lambda item: _field(item, "id"),
) -> list[Any]:
    """Stable descending ranking for local or provider candidates."""
    return sorted(
        list(items),
        key=lambda item: (
            -float(scores.get(key(item), 0.0)),
            stable_jitter(user_id, key(item)),
            str(key(item)),
        ),
    )
