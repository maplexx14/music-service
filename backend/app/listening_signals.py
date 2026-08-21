"""Legacy listening-signal helper kept for compatibility.

Imports no longer call this function: playlist membership is represented as a
curation signal with explicit provenance instead of a synthetic listen.  The
function remains available to older integrations during the migration window.
"""

from datetime import datetime, timezone
from typing import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Track, rec_impressions, user_play_events, user_track_plays


def record_imported_track_plays(
    db: Session,
    *,
    user_id: int,
    track_ids: Iterable[int],
) -> int:
    """Legacy idempotent backfill helper; new imports must not call it."""
    unique_track_ids = list(dict.fromkeys(int(track_id) for track_id in track_ids))
    if not unique_track_ids:
        return 0

    existing_ids = set(
        db.execute(
            select(user_track_plays.c.track_id).where(
                user_track_plays.c.user_id == user_id,
                user_track_plays.c.track_id.in_(unique_track_ids),
            )
        )
        .scalars()
        .all()
    )
    new_track_ids = [
        track_id for track_id in unique_track_ids if track_id not in existing_ids
    ]
    if not new_track_ids:
        return 0

    recorded_at = datetime.now(timezone.utc)
    db.execute(
        user_track_plays.insert(),
        [
            {
                "user_id": user_id,
                "track_id": track_id,
                "play_count": 1,
                "last_played": recorded_at,
            }
            for track_id in new_track_ids
        ],
    )
    db.execute(
        user_play_events.insert(),
        [
            {
                "user_id": user_id,
                "track_id": track_id,
                "played_at": recorded_at,
                "completion": 1.0,
                "client_hour": None,
            }
            for track_id in new_track_ids
        ],
    )
    db.query(Track).filter(Track.id.in_(new_track_ids)).update(
        {
            Track.play_count: Track.play_count + 1,
            Track.unique_listener_count: Track.unique_listener_count + 1,
        },
        synchronize_session=False,
    )
    db.execute(
        rec_impressions.delete().where(
            (rec_impressions.c.user_id == user_id)
            & (rec_impressions.c.track_id.in_(new_track_ids))
        )
    )
    return len(new_track_ids)
