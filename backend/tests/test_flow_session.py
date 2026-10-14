import random

from app import flow_session, learned_ranker


def _pool(artists):
    return [{"id": index, "artist": artist} for index, artist in enumerate(artists)]


def _select(pool, features, session=None, arm="session", **kwargs):
    return flow_session.select(
        pool,
        limit=kwargs.pop("limit", 4),
        arm=arm,
        identity_of=lambda item: item["id"],
        artist_of=lambda item: item["artist"],
        features=features,
        session=session,
        rng=kwargs.pop("rng", random.Random(5)),
        **kwargs,
    )


def test_parse_session_keeps_known_codes_and_tail():
    events = flow_session.parse_session("n1,x2,cytmusic:ab,,s3")
    assert events == [("n", "1"), ("c", "ytmusic:ab"), ("s", "3")]
    many = ",".join(f"s{i}" for i in range(100))
    assert len(flow_session.parse_session(many)) == flow_session.SESSION_MAX_EVENTS


def test_control_arm_keeps_precomputed_order():
    pool = _pool(["a", "b", "c", "d", "e"])
    chosen, extra = _select(pool, {}, arm="control", limit=3)
    assert [item["id"] for item in chosen] == [0, 1, 2]
    assert all(row == {"arm": "control"} for row in extra.values())


def test_skip_before_sound_pushes_the_artist_down():
    """Скип до звука — отказ по названию и обложке: артист уходит вниз."""
    meta = {"9": {"artist": "a"}}
    state = flow_session.SessionState(flow_session.parse_session("n9"), meta.get)
    pool = _pool(["a", "b", "c", "d", "e", "f"])
    chosen, extra = _select(pool, {}, state, rng=random.Random(1), limit=4)
    assert "a" not in [item["artist"] for item in chosen]
    assert all(row["arm"] == "session" for row in extra.values())


def test_session_prefers_the_origin_the_listener_accepts():
    meta = {
        "1": {"artist": "x", "origin": "local", "novel": True},
        "2": {"artist": "y", "origin": "local", "novel": True},
        "3": {"artist": "z", "origin": "liked", "novel": False},
    }
    state = flow_session.SessionState(flow_session.parse_session("s1,s2,c3"), meta.get)
    pool = _pool(["l1", "l2", "l3", "k1", "k2", "k3"])
    features = {
        index: {"origin": "local" if index < 3 else "liked", "novel": index < 3}
        for index in range(6)
    }
    no_explore = random.Random(0)
    no_explore.random = lambda: 0.99
    chosen, _extra = _select(pool, features, state, rng=no_explore, limit=3)
    assert [item["artist"] for item in chosen] == ["k1", "k2", "k3"]


def test_without_signals_session_arm_keeps_order():
    pool = _pool(["a", "b", "c", "d"])
    rng = random.Random(0)
    rng.random = lambda: 0.99  # без разведки
    chosen, _extra = _select(pool, {}, flow_session.SessionState([], {}.get), rng=rng)
    assert [item["id"] for item in chosen] == [0, 1, 2, 3]


def test_session_arm_keeps_artist_gap_with_previous_portion():
    """Переставленный по сессии пул разносит артистов и на стыке порций."""
    meta = {"9": {"artist": "z"}}
    state = flow_session.SessionState(flow_session.parse_session("s9"), meta.get)
    pool = _pool(["z", "a", "a", "b", "c", "d", "e"])
    rng = random.Random(0)
    rng.random = lambda: 0.99
    chosen, _extra = _select(pool, {}, state, rng=rng, previous_artists=["a"])
    artists = [item["artist"] for item in chosen]
    assert artists[0] != "a"
    assert artists.count("a") <= 1


def test_without_session_terms_pool_order_is_kept_as_interleaved():
    pool = _pool(["a", "a", "b", "c", "d"])
    rng = random.Random(0)
    rng.random = lambda: 0.99
    chosen, _extra = _select(
        pool, {}, flow_session.SessionState([], {}.get), rng=rng, previous_artists=["a"]
    )
    assert [item["id"] for item in chosen] == [0, 1, 2, 3]


def test_exploration_logs_propensity():
    pool = _pool([f"a{i}" for i in range(10)])
    rng = random.Random(0)
    rng.random = lambda: 0.0  # каждое место — разведка
    chosen, extra = _select(pool, {}, flow_session.SessionState([], {}.get), rng=rng, limit=3)
    explored = [row for row in extra.values() if row.get("explore")]
    assert len(explored) == 3
    assert all(0 < row["propensity"] <= flow_session.EXPLORE_RATE for row in explored)


