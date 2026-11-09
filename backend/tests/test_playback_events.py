"""Play intent survives failed starts without becoming listening history."""

import pytest

from app.models import (
    Track,
    playback_events,
    recommendation_events,
    user_play_events,
    user_track_plays,
)
from tests.conftest import auth_headers, create_user


def _click(**changes):
    return {
        "action": "flow",
        "via": "flow",
        "path": "/",
        "source": "flow",
        "client_time": "2026-11-07T10:00:00.123Z",
        "build": "2026-11-07T09:30",
        **changes,
    }


def test_play_click_is_persisted_before_any_track_or_listen(client, db, monkeypatch):
    from app.routers import users

    user = create_user(db, "new-listener")
    headers = {**auth_headers(client, "new-listener"), "User-Agent": "Play intent test"}

    def unexpected_invalidation(*_args, **_kwargs):
        pytest.fail("A Play click must not change recommendation state")

    monkeypatch.setattr(users, "invalidate_recommendation_cache", unexpected_invalidation)
    monkeypatch.setattr(users, "invalidate_flow_ready", unexpected_invalidation)
    response = client.post("/api/users/me/play-click", headers=headers, json=_click())
    assert response.status_code == 204, response.text

    row = db.execute(playback_events.select()).mappings().one()
    assert row["user_id"] == user.id
    assert row["event_type"] == "play_click"
    assert row["occurred_at"] is not None
    assert row["metadata"]["action"] == "flow"
    assert row["metadata"]["path"] == "/"
    assert row["metadata"]["build"] == "2026-11-07T09:30"
    assert row["metadata"]["user_agent"] == "Play intent test"
    assert "track_id" not in row["metadata"]
    assert db.query(Track).count() == 0
    for table in (user_track_plays, user_play_events, recommendation_events):
        assert db.execute(table.select()).all() == []


def test_play_click_keeps_external_track_and_uses_authenticated_identity(client, db):
    user = create_user(db, "listener")
    other = create_user(db, "other")
    payload = _click(
        action="track", via="track", path="/search", source="external",
        track_id="ytmusic:unresolved-video", track_source="ytmusic",
        external_id="unresolved-video", title="New song", artist="New artist",
        user_id=other.id, event_type="listen", user_agent="untrusted client value",
    )
    response = client.post("/api/users/me/play-click", headers=auth_headers(client, "listener"), json=payload)
    assert response.status_code == 204, response.text
    row = db.execute(playback_events.select()).mappings().one()
    assert row["user_id"] == user.id
    assert row["event_type"] == "play_click"
    assert row["metadata"]["track_id"] == "ytmusic:unresolved-video"
    assert row["metadata"]["external_id"] == "unresolved-video"
    assert row["metadata"]["user_agent"] != "untrusted client value"
    assert "user_id" not in row["metadata"]
    assert db.query(Track).count() == 0


def test_repeated_play_clicks_are_distinct_attempts(client, db):
    create_user(db, "listener")
    headers = auth_headers(client, "listener")
    for via in ("mini_player", "media_session"):
        response = client.post("/api/users/me/play-click", headers=headers, json=_click(
            action="resume", via=via, track_id="123", position=12.5,
        ))
        assert response.status_code == 204, response.text
    rows = db.execute(playback_events.select().order_by(playback_events.c.occurred_at)).mappings().all()
    assert [row["metadata"]["via"] for row in rows] == ["mini_player", "media_session"]
    assert all(row["metadata"]["position"] == 12.5 for row in rows)


def test_play_click_requires_auth(client, db):
    response = client.post("/api/users/me/play-click", json=_click())
    assert response.status_code == 401
    assert db.execute(playback_events.select()).all() == []


@pytest.mark.parametrize("changes", [{"action": "autoplay"}, {"position": -1}, {"via": "x" * 41}])
def test_invalid_play_click_is_not_saved(client, db, changes):
    create_user(db, "listener")
    response = client.post("/api/users/me/play-click", headers=auth_headers(client, "listener"), json=_click(**changes))
    assert response.status_code == 422
    assert db.execute(playback_events.select()).all() == []
