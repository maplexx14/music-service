"""Ограничение повторов одного артиста в выдаче.

Кандидаты в рекомендациях/волне обычно сортируются по play_count — из-за
этого несколько самых заигранных артистов вкуса перебивают всех остальных
и раз за разом занимают большую часть выдачи. cap_per_artist сохраняет
порядок (важные/популярные треки остаются впереди), но не даёт одному
артисту занять больше max_per_artist мест.
"""
import random
from typing import Callable, Iterable, List, TypeVar

from app.artist_utils import artist_key

T = TypeVar("T")


def weighted_order(
    keys: Iterable[str], weights: dict, default: float = 1.0
) -> List[str]:
    """Случайный порядок артистов с приоритетом по весу вкуса.

    Раньше выдача строилась вокруг ФИКСИРОВАННОГО топа по весу (top-12 в
    flow.py, сортировка по play_count в recommendations.py) — набор артистов не
    менялся от запроса к запросу, и в выдаче крутились одни и те же, хотя в
    библиотеке их сотни. Взвешенная выборка без повторов (Efraimidis-Spirakis:
    ключ u^(1/w)) оставляет любимых чаще впереди, но каждый запрос даёт свой
    набор — остальная библиотека тоже доходит до выдачи.
    """
    return sorted(
        keys,
        key=lambda k: random.random() ** (1.0 / max(weights.get(k, default), 1e-6)),
        reverse=True,
    )


def primary_artist_key(name: str) -> str:
    """Ключ по ПЕРВОМУ артисту строки.

    Радио YT Music отдаёт коллабы как "A, B" — по полной строке это выглядит
    другим артистом, и один и тот же исполнитель проскакивает все ограничения
    на повторы.
    """
    return artist_key((name or "").split(",")[0])


def interleave_artists(
    items,
    artist_getter=lambda item: getattr(item, "artist", None),
    min_gap: int = 3,
    previous_artists=None,
):
    """Разносит треки одного артиста минимум на min_gap позиций.

    Раньше сравнивался только непосредственно предыдущий трек, из-за чего
    выдача легко скатывалась в A B A B A — «одни и те же артисты почти
    подряд». previous_artists (хвост прошлой порции, по порядку) продолжает
    разнос между подгрузками потока.
    """
    remaining = list(items)
    ordered = []
    # artist -> позиция последнего появления. Хвост прошлой порции сидим
    # отрицательными позициями: артист с конца прошлой выдачи ещё «горячий».
    last_pos: dict = {}
    prev = list(previous_artists or [])[-min_gap:]
    for offset, artist in enumerate(prev):
        last_pos[artist] = offset - len(prev)

    while remaining:
        fallback = None  # (gap, index) — самый «давний» артист, если все близко
        index = 0
        for i, item in enumerate(remaining):
            artist = primary_artist_key(artist_getter(item))
            gap = len(ordered) - last_pos.get(artist, -min_gap)
            if gap >= min_gap:
                index = i
                break
            if fallback is None or gap > fallback[0]:
                fallback = (gap, i)
        else:
            index = fallback[1]

        item = remaining.pop(index)
        ordered.append(item)
        last_pos[primary_artist_key(artist_getter(item))] = len(ordered) - 1

    return ordered


def mmr(
    items: List[T],
    pair_scores: dict,
    id_of: Callable[[T], int] = lambda t: t.id,
    lambda_: float = 0.75,
) -> List[T]:
    """Maximal Marginal Relevance: жадный отбор с штрафом за похожесть.

    cap_per_artist — это MMR с бинарной похожестью «тот же артист или нет». Он
    не видит случай, когда артисты формально разные, но все из одной тусовки и
    звучат одинаково: выдача выглядит разнообразной, а на слух одно и то же.
    Здесь похожесть берётся из co-occurrence (cooccurrence.pair_scores) — то
    есть по общей аудитории, а не по имени.

    Релевантность — позиция во ВХОДНОМ порядке (вызывающий уже отсортировал по
    вкусу), поэтому список должен приходить упорядоченным. lambda_ — ручка
    «релевантность против разнообразия»: 1.0 сохраняет входной порядок.
    """
    if len(items) < 3 or not pair_scores:
        return list(items)

    n = len(items)
    rel = {id(t): 1.0 - i / n for i, t in enumerate(items)}
    remaining = list(items)
    ordered: List[T] = [remaining.pop(0)]  # самый релевантный — всегда первый
    picked_ids = [id_of(ordered[0])]

    while remaining:
        best, best_score = 0, None
        for i, item in enumerate(remaining):
            tid = id_of(item)
            sim = max((pair_scores.get((tid, p), 0.0) for p in picked_ids), default=0.0)
            score = lambda_ * rel[id(item)] - (1.0 - lambda_) * sim
            if best_score is None or score > best_score:
                best, best_score = i, score
        item = remaining.pop(best)
        ordered.append(item)
        picked_ids.append(id_of(item))

    return ordered


def demote_over_cap(
    items: List[T],
    max_per_artist: int = 2,
    artist_of: Callable[[T], str] = lambda t: t.artist,
) -> List[T]:
    """cap_per_artist, но «лишние» треки не выбрасываются, а уезжают в хвост.

    Нужно там, где список одновременно и пул для отбора, и резерв для добора:
    жёсткое отсечение при бедном локальном каталоге вернуло бы порцию из
    двух треков.
    """
    keep = cap_per_artist(items, max_per_artist, artist_of)
    kept = {id(x) for x in keep}
    return keep + [x for x in items if id(x) not in kept]


def cap_per_artist(
    items: List[T],
    max_per_artist: int = 2,
    artist_of: Callable[[T], str] = lambda t: t.artist,
) -> List[T]:
    """Возвращает items в исходном порядке, отбросив те, что превышают лимит
    max_per_artist на артиста (первые max_per_artist по каждому — в приоритете,
    т.к. порядок обычно уже отсортирован по релевантности/популярности)."""
    counts: dict = {}
    result: List[T] = []
    for item in items:
        key = primary_artist_key(artist_of(item))
        n = counts.get(key, 0)
        if n >= max_per_artist:
            continue
        counts[key] = n + 1
        result.append(item)
    return result
