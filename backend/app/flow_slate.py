"""Сборка порции волны из отранжированных кандидатов — все квоты в одном месте.

Раньше правила отбора жили слоями прямо в ``routers.flow._compute_flow``, и
каждое добавлялось после своего инцидента. Здесь они собраны в одну чистую
функцию с явными ограничениями, чтобы их взаимодействие проверялось тестами
(tests/test_flow_slate.py), а не на проде:

* цель новизны ``discovery_target`` (от ползунка): сначала по одному треку на
  нового артиста, пик фоновой сверки (probe) первым; не хватило разных
  артистов — добор вторыми треками тех же;
* квота лайков ``liked_target`` — и пол, и потолок: не больше одного лайка на
  артиста, сначала артисты, которых не было в последних отданных; лайки сверх
  квоты в добор не идут;
* потолок свежего кластера ``fresh_cap`` (артисты, впервые попавшие в
  коллекцию за последнюю неделю) — на лайки и добор вместе; не влезшее идёт в
  самый конец: пустая волна хуже;
* потолок ``capped_max`` на кандидатов ``capped`` (хиты выбранного жанра) —
  на новизну и добор вместе; лишнее уходит в хвост, а не выбрасывается, так
  что у юзера, которому кроме жанра предложить нечего, жанр по-прежнему
  заполняет порцию;
* добор — общим рейтингом.

Порядок прослушивания (разнос артистов) решает не эта функция, а
diversity.interleave_artists / spread_into после неё.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Hashable, List, Optional


@dataclass
class SlateRules:
    limit: int
    discovery_target: int = 0
    liked_target: int = 0
    fresh_cap: int = 0
    capped_max: Optional[int] = None


def compose_slate(
    ranked: list,
    rules: SlateRules,
    *,
    is_novel: Callable[[object], bool],
    is_liked: Callable[[object], bool],
    artist_of: Callable[[object], str],
    recently_played_artist: Callable[[str], bool] = lambda _key: False,
    in_fresh_cluster: Callable[[object], bool] = lambda _item: False,
    is_probe: Optional[Callable[[object], bool]] = None,
    novel_artist_of: Optional[Callable[[object], Hashable]] = None,
    capped: Optional[Callable[[object], bool]] = None,
) -> tuple[List, List]:
    """(выбранные, из них лайки квоты). ``ranked`` — лучшие первыми."""
    novel_artist_of = novel_artist_of or artist_of
    capped_used = 0
    capped_overflow: List = []

    def over_cap(item) -> bool:
        """Кандидат под потолком и места под потолком кончились."""
        if capped is None or rules.capped_max is None or not capped(item):
            return False
        return capped_used >= rules.capped_max

    novel_selection: List = []
    if rules.discovery_target:
        novel_candidates = [item for item in ranked if is_novel(item)]
        if is_probe is not None:
            # Стабильная сортировка: остальные сохраняют порядок рейтинга.
            novel_candidates.sort(key=lambda item: not is_probe(item))
        novel_artists = set()
        for item in novel_candidates:
            key = novel_artist_of(item)
            if key in novel_artists or over_cap(item):
                continue
            novel_artists.add(key)
            novel_selection.append(item)
            if capped is not None and capped(item):
                capped_used += 1
            if len(novel_selection) >= rules.discovery_target:
                break
        if len(novel_selection) < rules.discovery_target:
            taken = {id(item) for item in novel_selection}
            for item in novel_candidates:
                if len(novel_selection) >= rules.discovery_target:
                    break
                if id(item) in taken or over_cap(item):
                    continue
                novel_selection.append(item)
                if capped is not None and capped(item):
                    capped_used += 1

    fresh_used = sum(1 for item in novel_selection if in_fresh_cluster(item))

    liked_selection: List = []
    if rules.liked_target:
        liked_artists: set = set()
        for allow_recent in (False, True):
            for item in ranked:
                if len(liked_selection) >= rules.liked_target:
                    break
                if not is_liked(item):
                    continue
                key = artist_of(item)
                if key in liked_artists:
                    continue
                if not allow_recent and recently_played_artist(key):
                    continue
                if in_fresh_cluster(item):
                    if fresh_used >= rules.fresh_cap:
                        continue
                    fresh_used += 1
                liked_artists.add(key)
                liked_selection.append(item)

    reserved: List = []
    reserved_ids: set = set()
    for item in (*novel_selection, *liked_selection):
        if id(item) not in reserved_ids:
            reserved_ids.add(id(item))
            reserved.append(item)
    filler: List = []
    fresh_overflow: List = []
    for item in ranked:
        if id(item) in reserved_ids or is_liked(item):
            continue
        if over_cap(item):
            capped_overflow.append(item)
            continue
        if capped is not None and capped(item):
            capped_used += 1
        if in_fresh_cluster(item):
            if fresh_used >= rules.fresh_cap:
                fresh_overflow.append(item)
                continue
            fresh_used += 1
        filler.append(item)
    return (reserved + filler + fresh_overflow + capped_overflow)[: rules.limit], liked_selection
