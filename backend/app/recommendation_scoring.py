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

from app.acoustic_features import acoustic_similarity

ALGORITHM_VERSION = "hybrid-v7"

# Popularity must never overpower a user's explicit signal or a content match,
# but it does have to separate a genuine hit from a no-name upload.  The weight
# stays far below affinity (2.4) while the curve below keeps the *spread* usable:
# with tanh(raw / 5.0) every candidate above ~1k plays scored 0.72..0.98, so the
# whole real range of play counts was worth 0.04 points — less than the novelty
# bonus alone, i.e. popularity could not decide anything.
_POPULARITY_WEIGHT = 0.5
_FRESHNESS_WEIGHT = 0.22
_AFFINITY_WEIGHT = 2.4
_CONTENT_WEIGHT = 1.15
_ACOUSTIC_WEIGHT = 1.55
_SOURCE_WEIGHT = 0.18
_NOVELTY_WEIGHT = 0.16
_FATIGUE_WEIGHT = 0.55
_CONTEXT_WEIGHT = 0.65
_POPULATION_QUALITY_WEIGHT = 1.0

# Play counts arrive on two incompatible scales, and they used to share one
# curve.  ``Track.play_count`` is OUR counter (a few hundred plays is a
# well-known track in this catalogue); a provider metric is views/playback_count,
# where a few hundred means nobody listened.  The shared curve rated every
# external candidate — hit and bedroom upload alike — as maximally popular.
LOCAL_POPULARITY_REFERENCE = 400
SERVICE_POPULARITY_REFERENCE = 3_000_000


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


def popularity_score(
    play_count: Any = 0,
    listener_count: Any = 0,
    *,
    reference: float = LOCAL_POPULARITY_REFERENCE,
) -> float:
    """Return a bounded popularity signal with diminishing returns.

    ``listener_count`` is optional for compatibility with old catalogues.  The
    unique-listener term prevents a single user's repeated plays from looking
    like broad popularity once the aggregate is available.  When it is unknown
    the play term carries the full signal instead of losing 35% of it: provider
    candidates never have a listener aggregate, and splitting the weight anyway
    made every external track look less popular than it is.

    ``reference`` is the count that earns a full score, and it is what keeps the
    two counter scales apart — see ``SERVICE_POPULARITY_REFERENCE``.  The ramp is
    linear in ``log1p`` so the ordinary range of counts stays separable; the old
    ``tanh`` on top of the logarithm compressed everything above a thousand plays
    into the same value.
    """
    try:
        plays = max(0.0, float(play_count or 0))
    except (TypeError, ValueError):
        plays = 0.0
    try:
        listeners = max(0.0, float(listener_count or 0))
    except (TypeError, ValueError):
        listeners = 0.0
    if listeners > 0:
        raw = math.log1p(plays) * 0.65 + math.log1p(listeners) * 0.35
    else:
        raw = math.log1p(plays)
    scale = math.log1p(max(1.0, float(reference or LOCAL_POPULARITY_REFERENCE)))
    return max(0.0, min(1.0, raw / scale))


def population_quality_score(positive_users: Any = 0, negative_users: Any = 0) -> float:
    """Return a conservative population feedback signal in ``[-1, 1]``.

    Distinct users are used by the query layer, so one active listener cannot
    sink an item alone.  A 25% negative-rate prior prevents cold candidates
    from being punished before there is evidence.  Negative evidence is more
    actionable than positive evidence: popularity already rewards accepted
    tracks, while this signal exists mainly to suppress broadly skipped ones.
    """
    try:
        positive = max(0.0, float(positive_users or 0))
    except (TypeError, ValueError):
        positive = 0.0
    try:
        negative = max(0.0, float(negative_users or 0))
    except (TypeError, ValueError):
        negative = 0.0
    evidence = positive + negative
    if evidence < 2.0:
        return 0.0

    negative_rate = (negative + 1.0) / (evidence + 4.0)
    if negative_rate >= 0.25:
        deviation = -(negative_rate - 0.25) / 0.25
    else:
        deviation = (0.25 - negative_rate) / 0.75
    confidence = min(1.0, evidence / 8.0)
    return max(-1.0, min(1.0, deviation)) * confidence


