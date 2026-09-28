"""Оценка приёма новых артистов и эффективный ползунок новизны."""

from datetime import datetime, timedelta, timezone

import pytest

from app.cache import clear_pattern
from app.discovery import effective_discovery_ratio
from app.discovery_feedback import (
    acceptance_counts,
    acceptance_factor,
    cached_acceptance_factor,
    discovery_acceptance,
)
from app.models import (
    Playlist,
    Track,
    playlist_tracks,
    recommendation_events,
    recommendation_impressions,
)

from tests.conftest import create_user


@pytest.fixture(autouse=True)
def _clear_acceptance_cache():
    clear_pattern("discovery:acceptance:*")
    yield
    clear_pattern("discovery:acceptance:*")


def test_effective_ratio_scales_only_the_part_above_default():
    assert effective_discovery_ratio(0.1, 0.2) == 0.1
    assert effective_discovery_ratio(0.2, 0.2) == 0.2
    assert effective_discovery_ratio(1.0, 1.0) == 1.0
    assert effective_discovery_ratio(1.0, 0.2) == pytest.approx(0.36)
    assert effective_discovery_ratio(0.55, 0.5) == pytest.approx(0.375)


def test_acceptance_factor_is_neutral_without_evidence():
    assert acceptance_factor({}) == 1.0
    assert acceptance_factor({"novel_n": 3, "novel_good": 0, "familiar_n": 3, "familiar_good": 1}) > 0.8


def test_acceptance_factor_reflects_strong_evidence_and_is_clamped():
    prod_like = {"novel_n": 1643, "novel_good": 43, "familiar_n": 2159, "familiar_good": 184}
    assert acceptance_factor(prod_like) == pytest.approx(0.31, abs=0.02)
    hopeless = {"novel_n": 2000, "novel_good": 0, "familiar_n": 2000, "familiar_good": 400}
    assert acceptance_factor(hopeless) == 0.2
    better = {"novel_n": 500, "novel_good": 200, "familiar_n": 500, "familiar_good": 50}
    assert acceptance_factor(better) == 1.0


def _delivery(db, user, *, request_id, artist, external_id, shown_at, features=None):
    db.execute(recommendation_impressions.insert().values(
        user_id=user.id, source="ytmusic", external_id=external_id, title=external_id,
        artist=artist, surface="flow", position=0, request_id=request_id,
        shown_at=shown_at, features=features,
    ))


def _event(db, user, *, request_id, external_id, event_type, value=None, at):
    db.execute(recommendation_events.insert().values(
        user_id=user.id, source="ytmusic", external_id=external_id,
        event_type=event_type, value=value, surface="flow",
        request_id=request_id, occurred_at=at,
    ))


def test_acceptance_counts_use_logged_novelty_and_history_fallback(db):
    user = create_user(db, username="acceptance-user")
    now = datetime.now(timezone.utc)
    liked = Playlist(name="Понравившиеся", is_public=False, is_liked=True, owner_id=user.id)
    known = Track(title="known", artist="KnownArtist", duration=100, source="local")
    db.add_all([liked, known])
    db.commit()
    db.execute(playlist_tracks.insert().values(
        playlist_id=liked.id, track_id=known.id, position=0,
        added_at=now - timedelta(days=10),
    ))
    # Логированная новизна: новый артист бросили, знакомого дослушали.
    _delivery(db, user, request_id="r1", artist="Stranger", external_id="a",
              shown_at=now - timedelta(days=1), features={"novel": True})
    _event(db, user, request_id="r1", external_id="a", event_type="skip", value=0.02, at=now)
    _delivery(db, user, request_id="r1", artist="Whoever", external_id="b",
              shown_at=now - timedelta(days=1), features={"novel": False})
    _event(db, user, request_id="r1", external_id="b", event_type="listen", value=0.95, at=now)
    # Без features: новизна по истории. KnownArtist лайкнут ДО показа — знакомый.
    _delivery(db, user, request_id="r2", artist="KnownArtist", external_id="c",
              shown_at=now - timedelta(days=2))
    _event(db, user, request_id="r2", external_id="c", event_type="like", at=now)
    _delivery(db, user, request_id="r2", artist="OtherStranger", external_id="d",
              shown_at=now - timedelta(days=2))
    _event(db, user, request_id="r2", external_id="d", event_type="listen", value=0.9, at=now)
    # Показ без исхода и показ старше окна не считаются.
    _delivery(db, user, request_id="r3", artist="Silent", external_id="e",
              shown_at=now - timedelta(days=1))
    _delivery(db, user, request_id="r4", artist="Ancient", external_id="f",
              shown_at=now - timedelta(days=90))
    _event(db, user, request_id="r4", external_id="f", event_type="listen", value=1.0,
           at=now - timedelta(days=90))
    db.commit()

    assert acceptance_counts(db, user.id, now=now) == {
        "novel_good": 1, "novel_n": 2, "familiar_good": 2, "familiar_n": 2,
    }


def test_cached_acceptance_factor_is_neutral_for_new_user(db):
    user = create_user(db, username="acceptance-empty-user")
    assert cached_acceptance_factor(db, user.id) == 1.0


def test_recommendation_report_prints_segments(db, monkeypatch, capsys):
    import sys

    from scripts import recommendation_report
    from tests.conftest import TestingSessionLocal

    user = create_user(db, username="report-user")
    now = datetime.now(timezone.utc)
    for index, (novel, event_type, value) in enumerate(
        [(True, "skip", 0.01), (True, "listen", 0.9), (False, "listen", 1.0)]
    ):
        _delivery(
            db, user, request_id="rr", artist=f"Artist{index}", external_id=f"x{index}",
            shown_at=now - timedelta(hours=1),
            features={
                "novel": novel,
                "origin": "radio" if novel else "favorite",
                "components": {"affinity": 0.0 if novel else 1.5, "acoustic": 0.4},
            },
        )
        _event(db, user, request_id="rr", external_id=f"x{index}",
               event_type=event_type, value=value, at=now)
    db.execute(
        recommendation_impressions.update()
        .where(recommendation_impressions.c.request_id == "rr")
        .values(score=1.0, algorithm_version="hybrid-v8")
    )
    db.commit()

    monkeypatch.setattr(recommendation_report, "SessionLocal", TestingSessionLocal)
    monkeypatch.setattr(sys, "argv", ["recommendation_report", "--days", "7"])
    recommendation_report.main()

    out = capsys.readouterr().out
    assert "outcomes=3" in out
    assert "radio" in out and "favorite" in out
    assert "affinity" in out
    assert "hybrid-v8" in out


def test_discovery_acceptance_skips_thin_profiles(db, monkeypatch):
    monkeypatch.setattr(
        "app.discovery_feedback.cached_acceptance_factor", lambda _db, _user_id: 0.3
    )
    assert discovery_acceptance(db, 1, familiar_artist_count=4) == 1.0
    assert discovery_acceptance(db, 1, familiar_artist_count=9) == 1.0
    assert discovery_acceptance(db, 1, familiar_artist_count=10) == 0.3
