"""Свойства сборки порции (app/flow_slate.py) на случайных пулах."""
import random
from collections import Counter

import pytest

from app.flow_slate import SlateRules, compose_slate


def _pool(rng, size):
    return [
        {
            "id": index,
            "artist": f"a{rng.randrange(8)}",
            "novel": rng.random() < 0.4,
            "liked": rng.random() < 0.25,
            "fresh": rng.random() < 0.3,
            "probe": rng.random() < 0.05,
        }
        for index in range(size)
    ]


def _compose(pool, rules, recent=()):
    return compose_slate(
        pool,
        rules,
        is_novel=lambda item: item["novel"] and not item["liked"],
        is_liked=lambda item: item["liked"],
        artist_of=lambda item: item["artist"],
        recently_played_artist=lambda key: key in recent,
        in_fresh_cluster=lambda item: item["fresh"],
        is_probe=lambda item: item["probe"],
    )


@pytest.mark.parametrize("seed", range(60))
def test_slate_invariants(seed):
    rng = random.Random(seed)
    pool = _pool(rng, rng.randrange(0, 60))
    limit = rng.randrange(5, 20)
    discovery_target = rng.randrange(0, limit + 1)
    rules = SlateRules(
        limit=limit,
        discovery_target=discovery_target,
        # Как в _compute_flow: квота лайков зажата целью новизны.
        liked_target=min(rng.randrange(0, limit // 2 + 1), limit - discovery_target),
        fresh_cap=rng.randrange(1, limit + 1),
    )
    recent = {f"a{i}" for i in range(rng.randrange(0, 4))}
    chosen, liked = _compose(pool, rules, recent)

    ids = [item["id"] for item in chosen]
    assert len(ids) == len(set(ids)), "трек дважды"
    assert len(chosen) <= limit
    # Пустая порция хуже нарушения квот: берём всё, что можно взять.
    non_liked = sum(1 for item in pool if not item["liked"])
    assert len(chosen) == min(limit, non_liked + len(liked))
    # Лайки — только своей квотой, не больше одного на артиста.
    assert [item for item in chosen if item["liked"]] == liked
    assert len(liked) <= rules.liked_target
    assert max(Counter(item["artist"] for item in liked).values(), default=0) <= 1
    # Цель новизны выполнена, насколько хватает новых кандидатов.
    novel_available = sum(1 for item in pool if item["novel"] and not item["liked"])
    novel_chosen = sum(1 for item in chosen if item["novel"] and not item["liked"])
    assert novel_chosen >= min(rules.discovery_target, novel_available, limit)


def test_probe_goes_first_among_new_artists():
    pool = [
        {"id": 0, "artist": "x", "novel": True, "liked": False, "fresh": False, "probe": False},
        {"id": 1, "artist": "y", "novel": True, "liked": False, "fresh": False, "probe": True},
    ]
    chosen, _liked = _compose(pool, SlateRules(limit=5, discovery_target=1))
    assert chosen[0]["id"] == 1


def test_liked_prefers_artists_not_heard_recently():
    pool = [
        {"id": 0, "artist": "old", "novel": False, "liked": True, "fresh": False, "probe": False},
        {"id": 1, "artist": "new", "novel": False, "liked": True, "fresh": False, "probe": False},
    ]
    _chosen, liked = _compose(pool, SlateRules(limit=5, liked_target=1), recent={"old"})
    assert [item["id"] for item in liked] == [1]


def test_fresh_cluster_over_the_cap_goes_to_the_tail():
    pool = [
        {"id": i, "artist": f"f{i}", "novel": False, "liked": False, "fresh": True, "probe": False}
        for i in range(3)
    ] + [
        {"id": 10 + i, "artist": f"o{i}", "novel": False, "liked": False, "fresh": False, "probe": False}
        for i in range(3)
    ]
    chosen, _liked = _compose(pool, SlateRules(limit=6, fresh_cap=1))
    assert [item["id"] for item in chosen] == [0, 10, 11, 12, 1, 2]


def _genre_item(i, genre):
    return {"id": i, "artist": f"g{i}" if genre else f"o{i}", "novel": True,
            "liked": False, "fresh": False, "probe": False, "genre": genre}


def _compose_capped(pool, rules):
    return compose_slate(
        pool,
        rules,
        is_novel=lambda item: item["novel"],
        is_liked=lambda item: False,
        artist_of=lambda item: item["artist"],
        capped=lambda item: item["genre"],
    )


def test_genre_cap_moves_extra_genre_hits_to_the_tail():
    pool = [_genre_item(i, True) for i in range(4)] + [_genre_item(10 + i, False) for i in range(4)]
    chosen, _liked = _compose_capped(pool, SlateRules(limit=6, discovery_target=3, capped_max=2))
    ids = [item["id"] for item in chosen]
    assert sum(1 for item in chosen if item["genre"]) == 2
    assert ids[:2] == [0, 1]


def test_genre_only_user_still_gets_a_full_portion():
    """Кроме жанра предложить нечего — потолок мягкий, порция полная."""
    pool = [_genre_item(i, True) for i in range(8)]
    chosen, _liked = _compose_capped(pool, SlateRules(limit=6, discovery_target=3, capped_max=2))
    assert len(chosen) == 6
