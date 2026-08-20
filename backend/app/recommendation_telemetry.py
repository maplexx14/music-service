"""Persistence helpers for recommendation delivery and feedback telemetry."""

from __future__ import annotations

from typing import Any, Iterable, Optional
from uuid import uuid4

from sqlalchemy import and_, func, or_, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from app.models import rec_impressions, recommendation_events, recommendation_impressions
from app.recommendation_scoring import ALGORITHM_VERSION

ALLOWED_EVENT_TYPES = frozenset({
    "impression",
    "play",
    "listen",
    "skip",
    "like",
    "dislike",
    "unlike",
    "undislike",
})


def new_request_id() -> str:
    return uuid4().hex


def _field(item: Any, name: str, default: Any = None) -> Any:
    if isinstance(item, dict):
        return item.get(name, default)
    return getattr(item, name, default)


def record_delivery(
    db: Session,
    *,
    user_id: int,
    items: Iterable[Any],
    surface: str,
    request_id: Optional[str] = None,
    session_id: Optional[str] = None,
    scores: Optional[dict[Any, float]] = None,
    algorithm_version: str = ALGORITHM_VERSION,
) -> str:
    """Append one immutable row per delivered item.

    The caller may pass Pydantic models, ORM objects, or dictionaries.  Rows
    with no local id are still useful because external tracks retain their
    provider identity.
    """
    request_id = request_id or new_request_id()
    rows = []
    for position, item in enumerate(items):
        item_id = _field(item, "id")
        local_id = item_id if isinstance(item_id, int) else _field(item, "db_id")
        external_id = _field(item, "external_id")
        source = _field(item, "source")
        score = None
        if scores is not None:
            score = scores.get(item_id, scores.get(local_id))
        rows.append(
            {
                "user_id": user_id,
                "track_id": local_id if isinstance(local_id, int) else None,
                "source": source,
                "external_id": external_id,
                "title": _field(item, "title"),
                "artist": _field(item, "artist"),
                "surface": surface,
                "position": position,
                "score": score,
                "algorithm_version": algorithm_version,
                "request_id": request_id,
                "session_id": session_id,
                # This is a server delivery.  The client records a separate
                # ``impression`` event after IntersectionObserver/audio proves
                # that the item was actually visible.
                "visible": False,
            }
        )
    if rows:
        db.execute(recommendation_impressions.insert(), rows)
    return request_id


def record_event(
    db: Session,
    *,
    user_id: int,
    event_type: str,
    track_id: Optional[int] = None,
    source: Optional[str] = None,
    external_id: Optional[str] = None,
    title: Optional[str] = None,
    artist: Optional[str] = None,
    value: Optional[float] = None,
    surface: Optional[str] = None,
    position: Optional[int] = None,
    request_id: Optional[str] = None,
    client_hour: Optional[int] = None,
    metadata: Optional[dict] = None,
    algorithm_version: str = ALGORITHM_VERSION,
) -> None:
    if event_type not in ALLOWED_EVENT_TYPES:
        raise ValueError(f"unsupported recommendation event: {event_type}")
    db.execute(
        recommendation_events.insert().values(
            user_id=user_id,
            track_id=track_id,
            source=source,
            external_id=external_id,
            title=title,
            artist=artist,
            event_type=event_type,
            value=value,
            surface=surface,
            position=position,
            algorithm_version=algorithm_version,
            request_id=request_id,
            client_hour=client_hour,
            metadata=metadata,
        )
    )


