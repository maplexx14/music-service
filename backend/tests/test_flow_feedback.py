import asyncio
import time
from datetime import datetime, timezone

import pytest

from app.cache import set_cache
from app.models import Track, recommendation_events, user_track_skips
from app.recommendation_cache import mark_negative_signal
from app.routers import flow
from tests.conftest import create_user


@pytest.mark.parametrize("skips", [1, 2, 3])
def test_ready_pool_protects_favorite_until_three_distinct_songs_are_rejected(db, skips):
    user = create_user(db, "ready-protected")
    items = [
        {"id": f"ytmusic:favorite-{i}", "source": "ytmusic", "external_id": f"favorite-{i}",
         "artist": "Favorite", "title": f"Song {i}"}
        for i in range(5)
    ]
    items += [{"id": "ytmusic:other", "source": "ytmusic", "external_id": "other", "artist": "Other", "title": "Other"}]
    features = {flow._flow_item_identity(item): {"protected_artist": item["artist"] == "Favorite"} for item in items}
    history = {"ids": []}
    set_cache(flow._ready_key(user.id), {
        "items": items, "features": features, "context": flow._ranking_context(user.id, history),
        "algorithm_version": flow.ALGORITHM_VERSION,
        "created": time.time() - 1,
    })
    for i in range(skips):
        db.execute(recommendation_events.insert().values(
            user_id=user.id, source="ytmusic", external_id=f"favorite-{i}", artist="Favorite",
            event_type="skip", surface="flow", occurred_at=datetime.now(timezone.utc),
        ))
    # A materialized dislike for the first song is the same negative song,
    # even though the earlier event had no database id.
    track = Track(title="Song 0", artist="Favorite", source="ytmusic", external_id="favorite-0", duration=180)
    db.add(track)
    db.flush()
    db.execute(user_track_skips.insert().values(
        user_id=user.id, track_id=track.id, disliked=True, last_skipped=datetime.now(timezone.utc),
    ))
    db.commit()
    mark_negative_signal(user.id)
    ready, state = asyncio.run(flow._take_ready_portion(db, user.id, history, 1, ""))
    assert state == "hit"
    kept = ready[0]
    assert all(item["external_id"] not in {f"favorite-{i}" for i in range(skips)} for item in kept)
    assert any(item["artist"] == "Favorite" for item in kept) is (skips < 3)


def test_warmer_refreshes_pools_from_previous_algorithm():
    from app import flow_warmer

    payload = {"context": "same", "items": [{}, {}], "created": time.time(), "algorithm_version": "hybrid-v18"}
    assert not flow_warmer._is_current(payload, "same", 1)
    payload["algorithm_version"] = flow.ALGORITHM_VERSION
    assert flow_warmer._is_current(payload, "same", 1)
