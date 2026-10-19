"""Оценка приёма новых артистов (для отчёта) и исходы по источникам."""

from datetime import datetime, timedelta, timezone

import pytest

from app.discovery_feedback import (
    acceptance_counts,
    acceptance_factor,
)
from app.models import (
    Playlist,
    Track,
    playlist_tracks,
    recommendation_events,
    recommendation_impressions,
)

from tests.conftest import create_user


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


def test_origin_terms_follow_acceptance_and_stay_bounded():
    from app.discovery_feedback import ORIGIN_TERM_WEIGHT, origin_terms

    # Прод, 2026-10-01: local почти не принимают, лайки — лучше всех.
    counts = {"local": [2, 323], "liked": [30, 240], "radio": [4, 100], "favorite": [18, 315]}
    terms = origin_terms(counts, "seed")
    assert terms["local"] < -0.5
    assert 0 < terms["liked"] <= 0.5 * ORIGIN_TERM_WEIGHT
    assert terms["local"] < terms["radio"] < terms["liked"]
    # Сэмпл стабилен внутри запроса и меняется между запросами.
    assert origin_terms(counts, "seed") == terms
    assert origin_terms(counts, "other") != terms


def test_origin_terms_need_evidence():
    from app.discovery_feedback import origin_terms

    assert origin_terms({"local": [0, 40], "liked": [5, 40]}, "s") == {}
    assert origin_terms({"local": [0, 400]}, "s") == {}


def test_origin_counts_group_outcomes_by_logged_origin(db):
    from app.discovery_feedback import origin_counts

    user = create_user(db, username="origin-user")
    now = datetime.now(timezone.utc)
    for ext, origin, event, value in (
        ("a", "local", "skip", 0.05),
        ("b", "local", "listen", 0.95),
        ("c", "radio", "like", None),
        ("d", None, "listen", 0.95),
    ):
        _delivery(db, user, request_id="r1", artist="X", external_id=ext,
                  shown_at=now - timedelta(hours=1),
                  features={"origin": origin} if origin else {})
        _event(db, user, request_id="r1", external_id=ext, event_type=event, value=value, at=now)
    db.commit()

    assert origin_counts(db, user.id, now=now) == {"local": [1, 2], "radio": [1, 1]}


def test_outcome_stats_reward_by_origin_and_script(db):
    from app.discovery_feedback import outcome_stats

    user = create_user(db, username="outcome-user")
    now = datetime.now(timezone.utc)
    for ext, artist, origin, event, value in (
        ("a", "Band", "local", "skip", 0.05),       # плохо — 0
        ("b", "Band", "local", "listen", 0.5),      # между — 0.5
        ("c", "Группа", "radio", "like", None),     # хорошо — 1
    ):
        _delivery(db, user, request_id="r1", artist=artist, external_id=ext,
                  shown_at=now - timedelta(hours=1), features={"origin": origin})
        _event(db, user, request_id="r1", external_id=ext, event_type=event, value=value, at=now)
    db.commit()

    assert outcome_stats(db, user.id, now=now) == {
        "origin": {"local": [0, 2, 0.5], "radio": [1, 1, 1.0]},
        "script": {"lat": [0, 2, 0.5], "cyr": [1, 1, 1.0]},
    }


def _prod_like_population():
    def stats(n, good, bad):
        g, b = round(n * good), round(n * bad)
        return [g, n, g + 0.5 * (n - g - b)]

    # Прод, 14 дней до 2026-10-13: local и similar_hits почти не принимают.
    return {
        "radio": stats(1542, 0.058, 0.645),
        "favorite": stats(1466, 0.052, 0.687),
        "local": stats(1028, 0.024, 0.817),
        "similar_hits": stats(276, 0.007, 0.696),
    }