def test_learned_scores_reorder_session_arm():
    pool = _pool(["a", "b", "c", "d"])
    features = {index: {"components": {"affinity": float(index)}} for index in range(4)}
    rng = random.Random(0)
    rng.random = lambda: 0.99
    chosen, extra = _select(
        pool,
        features,
        flow_session.SessionState([], {}.get),
        rng=rng,
        learned=lambda f: 0.8 * f["components"]["affinity"],
        limit=2,
    )
    assert [item["artist"] for item in chosen] == ["d", "c"]
    assert "learned" in extra[3]


def test_neighbours_of_liked_artist_go_up():
    meta = {"1": {"artist": "seed"}}
    state = flow_session.SessionState(flow_session.parse_session("l1"), meta.get)
    pool = _pool(["a", "b", "c", "d", "near"])
    rng = random.Random(0)
    rng.random = lambda: 0.99
    chosen, _extra = _select(pool, {}, state, rng=rng, neighbours={"near"}, limit=3)
    assert "near" in [item["artist"] for item in chosen]
    assert state.positive_artists == ["seed"]


def test_auc_basics():
    assert learned_ranker.auc([0.1, 0.2, 0.9, 0.8], [0, 0, 1, 1]) == 1.0
    assert learned_ranker.auc([0.5, 0.5], [0, 1]) == 0.5


def test_ranker_learns_a_predictive_feature_and_rejects_noise():
    rng = random.Random(3)
    samples = []
    for index in range(1200):
        affinity = rng.random()
        origin = rng.choice(["liked", "local"])
        p = 0.05 + 0.5 * affinity + (0.2 if origin == "liked" else 0.0)
        samples.append(
            ({"components": {"affinity": affinity}, "origin": origin}, int(rng.random() < p), index)
        )
    model = learned_ranker.train(samples)
    assert model is not None and model["auc"] > 0.65
    score = learned_ranker.scorer(model)
    high = score({"components": {"affinity": 0.9}, "origin": "liked"})
    low = score({"components": {"affinity": 0.1}, "origin": "local"})
    assert high > low

    noise = [
        ({"components": {"affinity": rng.random()}}, int(rng.random() < 0.3), index)
        for index in range(1200)
    ]
    assert learned_ranker.train(noise) is None


def test_ranker_rejected_when_no_better_than_manual_score():
    # Исход зависит только от суммы компонент — ручной скор уже знает всё,
    # модели нечего добавить.
    rng = random.Random(5)
    samples = []
    for index in range(1200):
        affinity = rng.random()
        samples.append(({"components": {"affinity": affinity}}, int(rng.random() < 0.1 + 0.6 * affinity), index))
    assert learned_ranker.train(samples) is None


def test_ranker_needs_enough_rows():
    samples = [({"components": {"affinity": 1.0}}, 1, i) for i in range(50)]
    assert learned_ranker.train(samples) is None


def test_samples_skip_neutral_and_unscored_rows():
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    rows = [
        {"good": True, "strong": True, "bad": False, "features": {"components": {"a": 1}}, "shown_at": now},
        {"good": True, "strong": False, "bad": False, "features": {"components": {"a": 1}}, "shown_at": now},
        {"good": False, "bad": True, "features": {"components": {"a": 1}}, "shown_at": now},
        {"good": False, "bad": False, "features": {"components": {"a": 1}}, "shown_at": now},
        {"good": True, "bad": False, "features": {}, "shown_at": now},
    ]
    samples = learned_ranker.samples_from_outcomes(rows)
    assert [(label, weight) for _f, label, _a, weight in samples] == [
        (1, learned_ranker.STRONG_WEIGHT), (1, 1.0), (0, 1.0),
    ]


def test_artist_proximity_ranks_neighbours_of_favorites(monkeypatch):
    import asyncio

    from app import mainstream
    from app.routers import flow

    async def similar(artist):
        return {"anchor": ["Near", "Far"] + [f"x{i}" for i in range(40)]}.get(artist, [])

    monkeypatch.setattr(mainstream, "cached_similar_artists", similar)
    proximity = asyncio.run(flow._artist_proximity(["anchor"], fetch=False, timeout=1.0))
    assert proximity["anchor"] == 1.0
    assert proximity["near"] == 1.0
    assert proximity["far"] < proximity["near"]
    assert "x35" not in proximity  # дальше _PROXIMITY_NEIGHBOURS


def test_delivery_cap_replaces_extra_genre_hits():
    pool = _pool(["g1", "g2", "g3", "a", "b", "c"])
    features = {i: {"origin": "genre" if i < 3 else "radio"} for i in range(6)}
    for arm in ("control", "session"):
        rng = random.Random(0)
        rng.random = lambda: 0.99
        chosen, _extra = _select(
            pool, features, flow_session.SessionState([], {}.get), arm=arm, rng=rng, limit=4,
            capped=lambda item: features[item["id"]]["origin"] == "genre", capped_max=2,
        )
        assert sum(1 for item in chosen if item["artist"].startswith("g")) == 2
        assert len(chosen) == 4


