"""Разнос артистов в выдаче (см. diversity.py).

Регрессия: раньше interleave_artists смотрел только на непосредственно
предыдущий трек, поэтому выдача скатывалась в A B A B A — «одни и те же
артисты почти подряд». Плюс коллабы "A, B" считались отдельным артистом и
проскакивали лимит.
"""

from app.diversity import (
    cap_per_artist,
    demote_over_cap,
    interleave_artists,
    mmr,
    weighted_order,
)


def _artists(items):
    return [i["artist"] for i in items]


def _items(*artists):
    return [{"artist": a, "title": f"t{i}"} for i, a in enumerate(artists)]


def test_no_ababa_alternation():
    items = _items("A", "A", "A", "B", "B", "B", "C", "C", "C")
    order = _artists(interleave_artists(items, lambda i: i["artist"]))
    # Ни один артист не встречается ближе чем через 3 позиции.
    for i, a in enumerate(order):
        assert a not in order[i + 1 : i + 3], f"{a} повторяется слишком рано: {order}"


def test_continues_across_batches():
    items = _items("A", "B")
    order = _artists(
        interleave_artists(items, lambda i: i["artist"], previous_artists=["a"])
    )
    assert order[0] == "B", "артист с конца прошлой порции пошёл сразу первым"


def test_degrades_when_no_alternative():
    # Один артист — ничего не теряем и не зацикливаемся.
    items = _items("A", "A", "A")
    assert len(interleave_artists(items, lambda i: i["artist"])) == 3


def test_collab_counts_as_primary_artist():
    items = _items("A", "A, B", "A, C")
    assert len(cap_per_artist(items, 2, lambda i: i["artist"])) == 2


def test_weighted_order_rotates_but_favours_weight():
    keys = [f"a{i}" for i in range(20)]
    weights = {k: 1.0 for k in keys}
    weights["a0"] = 50.0  # любимый артист
    orders = {tuple(weighted_order(keys, weights)) for _ in range(20)}
    assert len(orders) > 1, "порядок артистов фиксированный — выдача не ротируется"
    first = [weighted_order(keys, weights)[0] for _ in range(40)]
    assert first.count("a0") > 10, "тяжёлый артист потерял приоритет"
    assert len(set(first)) > 1, "первым всегда один и тот же артист"


def test_mmr_demotes_lookalike():
    # Размер как у реального шортлиста: разрыв в релевантности между соседями
    # мал, поэтому штраф за похожесть решает. Треки 1 и 2 по аудитории — почти
    # то же самое, что трек 0 (разные артисты, одна тусовка).
    items = [{"id": i, "artist": f"a{i}"} for i in range(20)]
    sim = {}
    for a, b in ((0, 1), (0, 2), (1, 2)):
        sim[(a, b)] = sim[(b, a)] = 0.9
    order = [i["id"] for i in mmr(items, sim, id_of=lambda t: t["id"])]
    assert order[0] == 0, "самый релевантный должен остаться первым"
    assert order[1] not in (1, 2), f"похожий на первый пошёл вторым: {order[:4]}"
    assert sorted(order) == list(range(20)), "MMR потерял кандидатов"


def test_mmr_noop_without_similarity():
    items = [{"id": i} for i in range(20)]
    assert [i["id"] for i in mmr(items, {}, id_of=lambda t: t["id"])] == list(range(20))


def test_demote_keeps_everything():
    items = _items("A", "A", "A", "B")
    out = _artists(demote_over_cap(items, 2, lambda i: i["artist"]))
    assert out == ["A", "A", "B", "A"], out
