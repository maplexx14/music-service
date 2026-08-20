"""Small, read-only quality aggregates for recommendation telemetry."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.models import recommendation_events, recommendation_impressions


def user_metrics(db: Session, user_id: int, days: int = 30) -> dict:
    """Return actionable funnel and diversity metrics for one user."""
    days = max(1, min(int(days), 365))
    since = datetime.now(timezone.utc) - timedelta(days=days)
    deliveries = db.execute(
        select(
            func.count().label("delivered"),
            func.sum(case((recommendation_impressions.c.visible.is_(True), 1), else_=0)).label("visible"),
            func.count(func.distinct(recommendation_impressions.c.artist)).label("artists"),
        ).where(
            recommendation_impressions.c.user_id == user_id,
            recommendation_impressions.c.shown_at >= since,
        )
    ).one()
    events = db.execute(
        select(
            func.sum(case((recommendation_events.c.event_type.in_(["play", "listen"]), 1), else_=0)).label("plays"),
            func.sum(case((recommendation_events.c.event_type == "skip", 1), else_=0)).label("skips"),
            func.sum(case((recommendation_events.c.event_type == "like", 1), else_=0)).label("likes"),
            func.sum(case((recommendation_events.c.event_type == "dislike", 1), else_=0)).label("dislikes"),
        ).where(
            recommendation_events.c.user_id == user_id,
            recommendation_events.c.occurred_at >= since,
        )
    ).one()
    delivered = int(deliveries.delivered or 0)
    visible = int(deliveries.visible or 0)
    plays = int(events.plays or 0)
    skips = int(events.skips or 0)
    return {
        "days": days,
        "delivered": delivered,
        "visible": visible,
        "artists": int(deliveries.artists or 0),
        "plays": plays,
        "skips": skips,
        "likes": int(events.likes or 0),
        "dislikes": int(events.dislikes or 0),
        "visibility_rate": round(visible / delivered, 4) if delivered else 0.0,
        "play_rate_per_visible": round(plays / visible, 4) if visible else 0.0,
        "skip_rate_per_visible": round(skips / visible, 4) if visible else 0.0,
    }
