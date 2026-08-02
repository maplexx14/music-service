"""Ограничение повторов одного артиста в выдаче.

Кандидаты в рекомендациях/волне обычно сортируются по play_count — из-за
этого несколько самых заигранных артистов вкуса перебивают всех остальных
и раз за разом занимают большую часть выдачи. cap_per_artist сохраняет
порядок (важные/популярные треки остаются впереди), но не даёт одному
артисту занять больше max_per_artist мест.
"""
import random
import re
from typing import Callable, Iterable, List, Optional, Tuple, TypeVar

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


# Разделители коллабораций. Запятая — формат радио YT Music ("A, B"),
# остальное приходит из SoundCloud и локальных тегов ("A & B", "A feat. B").
# Без них "ONOKAMI" и "ONOKAMI & Гущина Анастасия" — два разных артиста, и
# один и тот же исполнитель шёл в выдаче двумя треками ПОДРЯД.
# Компромисс с "&": имя вроде "Simon & Garfunkel" схлопнется до "simon" и
# может слиться с посторонним артистом Simon. Ключ используется ТОЛЬКО для
# разнообразия (кап и разнос), не для весов вкуса, поэтому цена ошибки —
# лишний разнос двух треков, а не искажение профиля.
_COLLAB_SPLIT = re.compile(
    r"\s*,\s*|\s+(?:&|x|vs\.?|feat\.?|ft\.?)\s+", re.IGNORECASE
)


def primary_artist_key(name: str) -> str:
    """Ключ по ПЕРВОМУ артисту строки.

    Радио YT Music отдаёт коллабы как "A, B" — по полной строке это выглядит
    другим артистом, и один и тот же исполнитель проскакивает все ограничения
    на повторы.
    """
    return artist_key(_COLLAB_SPLIT.split((name or "").strip(), 1)[0])


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


def take_capped(
    items: List[T],
    n: int,
    max_per_artist: int = 2,
    artist_of: Callable[[T], str] = lambda t: t.artist,
    used: Optional[dict] = None,
) -> Tuple[List[T], List[T]]:
    """Берёт до n элементов, соблюдая лимит на артиста; возвращает (взятые, остаток).

    Заменяет связку demote_over_cap + срез, которая лимит фактически не держала:
    demote уводил сверх-капные треки в хвост, но следующий же `items[:quota]`
    затягивал их обратно, стоило капнутой части оказаться короче квоты (а она
    короче тем чаще, чем дальше сессия — exclude растёт, локальный пул беднеет).

    `used` — счётчик занятых артистом мест. Он ПЕРЕЖИВАЕТ вызовы и обновляется
    на месте: один бюджет на локальных и внешних кандидатов сразу и на
    несколько последних подгрузок подряд. Отдельный кап на каждый пул и на
    каждую порцию по 15 треков позволял артисту брать по 2 трека бесконечно —
    это и читалось как «один и тот же артист снова и снова».

    Сверх-капные элементы не выбрасываются, а уходят в остаток: на бедном
    каталоге вызывающий доберёт их через take_overflow, иначе порция схлопнется
    до пары треков.
    """
    if used is None:
        used = {}
    picked: List[T] = []
    rest: List[T] = []
    for item in items:
        if len(picked) >= n:
            rest.append(item)
            continue
        key = primary_artist_key(artist_of(item))
        if used.get(key, 0) >= max_per_artist:
            rest.append(item)
            continue
        used[key] = used.get(key, 0) + 1
        picked.append(item)
    return picked, rest


def take_overflow(
    items: List[T],
    n: int,
    artist_of: Callable[[T], str] = lambda t: t.artist,
    used: Optional[dict] = None,
) -> List[T]:
    """Последний резерв: добор СВЕРХ лимита, начиная с наименее занятых артистов.

    Нужен там, где короткая порция хуже повтора (волна на бедном каталоге). В
    отличие от простого среза остатка, выбирает наименее представленных в уже
    набранном — повтор достаётся тому, кто мозолил глаза меньше всех.

    Выбираем ПОШАГОВО, обновляя занятость после каждого элемента. Прежняя
    версия сортировала список один раз и резала срезом — а это значит, что все
    треки наименее занятого артиста попадали в выдачу СПЛОШНЫМ блоком (шесть
    подряд, если их шесть). На бедном каталоге через этот добор проходит почти
    вся порция, поэтому именно он и читался как «один и тот же артист снова и
    снова», несмотря на кап и на разнос в interleave_artists.
    """
    if n <= 0:
        return []
    used = used if used is not None else {}
    pool = list(items)
    picked: List[T] = []
    while pool and len(picked) < n:
        # min по ключу стабилен: внутри равной занятости сохраняется исходный
        # порядок по релевантности.
        index = min(
            range(len(pool)),
            key=lambda i: used.get(primary_artist_key(artist_of(pool[i])), 0),
        )
        item = pool.pop(index)
        key = primary_artist_key(artist_of(item))
        used[key] = used.get(key, 0) + 1
        picked.append(item)
    return picked


def cap_per_artist(
    items: List[T],
    max_per_artist: int = 2,
    artist_of: Callable[[T], str] = lambda t: t.artist,
    used: Optional[dict] = None,
) -> List[T]:
    """Возвращает items в исходном порядке, отбросив те, что превышают лимит
    max_per_artist на артиста (первые max_per_artist по каждому — в приоритете,
    т.к. порядок обычно уже отсортирован по релевантности/популярности).

    used — общий счётчик занятых мест (см. take_capped): позволяет держать один
    лимит на несколько последовательных вызовов вместо отдельного на каждый.
    Обновляется на месте, если передан."""
    counts: dict = used if used is not None else {}
    result: List[T] = []
    for item in items:
        key = primary_artist_key(artist_of(item))
        n = counts.get(key, 0)
        if n >= max_per_artist:
            continue
        counts[key] = n + 1
        result.append(item)
    return result
