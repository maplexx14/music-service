from datetime import datetime, timedelta, timezone

import pytest

from app.context_profile import build_context_profile, context_bonus, hour_bucket
from app.models import Track, recommendation_events
from tests.conftest import create_user


@pytest.mark.parametrize(
    ("hour", "expected"),
    [(5, "morning"), (10, "morning"), (11, "day"), (17, "evening"), (23, "night"), (3, "night"), (None, None)],
)
def test_hour_bucket(hour, expected):
    assert hour_bucket(hour) == expected


def test_context_profile_uses_bucket_recency_and_feedback(db):
    user = create_user(db, username="context-user")
    liked = Track(title="Focus", artist="Day Artist", genre="ambient", duration=180)
    skipped = Track(title="Noise", artist="Skip Artist", genre="metal", duration=180)
    db.add_all([liked, skipped])
    db.commit()
    now = datetime.now(timezone.utc)
    db.execute(
        recommendation_events.insert(),
        [
            {
                "user_id": user.id,
                "track_id": liked.id,
                "artist": liked.artist,
                "event_type": "like",
                "client_hour": 9,
                "occurred_at": now,
            },
            {
                "user_id": user.id,
                "track_id": skipped.id,
                "artist": skipped.artist,
                "event_type": "dislike",
                "client_hour": 9,
                "occurred_at": now,
            },
            {
                "user_id": user.id,
                "track_id": skipped.id,
                "artist": skipped.artist,
                "event_type": "like",
                "client_hour": 20,
                "occurred_at": now,
            },
            {
                "user_id": user.id,
                "track_id": liked.id,
                "artist": liked.artist,
                "event_type": "like",
                "client_hour": 9,
                "occurred_at": now - timedelta(days=200),
            },
        ],
    )
    db.commit()

    profile = build_context_profile(db, user.id, "morning", now=now)

    assert profile["artist"]["day artist"] > 0
    assert profile["artist"]["skip artist"] < 0
    assert profile["genre"]["ambient"] > 0
    assert context_bonus(liked, profile) > 0
    assert context_bonus(skipped, profile) < 0


def test_context_profile_is_empty_without_client_context(db):
    user = create_user(db, username="no-context-user")
    assert build_context_profile(db, user.id, None) == {"artist": {}, "genre": {}}