def mark_impression_visible(
    db: Session,
    *,
    user_id: int,
    request_id: Optional[str] = None,
    track_id: Optional[int] = None,
    source: Optional[str] = None,
    external_id: Optional[str] = None,
    position: Optional[int] = None,
) -> int:
    """Mark the matching server delivery as actually visible and return rows."""
    if not request_id or (
        track_id is None and not (source and external_id) and position is None
    ):
        return 0
    conditions = [
        recommendation_impressions.c.user_id == user_id,
        recommendation_impressions.c.visible.is_(False),
    ]
    if request_id:
        conditions.append(recommendation_impressions.c.request_id == request_id)
    local_identity = (
        recommendation_impressions.c.track_id == track_id
        if track_id is not None
        else None
    )
    provider_identity = (
        and_(
            recommendation_impressions.c.source == source,
            recommendation_impressions.c.external_id == external_id,
        )
        if source and external_id
        else None
    )
    # External deliveries are written before provider tracks are materialised,
    # so their delivery row has ``track_id = NULL``.  An impression may arrive
    # a moment later with the new local id.  Match either stable identity when
    # both are available; preferring only the local id would orphan the
    # original delivery and make a real impression disappear from telemetry.
    if local_identity is not None and provider_identity is not None:
        conditions.append(or_(local_identity, provider_identity))
    elif local_identity is not None:
        conditions.append(local_identity)
    elif provider_identity is not None:
        conditions.append(provider_identity)
    if position is not None:
        conditions.append(recommendation_impressions.c.position == position)
    values = {"visible": True}
    if track_id is not None:
        # Backfill the local link when an external item was materialised
        # between delivery and visibility confirmation.
        values["track_id"] = track_id
    result = db.execute(
        update(recommendation_impressions)
        .where(and_(*conditions))
        .values(**values)
    )
    return int(result.rowcount or 0)


def _increment_fatigue(
    db: Session,
    *,
    user_id: int,
    track_id: int,
    count: int = 1,
) -> None:
    """Increment the compact fatigue aggregate by ``count`` atomically."""
    if count <= 0:
        return
    values = {
        "user_id": user_id,
        "track_id": track_id,
        "shown_count": count,
        "last_shown": func.now(),
    }
    dialect = db.get_bind().dialect.name
    if dialect == "postgresql":
        stmt = pg_insert(rec_impressions).values(**values)
    elif dialect == "sqlite":
        stmt = sqlite_insert(rec_impressions).values(**values)
    else:
        existing = db.execute(
            rec_impressions.select().where(
                rec_impressions.c.user_id == user_id,
                rec_impressions.c.track_id == track_id,
            )
        ).first()
        if existing is None:
            db.execute(rec_impressions.insert().values(**values))
        else:
            db.execute(
                rec_impressions.update()
                .where(
                    rec_impressions.c.user_id == user_id,
                    rec_impressions.c.track_id == track_id,
                )
                .values(
                    shown_count=rec_impressions.c.shown_count + count,
                    last_shown=func.now(),
                )
            )
        return

    db.execute(
        stmt.on_conflict_do_update(
            index_elements=[rec_impressions.c.user_id, rec_impressions.c.track_id],
            set_={
                "shown_count": rec_impressions.c.shown_count + count,
                "last_shown": func.now(),
            },
        )
    )


def link_materialized_deliveries(
    db: Session,
    *,
    user_id: int,
    source: Optional[str],
    external_id: Optional[str],
    track_id: Optional[int],
) -> int:
    """Link visible provider deliveries once their local row is created.

    Flow impressions are often emitted before playback materialises an external
    track.  Backfilling those rows here preserves the impression and makes it
    contribute to the same fatigue aggregate as a local recommendation.  The
    ``track_id IS NULL`` predicate makes repeated imports idempotent.
    """
    if not user_id or not source or not external_id or not track_id:
        return 0
    result = db.execute(
        update(recommendation_impressions)
        .where(
            recommendation_impressions.c.user_id == user_id,
            recommendation_impressions.c.source == source,
            recommendation_impressions.c.external_id == external_id,
            recommendation_impressions.c.track_id.is_(None),
            recommendation_impressions.c.visible.is_(True),
        )
        .values(track_id=track_id)
    )
    linked = int(result.rowcount or 0)
    _increment_fatigue(
        db,
        user_id=user_id,
        track_id=track_id,
        count=linked,
    )
    return linked


def record_impression(
    db: Session,
    *,
    user_id: int,
    request_id: Optional[str] = None,
    track_id: Optional[int] = None,
    source: Optional[str] = None,
    external_id: Optional[str] = None,
    position: Optional[int] = None,
) -> bool:
    """Confirm a delivery and update fatigue once for that delivered item."""
    marked = mark_impression_visible(
        db,
        user_id=user_id,
        request_id=request_id,
        track_id=track_id,
        source=source,
        external_id=external_id,
        position=position,
    )
    if marked <= 0 or track_id is None:
        return marked > 0

    _increment_fatigue(
        db,
        user_id=user_id,
        track_id=track_id,
        count=marked,
    )
    return True
