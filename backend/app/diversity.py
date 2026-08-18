"""Ограничение повторов одного артиста в выдаче.

Кандидаты в рекомендациях/волне обычно сортируются по play_count — из-за
этого несколько самых заигранных артистов вкуса перебивают всех остальных
и раз за разом занимают большую часть выдачи. cap_per_artist сохраняет
порядок (важные/популярные треки остаются впереди), но не даёт одному
артисту занять больше max_per_artist мест.
"""
import random
import re
from collections import Counter
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


def _gap_weight(gap: int, min_gap: int) -> float:
    """Насколько артист «остыл» с прошлого появления: множитель веса 0..1.

    Мягкая версия кулдауна для случая, когда жёсткий невыполним. Квадрат, а не
    линия: разнос в половину нужного должен быть заметно менее вероятен, а не
    вдвое.
    """
    if gap >= min_gap:
        return 1.0
    if gap <= 1:
        return 0.0  # подряд — никогда, пока остаётся хоть один другой артист
    return (gap / min_gap) ** 2


def interleave_artists(
    items,
    artist_getter=lambda item: getattr(item, "artist", None),
    min_gap: int = 3,
    previous_artists=None,
):
    """Разносит треки одного артиста, не превращая выдачу в ротацию.

    Раньше сравнивался только непосредственно предыдущий трек, из-за чего
    выдача легко скатывалась в A B A B A — «одни и те же артисты почти
    подряд». previous_artists (хвост прошлой порции, по порядку) продолжает
    разнос между подгрузками потока.

    Выбор следующего артиста СЛУЧАЙНЫЙ, с весом по числу неотданных треков.
    Детерминированный критерий («берём артиста с наибольшим числом оставшихся»)
    вместе с жёстким кулдауном оставлял ровно одну возможную последовательность:
    артист освобождается точно через min_gap позиций, и тот же критерий выбирает
    его снова в том же порядке. Порция из трёх-четырёх артистов выходила строго
    A B C A B C A B C — «артисты чередуются». Вес по числу оставшихся треков
    сохраняет смысл прежнего критерия: редкие артисты не тратятся в начале,
    иначе хвост выдачи схлопывается в блок самого представленного.

    Кулдаун min_gap жёсткий, ПОКА он оставляет выбор хотя бы из двух артистов.
    На d артистах требование «не ближе d-1» выполнимо единственным способом —
    ротацией, поэтому там, где кулдаун диктует следующего артиста однозначно, он
    становится мягким (_gap_weight): недобравший разнос артист получает
    квадратично меньший вес, но остаётся возможным, и периодичность ломается.
    Два трека одного артиста подряд не идут никогда, пока есть альтернатива.
    """
    remaining = list(items)
    # Ключи считаем один раз: primary_artist_key — регулярка, а выбор идёт по
    # всему остатку на каждой позиции.
    keys = [primary_artist_key(artist_getter(item)) for item in remaining]
    counts = Counter(keys)
    ordered = []
    # artist -> позиция последнего появления. Хвост прошлой порции сидим
    # отрицательными позициями: артист с конца прошлой выдачи ещё «горячий».
    last_pos: dict = {}
    prev = list(previous_artists or [])[-min_gap:]
    for offset, artist in enumerate(prev):
        last_pos[artist] = offset - len(prev)

    while remaining:
        # Внутри артиста порядок не меняем: выше в списке то, что вызывающий
        # счёл релевантнее.
        first_index: dict = {}
        for i, key in enumerate(keys):
            first_index.setdefault(key, i)
        gaps = {key: len(ordered) - last_pos.get(key, -min_gap) for key in counts}

        cooled = [key for key, gap in gaps.items() if gap >= min_gap]
        if len(cooled) >= 2:
            pool, weights = cooled, [counts[key] for key in cooled]
        else:
            # Кулдаун оставил не больше одного варианта — ослабляем его, иначе
            # выбора нет и порядок вырождается в цикл.
            scored = {
                key: counts[key] * _gap_weight(gaps[key], min_gap) for key in counts
            }
            pool = [key for key, weight in scored.items() if weight > 0]
            weights = [scored[key] for key in pool]

        if pool:
            key = random.choices(pool, weights=weights, k=1)[0]
        else:
            # Все «горячие»: остался один артист — берём самого давнего.
            key = max(counts, key=lambda k: (gaps[k], counts[k]))

        index = first_index[key]
        ordered.append(remaining.pop(index))
        keys.pop(index)
        counts[key] -= 1
        if not counts[key]:
            del counts[key]
        last_pos[key] = len(ordered) - 1

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