def test_delivery_cap_is_soft_when_nothing_else():
    pool = _pool(["g1", "g2", "g3", "g4"])
    chosen, _extra = _select(
        pool, {}, arm="control", limit=4, capped=lambda item: True, capped_max=1,
    )
    assert len(chosen) == 4


def test_collab_with_a_familiar_member_is_familiar():
    from app.routers.flow import _artist_affinity

    weights = {"gigi d'agostino": 4.0, "journey": 2.0}
    assert _artist_affinity("Dynoro, Gigi D'Agostino", weights) == 4.0
    assert _artist_affinity("Journey feat. Steve Perry", weights) == 2.0
    assert _artist_affinity("Journey", weights) == 2.0
    assert _artist_affinity("Muse", weights) is None


def test_favorite_catalog_prefers_the_artists_hits():
    """Любимый артист отдаёт в основном хиты, глубокие треки — изредка."""
    from types import SimpleNamespace

    from app.routers.flow import _popular_first_shuffle

    pool = [SimpleNamespace(id=i, play_count=1000 - i) for i in range(40)]
    top = deep = 0
    for context in range(300):
        order = _popular_first_shuffle(pool, f"ctx{context}", "s", lambda t: t.id)
        assert sorted(t.id for t in order) == list(range(40))
        top += sum(1 for t in order[:10] if t.id < 10)
        deep += sum(1 for t in order[:10] if t.id >= 20)
    assert top / 3000 > 0.6
    assert 0 < deep / 3000 < 0.15
    # Детерминирован контекстом.
    first = _popular_first_shuffle(pool, "same", "s", lambda t: t.id)
    assert first == _popular_first_shuffle(pool, "same", "s", lambda t: t.id)


def test_delivery_novel_cap_and_same_class_exploration():
    pool = _pool([f"n{i}" for i in range(5)] + [f"f{i}" for i in range(5)])
    features = {i: {"novel": i < 5} for i in range(10)}
    chosen, _extra = _select(pool, features, arm="control", limit=4, novel_max=1)
    assert sum(1 for item in chosen if features[item["id"]]["novel"]) == 1
    rng = random.Random(0)
    rng.random = lambda: 0.0  # каждое место — разведка
    chosen, extra = _select(
        pool, features, flow_session.SessionState([], {}.get), rng=rng, limit=4, novel_max=1
    )
    assert sum(1 for item in chosen if features[item["id"]]["novel"]) == 1
    assert any(row.get("explore") for row in extra.values())


def test_delivery_liked_cap_holds_when_ranker_prefers_likes():
    # Пул на несколько выдач с квотой лайков на весь пул: ранкер тянет лайки
    # вперёд, а в выдачу их проходит не больше liked_max.
    pool = _pool([f"l{i}" for i in range(4)] + [f"f{i}" for i in range(6)])
    features = {i: ({"origin": "liked"} if i < 4 else {"origin": "favorite"}) for i in range(10)}
    for arm in ("control", "session"):
        rng = random.Random(0)
        rng.random = lambda: 0.0  # каждое место — разведка
        chosen, _extra = _select(
            pool, features, flow_session.SessionState([], {}.get),
            arm=arm, rng=rng, limit=6, liked_max=1,
        )
        assert sum(1 for item in chosen if features[item["id"]]["origin"] == "liked") == 1


def test_liked_cap_matches_compute_quota():
    from app.routers.flow import _liked_cap

    assert _liked_cap(6, 0.2) == 1
    assert _liked_cap(30, 0.2) == 6
    assert _liked_cap(6, 1.0) == 0


def test_core_artists_get_most_favorite_catalog_slots():
    from collections import Counter

    from app.routers.flow import _external_plan

    weights = {"core": 300.0, "second": 50.0}
    weights.update({f"tail{i}": 1.5 for i in range(200)})
    profile = {
        "playlist_seeds": [], "seeds": [], "fresh_seeds": [], "artists": [],
        "trusted_artist_keys": [], "liked_artists": [], "playlist_artists": [],
        "catalog_artists": ["Core", "Second", "Pref"] + [f"Tail{i}" for i in range(200)],
        "artist_weight": weights, "deep_catalog_artist_keys": ["pref"],
        "seed_tracks": [], "fresh_seed_tracks": [], "title_tags": [], "genres": [],
        "explicit_genres": [],
    }
    counts = Counter()
    for context in range(30):
        plan = _external_plan(
            profile, f"ctx{context}", limit=6, last_picked={},
            recent_artist_counts=Counter(), now_ts=0.0,
        )
        counts.update(plan["favorite_artists"])
        assert len(plan["favorite_artists"]) == 12
    assert counts["Core"] == counts["Second"] == counts["Pref"] == 30