def population_rejects(positive_users: Any = 0, negative_users: Any = 0) -> bool:
    """Whether discovery evidence is strong enough for a hard quality gate."""
    try:
        positive = max(0, int(positive_users or 0))
    except (TypeError, ValueError):
        positive = 0
    try:
        negative = max(0, int(negative_users or 0))
    except (TypeError, ValueError):
        negative = 0
    return negative >= max(3, positive * 2 + 1)


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


def fatigue_score(shown_count: Any = 0, last_shown: Any = None, now: Optional[datetime] = None) -> float:
    """Return a time-decayed exposure score in ``[0, 1]``.

    Repeated visible impressions should cool down naturally; an item shown
    yesterday is not equivalent to one shown five minutes ago.  The logarithm
    prevents a long session from making the penalty grow without bound.
    """
    try:
        count = max(0.0, float(shown_count or 0))
    except (TypeError, ValueError):
        count = 0.0
    timestamp = _as_utc(last_shown)
    if timestamp is None or count <= 0:
        return 0.0
    now_utc = _as_utc(now) or datetime.now(timezone.utc)
    age_hours = max(0.0, (now_utc - timestamp).total_seconds() / 3600.0)
    recency = math.exp(-age_hours / 36.0)
    return min(1.0, math.log1p(count) / math.log1p(6.0) * recency)


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
    fatigue_level: Optional[float] = None,
    novelty: bool = False,
    source: Optional[str] = None,
    play_count: Optional[int] = None,
    listener_count: int = 0,
    popularity_reference: Optional[float] = None,
    popularity: Optional[float] = None,
    content_bonus: float = 0.0,
    acoustic_profile: Any = None,
    acoustic_bonus: float = 0.0,
    context_bonus: float = 0.0,
    population_quality: float = 0.0,
    now: Optional[datetime] = None,
) -> float:
    """Compute a bounded, explainable score for one candidate.

    All inputs are normalized before weighting.  The function is intentionally
    pure, which makes offline replay and regression tests straightforward.
    """
    affinity = math.tanh(float(artist_affinity or 0.0) / 8.0)
    match = max(0.0, min(1.0, content_match(track, genres) + float(content_bonus or 0.0)))
    acoustic_fit = max(
        0.0,
        min(
            1.0,
            acoustic_similarity(_field(track, "acoustic_features"), acoustic_profile)
            + float(acoustic_bonus or 0.0),
        ),
    )
    popularity = (
        popularity_score(
            _field(track, "play_count", 0) if play_count is None else play_count,
            listener_count or _field(track, "unique_listener_count", 0),
            reference=(
                LOCAL_POPULARITY_REFERENCE
                if popularity_reference is None
                else popularity_reference
            ),
        )
        if popularity is None
        else max(0.0, min(1.0, float(popularity)))
    )
    freshness = freshness_score(track, now=now)
    source_fit = source_confidence(source or _field(track, "source"))
    completion_fit = 0.0 if completion is None else (max(0.0, min(1.0, float(completion))) - 0.5) * 0.7
    skip_penalty = min(1.5, math.log1p(max(0, int(skip_count or 0))) * 0.42)
    if disliked:
        skip_penalty += 1.5
    if fatigue_level is None:
        fatigue_penalty = 0.25 if fatigued else 0.0
    else:
        fatigue_penalty = _FATIGUE_WEIGHT * max(0.0, min(1.0, float(fatigue_level)))
    novelty_bonus = _NOVELTY_WEIGHT if novelty else 0.0
    context_fit = max(-1.0, min(1.0, float(context_bonus or 0.0)))
    population_fit = max(-1.0, min(1.0, float(population_quality or 0.0)))
    score = (
        _AFFINITY_WEIGHT * affinity
        + _CONTENT_WEIGHT * match
        + _ACOUSTIC_WEIGHT * acoustic_fit
        + _POPULARITY_WEIGHT * popularity
        + _FRESHNESS_WEIGHT * freshness
        + _SOURCE_WEIGHT * source_fit
        + novelty_bonus
        + _CONTEXT_WEIGHT * context_fit
        + _POPULATION_QUALITY_WEIGHT * population_fit
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
