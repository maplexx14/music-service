"""Тонкая настройка волны (User.flow_tuning, app/flow_tuning.py)."""

import pytest

from app import discovery
from app.flow_session import MIN_ARTIST_GAP
from app.flow_tuning import FlowTuning, parse
from app.routers import flow

from tests.conftest import auth_headers, create_user


def test_neutral_tuning_keeps_previous_behaviour():
    tuning = FlowTuning()
    assert tuning.liked_factor == 1.0
    assert tuning.deep_cut_scale == flow._DEEP_CUT_SCALE
    assert tuning.hits_factor == 1.0
    assert tuning.repeat_factor == 1.0
    assert tuning.artist_gap == MIN_ARTIST_GAP
    assert tuning.fresh_seeds(flow._FRESH_SEED_SHARE) == flow._FRESH_SEED_SHARE
    for ratio in (0.0, 0.2, 0.6, 1.0):
        assert flow._liked_cap(15, ratio, tuning.liked_factor) == flow._liked_cap(15, ratio)


def test_extremes_stretch_each_knob():
    low, high = parse({k: 0 for k in ("liked", "depth", "variety", "recent")}), parse(
        {k: 1 for k in ("liked", "depth", "variety", "recent")}
    )
    assert discovery.liked_slots(15, low.liked_factor) == 0
    assert discovery.liked_slots(15, high.liked_factor) > discovery.liked_slots(15)
    # Максимум новых артистов по-прежнему без лайков, как бы ни стоял ползунок.
    assert flow._liked_cap(15, 1.0, high.liked_factor) == 0
    assert low.deep_cut_scale < flow._DEEP_CUT_SCALE < high.deep_cut_scale
    # «Хиты» слева: популярность весит больше, справа — меньше.
    assert low.hits_factor == pytest.approx(3.0)
    assert high.hits_factor == pytest.approx(1 / 3)
    assert low.repeat_factor < 1.0 < high.repeat_factor
    assert low.artist_gap < MIN_ARTIST_GAP < high.artist_gap
    assert low.fresh_seeds(2) == 0 and high.fresh_seeds(2) == 4


def test_parse_ignores_garbage():
    tuning = parse({"liked": "abc", "depth": 7, "variety": float("nan"), "other": 1})
    assert tuning == FlowTuning(liked=0.5, depth=1.0, variety=0.5, recent=0.5)
    assert parse(None) == FlowTuning()


def test_hits_knob_moves_catalog_towards_top():
    ranked = list(range(40))

    def mean_rank(scale):
        total = 0
        for context in range(200):
            total += sum(flow._rank_weighted_shuffle(ranked, str(context), "s", str, scale)[:5])
        return total / 200

    assert mean_rank(1.5) < mean_rank(6.0) < mean_rank(24.0)


def test_fresh_share_controls_seed_mix():
    fresh, rest = ["f1", "f2", "f3", "f4"], ["r1", "r2", "r3", "r4"]
    assert not set(flow._mix_fresh_seeds(fresh, rest, 4, "c", "s", 0)) & set(fresh)
    assert set(flow._mix_fresh_seeds(fresh, rest, 4, "c", "s", 4)) == set(fresh)


def test_preferences_roundtrip_flow_tuning(client, db):
    create_user(db, username="tuner")
    headers = auth_headers(client, username="tuner")

    assert client.get("/api/users/me", headers=headers).json()["flow_tuning"] == {}

    saved = client.put(
        "/api/users/me/preferences",
        headers=headers,
        json={"flow_tuning": {"liked": 0.8, "depth": 0.1, "variety": 1, "recent": 0.5}},
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["flow_tuning"] == {
        "liked": 0.8, "depth": 0.1, "variety": 1.0, "recent": 0.5,
    }

    # Сохранение без настроек их не сбрасывает.
    kept = client.put(
        "/api/users/me/preferences", headers=headers, json={"discovery_ratio": 0.4}
    )
    assert kept.json()["flow_tuning"]["liked"] == 0.8


@pytest.mark.parametrize("bad", [1.5, -0.1])
def test_preferences_reject_tuning_out_of_range(client, db, bad):
    create_user(db, username="bad-tuner")
    resp = client.put(
        "/api/users/me/preferences",
        headers=auth_headers(client, username="bad-tuner"),
        json={"flow_tuning": {"liked": bad}},
    )
    assert resp.status_code == 422