def test_source_posteriors_need_population_and_cap_evidence():
    from app.discovery_feedback import SOURCE_EVIDENCE_CAP, source_posteriors

    assert source_posteriors({}, {"radio": [1, 50, 20.0]}) == {}
    # Все исходы плохие (награда 0) — Beta не построить, сэмплирования нет.
    assert source_posteriors({}, {"radio": [0, 500, 0.0], "local": [0, 300, 0.0]}) == {}
    posteriors = source_posteriors({"local": [0, 900, 50.0]}, _prod_like_population())
    for alpha, beta in posteriors.values():
        assert alpha + beta <= SOURCE_EVIDENCE_CAP + 1e-9
    mean = {name: a / (a + b) for name, (a, b) in posteriors.items()}
    assert mean["local"] < mean["similar_hits"] < mean["favorite"] < mean["radio"]
    # Новый источник — между, по общей доле.
    assert "*" in posteriors


def test_thompson_source_order_prefers_accepted_sources():
    from collections import Counter

    from app.discovery_feedback import source_posteriors, thompson_source_order

    posteriors = source_posteriors({}, _prod_like_population())
    items = [(origin, i) for origin in ("local", "radio", "similar_hits") for i in range(20)]
    first = Counter()
    for seed in range(200):
        order = thompson_source_order(
            items, lambda item: item[0], posteriors, seed=f"s{seed}", window=15
        )
        assert sorted(order) == sorted(items)
        # Внутри источника порядок рейтинга сохраняется.
        for origin in ("local", "radio", "similar_hits"):
            assert [i for o, i in order if o == origin] == list(range(20))
        window = Counter(o for o, _i in order[:15])
        assert max(window.values()) <= 9  # MAX_SOURCE_SHARE 0.6 от 15
        first.update(window)
    assert first["radio"] > first["similar_hits"] > first["local"]
    # Детерминирован в запросе; без апостериоров — рейтинг как есть.
    assert thompson_source_order(items, lambda i: i[0], posteriors, seed="x", window=15) == \
        thompson_source_order(items, lambda i: i[0], posteriors, seed="x", window=15)
    assert thompson_source_order(items, lambda i: i[0], {}, seed="x", window=15) == items


def test_language_terms_prior_from_library_and_fade_with_evidence():
    from app.discovery_feedback import language_terms

    population = {"cyr": [0, 1000, 300.0], "lat": [0, 4000, 1200.0]}
    # Новый юзер, коллекция на 82% русская: латиница вниз, кириллица без поправки.
    terms = language_terms({}, population, 0.82, 11)
    assert set(terms) == {"lat"} and terms["lat"] < -0.4
    # Мало текстов в коллекции или смешанная — не сигнал.
    assert language_terms({}, population, 0.9, 5) == {}
    assert language_terms({}, population, 0.5, 100) == {}
    # Исходы показывают, что латиницу принимают не хуже, — поправка сходит на нет.
    accepted = {"cyr": [5, 100, 30.0], "lat": [20, 400, 120.0]}
    assert language_terms(accepted, population, 0.82, 11).get("lat", 0.0) > -0.1


def test_thompson_source_order_keeps_far_weaker_sources_back():
    """Сэмпл выбирает между сравнимыми: radio-хит со score 0.7 не обгоняет
    любимых около 2.6, пока они не кончились (прод, 2026-10-19)."""
    from app.discovery_feedback import source_posteriors, thompson_source_order

    posteriors = source_posteriors({}, _prod_like_population())
    scores = {("favorite", 0): 2.7, ("favorite", 1): 2.6, ("radio", 0): 0.7, ("radio", 1): 2.2}
    items = [("favorite", 0), ("favorite", 1), ("radio", 0), ("radio", 1)]
    for seed in range(50):
        order = thompson_source_order(
            items, lambda item: item[0], posteriors, seed=f"s{seed}", window=4,
            score_of=scores.get, max_gap=1.0,
        )
        assert order.index(("radio", 0)) > order.index(("favorite", 1))
    # Без порога поведение прежнее.
    assert thompson_source_order(items, lambda i: i[0], posteriors, seed="x", window=4) == \
        thompson_source_order(items, lambda i: i[0], posteriors, seed="x", window=4, score_of=scores.get)
