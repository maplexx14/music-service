"""Реакция волны внутри сессии: выбор следующих треков из готового пула.

Порцию (точнее, пул на несколько порций) считает flow-warmer: веер
провайдеров, профиль, ранжирование — секунды. Здесь только дешёвая часть,
которая идёт на каждую выдачу за миллисекунды и без сети: что юзер сделал с
последними треками волны (клиент присылает их в ``sess``), то и двигает
кандидатов пула вверх или вниз прямо сейчас, а не через 8–15 треков, когда
дойдёт очередь до следующей предрасчитанной порции.

Сигналы сессии (коды в ``sess``):

* ``n`` — скип до первого звука. Юзер видел название, артиста и обложку и
  решил, что трек неинтересен: это отказ по метаданным, самый прямой сигнал
  против артиста, а не сбой сети;
* ``s`` — скип после начала звука (<25%);
* ``d`` — дизлайк; ``l`` — лайк; ``c`` — дослушал (>= 80%).

Варианты A/B (``arm``) раздаются на каждую выдачу случайно — внутри одного
юзера, иначе с одним активным слушателем любое сравнение версий во времени
смешивает эффект правки с дрейфом вкуса. ``control`` отдаёт пул в порядке
предрасчёта, ``session`` переставляет его по сессии и обученному ранкеру
(app/learned_ranker.py) и с вероятностью ``EXPLORE_RATE`` отдаёт на место
случайного кандидата пула — с записью вероятности, чтобы ранкер учился не
только на собственных выборах.

В обоих вариантах артист, которого в этой сессии только отвергали, в
следующие порции не идёт (``SessionState.rejected_artists``): прод,
2026-10-20, трек скипнутого в сессии артиста в следующей порции скипали в
64% (control) и 51% (session) против 42% у остальных.

``rescue`` — выход из серии быстрых скипов (клиент просит после трёх подряд):
порция из доказанного (``rescue_order``). На проде после 5+ промахов подряд
следующий трек нравился в 6.5% случаев, и такие серии чаще всего кончались
уходом из волны.
"""
from __future__ import annotations

import math
import random
from collections import Counter
from typing import Callable, Iterable, Optional

from app.artist_utils import artist_key
from app.diversity import primary_artist_key

ARMS = ("control", "session")
# Доля выдач в варианте session. Половина — максимум чувствительности A/B.
SESSION_ARM_SHARE = 0.5
SESSION_CODES = frozenset("nsdlcf")
# Сколько последних сигналов учитываем; вес старших затухает геометрически.
SESSION_MAX_EVENTS = 30
SESSION_DECAY = 0.85
# Вес сигнала против (минус) и за (плюс) артиста трека.
# c — дослушал от 55% (понравился), f — от 80% (очень, как лайк).
_ARTIST_WEIGHTS = {"n": -1.0, "s": -0.8, "d": -2.5, "l": 0.6, "c": 0.4, "f": 0.6}
# Сила поправок в единицах «мест» исходного порядка (см. _BASE_STEP).
ARTIST_TERM = 1.6
NEIGHBOUR_TERM = 0.5
# Соседи Last.fm строятся от артиста с лайком / «очень понравился» или с
# NEIGHBOUR_MIN_POSITIVES хорошими исходами в сессии (см. SessionState).
STRONG_POSITIVE_CODES = frozenset("lf")
NEIGHBOUR_MIN_POSITIVES = 2
ORIGIN_TERM = 1.2
NOVELTY_TERM = 1.0
SCRIPT_TERM = 0.6
LEARNED_TERM = 0.6
# Исходный порядок пула — уже результат ранжирования, поэтому без
# свидетельств сессии он и остаётся: соседние места отличаются на шаг.
_BASE_STEP = 0.08
EXPLORE_RATE = 0.1
MIN_ARTIST_GAP = 4
# Доля запросов выхода из серии, которые получают обычную выдачу (holdout,
# features.rescue = "holdout"): без неё не с чем сравнить порции спасения.
RESCUE_HOLDOUT = 0.2
# Потолок лайков и песен коллекции в порции спасения — выше обычной квоты,
# но не вся порция: сплошные лайки тоже приедаются.
RESCUE_LIKED_SHARE = 0.5


def pick_arm(rng: Optional[random.Random] = None) -> str:
    rng = rng or random
    return "session" if rng.random() < SESSION_ARM_SHARE else "control"


def pick_rescue(rng: Optional[random.Random] = None) -> bool:
    """Отдать ли запросу после серии скипов порцию спасения (иначе holdout)."""
    rng = rng or random
    return rng.random() >= RESCUE_HOLDOUT


def parse_session(raw: str) -> list[tuple[str, str]]:
    """``"n123,cytmusic:abc,s45"`` -> [("n", "123"), ("c", "ytmusic:abc"), ...]."""
    events = []
    for part in (raw or "").split(","):
        part = part.strip()
        if len(part) < 2 or part[0] not in SESSION_CODES:
            continue
        events.append((part[0], part[1:]))
    return events[-SESSION_MAX_EVENTS:]


def _shrunk(pos: float, neg: float, base: float, strength: float = 2.0) -> float:
    """Приём группы относительно приёма сессии, сжатый к нулю на малых числах."""
    rate = (pos + strength * base) / (pos + neg + strength)
    return rate - base


class SessionState:
    """Свёртка сигналов сессии по артистам, источникам, новизне, письменности."""

    def __init__(self, events, meta_of: Callable[[str], Optional[dict]]):
        self.artist = Counter()
        # Без затухания: сколько раз артиста в сессии приняли и отвергли.
        self.artist_pos = Counter()
        self.artist_neg = Counter()
        self.origin_pos = Counter()
        self.origin_neg = Counter()
        self.novel_pos = Counter()
        self.novel_neg = Counter()
        self.script_pos = Counter()
        self.script_neg = Counter()
        self.positive_artists: list[str] = []
        positive_counts = Counter()
        strong_artists = set()
        recent_positive: list[str] = []
        self.pos = 0.0
        self.neg = 0.0
        self.count = 0
        weight = 1.0
        for code, item_id in reversed(list(events)):
            meta = meta_of(item_id) or {}
            artist = meta.get("artist") or ""
            good = code in ("l", "c", "f")
            if artist:
                self.artist[artist] += _ARTIST_WEIGHTS[code] * weight
                (self.artist_pos if good else self.artist_neg)[artist] += 1
            target = (
                (self.origin_pos, self.novel_pos, self.script_pos)
                if good
                else (self.origin_neg, self.novel_neg, self.script_neg)
            )
            if meta.get("origin"):
                target[0][meta["origin"]] += weight
            if meta.get("novel") is not None:
                target[1][bool(meta["novel"])] += weight
            if meta.get("script"):
                target[2][meta["script"]] += weight
            if good:
                self.pos += weight
                if artist:
                    positive_counts[artist] += 1
                    if code in STRONG_POSITIVE_CODES:
                        strong_artists.add(artist)
                    if artist not in recent_positive:
                        recent_positive.append(artist)
            else:
                self.neg += weight
            self.count += 1
            weight *= SESSION_DECAY
        # Сиды соседей — только артисты с уверенным сигналом: лайк, дослушал от
        # 80% или несколько хороших исходов. Одно «дослушал от 55%» разворачивало
        # волну: прод, 2026-10-19, новичок дослушал Foo Fighters на 77% (2 трека
        # в коллекции), и следующая порция ушла в Green Day / Linkin Park /
        # Three Days Grace — их он скипал до звука.
        self.positive_artists = [
            artist
            for artist in recent_positive
            if artist in strong_artists or positive_counts[artist] >= NEIGHBOUR_MIN_POSITIVES
        ]

    @property
    def empty(self) -> bool:
        return self.count == 0

    def rejected_artists(self) -> set:
        """Артисты, которых в этой сессии только отвергали: скип или дизлайк
        и ни одного «понравилось». Лайк или дослушанный трек артиста снимает
        отказ — значит, не понравилась песня, а не он сам."""
        return {artist for artist, n in self.artist_neg.items() if n and not self.artist_pos[artist]}

    def accepted_artists(self) -> set:
        """Артисты, которых в этой сессии принимали не реже, чем отвергали."""
        return {artist for artist, n in self.artist_pos.items() if n >= self.artist_neg[artist]}

    def _base(self) -> float:
        return (self.pos + 1.0) / (self.pos + self.neg + 2.0)

    def terms(self, artist: str, features: dict, neighbours: set) -> dict:
        base = self._base()
        out = {}
        if artist and self.artist.get(artist):
            out["artist"] = ARTIST_TERM * max(-2.0, min(1.0, self.artist[artist]))
        if artist and artist in neighbours:
            out["neighbour"] = NEIGHBOUR_TERM
        origin = features.get("origin")
        if origin and (self.origin_pos[origin] or self.origin_neg[origin]):
            out["origin"] = ORIGIN_TERM * _shrunk(
                self.origin_pos[origin], self.origin_neg[origin], base
            )
        novel = features.get("novel")
        if novel is not None and (self.novel_pos[bool(novel)] or self.novel_neg[bool(novel)]):
            out["novelty"] = NOVELTY_TERM * _shrunk(
                self.novel_pos[bool(novel)], self.novel_neg[bool(novel)], base
            )
        script = features.get("script")
        if script and (self.script_pos[script] or self.script_neg[script]):
            out["script"] = SCRIPT_TERM * _shrunk(
                self.script_pos[script], self.script_neg[script], base
            )
        return {name: round(value, 4) for name, value in out.items() if value}


MAX_ARTIST_RUN = 2
# Потолок треков одного артиста в порции — лишние остаются в пуле. Прод,
# 2026-10-20: пул юзера 51 к концу состоял из каталога выбранного в
# онбординге, но скипаемого артиста (остальное ушло в скипы и баны), мягкий
# _one_per_artist менять было не на что, и порция из 8 вышла с 6 Boston
# (affinity 0.18 при 2.38 у PHARAOH) подряд. Короткая порция лучше: фронт
# раньше попросит следующую, а warmer к тому времени пересчитает пул. Ядро
# вкуса под потолок не попадает — артист с членом affinity в score не ниже
# STRONG_ARTIST_SHARE от лучшего в пуле: узкий вкус из пары любимых не должен
# становиться искусственно коротким. Порог относительный — абсолютные веса у
# новичка и у юзера с годом истории несравнимы.
MAX_ARTIST_PER_PORTION = 2
STRONG_ARTIST_SHARE = 0.5


def limit_artist_runs(
    items: list, artist_of: Callable, previous: Iterable[str] = (), max_run: int = MAX_ARTIST_RUN
) -> list:
    """Не больше ``max_run`` треков одного артиста подряд, считая конец
    прошлой порции (``previous``): третий такой трек меняется местами со
    следующим по порядку другого артиста; других нет — остаётся (мягко).

    Прод, 2026-10-15: песни любимого из коллекции шли парами и тройками
    подряд (Limp Bizkit дважды по два трека в соседних позициях).
    """
    result: list = []
    rest = list(items)
    tail = [a for a in previous if a][-max_run:]
    while rest:
        recent = (tail + [artist_of(item) for item in result])[-max_run:]
        blocked = recent[0] if len(recent) == max_run and len(set(recent)) == 1 and recent[0] else None
        index = 0
        if blocked is not None:
            index = next((i for i, item in enumerate(rest) if artist_of(item) != blocked), 0)
        result.append(rest.pop(index))
    return result


def _greedy_gap(ranked: list, artist_of, limit: int, previous: Iterable[str], min_gap: int) -> list:
    """Первые ``limit`` по порядку, без артиста ближе ``min_gap`` (мягко)."""
    recent = [a for a in previous if a][-(min_gap - 1):] if min_gap > 1 else []
    picked: list = []
    remaining = list(ranked)
    while remaining and len(picked) < limit:
        window = set(recent[-(min_gap - 1):]) if min_gap > 1 else set()
        index = next(
            (i for i, item in enumerate(remaining) if artist_of(item) not in window),
            0,
        )
        item = remaining.pop(index)
        picked.append(item)
        recent.append(artist_of(item))
    return picked


def _one_per_artist(chosen: list, rest: list, artist_of) -> list:
    """Второй трек артиста в порции меняется на первого из ``rest`` с артистом,
    которого в порции ещё нет; заменить нечем — остаётся (мягко).

    Разнос MIN_ARTIST_GAP допускает A _ _ _ A в порции из 8: прод, 2026-10-19,
    Mac DeMarco на 3-м и 7-м месте, TV Girl на 0-м и 5-м из 6.
    """
    seen = set()
    spare = list(rest)
    result = []
    for item in chosen:
        artist = artist_of(item)
        if artist and artist in seen:
            taken = seen | {artist_of(other) for other in chosen}
            replacement = next((other for other in spare if artist_of(other) not in taken), None)
            if replacement is not None:
                spare.remove(replacement)
                item = replacement
                artist = artist_of(item)
        seen.add(artist)
        result.append(item)
    return result


def _cap_artist_count(
    chosen: list, rest: list, artist_of, affinity_of, kind_of, cap: int = MAX_ARTIST_PER_PORTION
) -> list:
    """Не больше ``cap`` треков слабого артиста в порции.

    Лишний меняется на первого из ``rest`` того же класса (``kind_of`` —
    новизна, лайк, жанр: квоты не должны съехать), чей артист в порции ещё
    не упёрся в потолок; заменить нечем — выкидывается, порция короче.
    Артист сильный, если хоть у одного его трека член affinity не ниже
    STRONG_ARTIST_SHARE от лучшего в пуле, — его повтор остаётся, как раньше.
    """
    pool = list(chosen) + list(rest)
    top = max((affinity_of(item) or 0.0 for item in pool), default=0.0)
    strong = {
        artist_of(item)
        for item in pool
        if top > 0 and (affinity_of(item) or 0.0) >= STRONG_ARTIST_SHARE * top
    }

    def fits(item, counts) -> bool:
        artist = artist_of(item)
        return not artist or artist in strong or counts[artist] < cap

    counts = Counter()
    result = []
    for item in chosen:
        if fits(item, counts):
            counts[artist_of(item)] += 1
            result.append(item)
        else:
            result.append(None)
    spare = list(rest)
    for position, item in enumerate(chosen):
        if result[position] is not None:
            continue
        kind = kind_of(item)
        replacement = next(
            (other for other in spare if kind_of(other) == kind and fits(other, counts)), None
        )
        if replacement is None:
            continue
        spare.remove(replacement)
        counts[artist_of(replacement)] += 1
        result[position] = replacement
    return [item for item in result if item is not None]


def _apply_caps(chosen: list, rest: list, caps: list) -> list:
    """Потолки ``caps`` — пары (признак, сколько можно) — разом: лишний
    кандидат заменяется первым из ``rest``, кто не пробивает НИ ОДИН потолок;
    заменить нечем — остаётся (мягко).

    По очереди нельзя: лишний лайк менялся на следующий не-лайк, не глядя на
    новизну, и потолок новых пробивался (прод, 2026-10-14: при потолке 1–2
    новых в порциях 6/8 выходило 3–4, 40% новых в волне при ползунке 0.2).
    Место под потолками сначала получают выбранные — по порядку, — и только
    остаток идёт заменам: иначе замена занимала место, и выбранный ниже
    пробивал потолок уже сам.
    """
    caps = [(test, cap) for test, cap in caps if test is not None and cap is not None]
    if not caps:
        return chosen
    used = [0] * len(caps)

    def fits(item) -> bool:
        return all(used[i] < cap or not test(item) for i, (test, cap) in enumerate(caps))

    def take(item):
        for i, (test, _cap) in enumerate(caps):
            if test(item):
                used[i] += 1
        return item

    result = [take(item) if fits(item) else None for item in chosen]
    spare = list(rest)
    for position, item in enumerate(chosen):
        if result[position] is not None:
            continue
        replacement = next((other for other in spare if fits(other)), None)
        if replacement is None:
            replacement = item
        else:
            spare.remove(replacement)
        result[position] = take(replacement)
    return result


def _without_rejected(pool: list, rejected: set, artist_of, limit: int) -> list:
    """Пул без артистов, отвергнутых в этой сессии.

    Короткая порция лучше повтора (фронт раньше попросит следующую), но не
    почти пустая: если своих не набирается и на половину порции, отвергнутые
    идут в конец, как добор.
    """
    if not rejected:
        return pool
    kept = [item for item in pool if artist_of(item) not in rejected]
    if len(kept) >= max(1, limit // 2):
        return kept
    return kept + [item for item in pool if artist_of(item) in rejected]


def rescue_order(
    pool: list,
    *,
    identity_of: Callable,
    artist_of: Callable[[dict], str],
    features: dict,
    accepted: set,
    hits: set,
) -> list:
    """Порядок пула для выхода из серии скипов: сначала доказанное.

    Ступени: артист, принятый в этой сессии; лайк или песня коллекции; хит
    знакомого артиста (топ-3 Last.fm); знакомый; новый. Внутри ступени —
    порядок пула. На проде у владельца лучше всего принимались лайки и
    недавно дослушанное (good 35–48%), хиты любимых — 26% против 9% у их
    треков не из топ-10.
    """

    def tier(item) -> int:
        row = features.get(identity_of(item)) or {}
        if artist_of(item) in accepted:
            return 0
        if row.get("origin") == "liked" or row.get("in_collection"):
            return 1
        if row.get("novel"):
            return 4
        if identity_of(item) in hits or row.get("hit"):
            return 2
        return 3

    ranked = sorted(enumerate(pool), key=lambda pair: (tier(pair[1]), pair[0]))
    return [item for _index, item in ranked]


def select(
    pool: list,
    *,
    limit: int,
    arm: str,
    identity_of: Callable,
    artist_of: Callable[[dict], str],
    features: dict,
    session: Optional[SessionState] = None,
    learned: Optional[Callable[[dict], Optional[float]]] = None,
    neighbours: Optional[set] = None,
    previous_artists: Iterable[str] = (),
    rng: Optional[random.Random] = None,
    capped: Optional[Callable[[dict], bool]] = None,
    capped_max: Optional[int] = None,
    novel_max: Optional[int] = None,
    liked_max: Optional[int] = None,
    rescue: bool = False,
    hits: Optional[set] = None,
) -> tuple[list, dict]:
    """Порция из пула для варианта ``arm``: (items, {identity: доп. признаки}).

    control — первые ``limit`` пула как есть (порядок предрасчёта). session —
    пул переставлен по сессии и ранкеру, разнос артистов жадно, плюс одно
    место разведки с вероятностью ``EXPLORE_RATE`` на позицию. rescue —
    выход из серии скипов поверх любого варианта (``rescue_order``); hits —
    идентичности хитов пула для него. Отвергнутые в сессии артисты уходят
    из пула во всех вариантах.
    """
    extra: dict = {}

    def is_novel(item) -> bool:
        return bool((features.get(identity_of(item)) or {}).get("novel"))

    def is_liked(item) -> bool:
        # in_collection — ещё и песни любимых из своей коллекции (origin
        # favorite): они под той же квотой, что и лайки.
        row = features.get(identity_of(item)) or {}
        return row.get("origin") == "liked" or bool(row.get("in_collection"))

    def is_capped(item) -> bool:
        return capped is not None and bool(capped(item))

    def kind_of(item) -> tuple:
        return is_novel(item), is_liked(item), is_capped(item)

    def apply_caps(chosen: list, rest: list) -> list:
        # Квота лайков считается на весь пул (на несколько выдач), а ранкер
        # ставит лайки выше всего — без потолка на выдачу они уходили в первые
        # порции пачкой (прод, 2026-10-14: 2–3 лайка из 6 при квоте 1).
        return _apply_caps(
            chosen, rest,
            [(capped, capped_max), (is_novel, novel_max), (is_liked, liked_max)],
        )

    def primary_of(item) -> str:
        return primary_artist_key(artist_of(item))

    def affinity_of(item) -> Optional[float]:
        components = (features.get(identity_of(item)) or {}).get("components") or {}
        value = components.get("affinity")
        return float(value) if isinstance(value, (int, float)) else None

    # Без отвергнутых порядок пула уже не тот, что разносил предрасчёт: разнос
    # артистов (и на стыке с прошлой порцией) нужно делать заново.
    filtered = (
        _without_rejected(pool, session.rejected_artists(), primary_of, limit)
        if session is not None
        else pool
    )
    reordered = len(filtered) != len(pool)
    pool = filtered

    if rescue:
        ranked = rescue_order(
            pool,
            identity_of=identity_of,
            artist_of=primary_of,
            features=features,
            accepted=session.accepted_artists() if session is not None else set(),
            hits=hits or set(),
        )
        chosen = _one_per_artist(list(ranked[:limit]), list(ranked[limit:]), primary_of)
        chosen = _apply_caps(
            chosen,
            [item for item in ranked if item not in chosen],
            [
                (capped, capped_max),
                (is_liked, max(liked_max or 0, math.ceil(limit * RESCUE_LIKED_SHARE))),
            ],
        )
        chosen = _cap_artist_count(
            chosen, [item for item in ranked if item not in chosen], primary_of, affinity_of, kind_of
        )
        for item in chosen:
            extra[identity_of(item)] = {"arm": "rescue", "rescue": "on"}
        return chosen, extra

    if arm != "session":
        chosen = _one_per_artist(list(pool[:limit]), list(pool[limit:]), primary_of)
        chosen = apply_caps(chosen, [item for item in pool if item not in chosen])
        chosen = _cap_artist_count(
            chosen, [item for item in pool if item not in chosen], primary_of, affinity_of, kind_of
        )
        for item in chosen:
            extra[identity_of(item)] = {"arm": arm}
        return chosen, extra

    rng = rng or random.Random()
    neighbours = neighbours or set()
    keyed = []
    learned_scores = {}
    if learned is not None:
        for item in pool:
            value = learned(features.get(identity_of(item)) or {})
            if value is not None:
                learned_scores[identity_of(item)] = value
    mean_learned = (
        sum(learned_scores.values()) / len(learned_scores) if learned_scores else 0.0
    )
    for index, item in enumerate(pool):
        identity = identity_of(item)
        item_features = features.get(identity) or {}
        artist = primary_artist_key(artist_of(item))
        terms = (
            session.terms(artist, item_features, neighbours)
            if session is not None and not session.empty
            else {}
        )
        if identity in learned_scores:
            terms["learned"] = round(
                LEARNED_TERM * max(-3.0, min(3.0, learned_scores[identity] - mean_learned)), 4
            )
        value = -_BASE_STEP * index + sum(terms.values())
        keyed.append((-value, index, item, terms))
    keyed.sort(key=lambda row: (row[0], row[1]))
    ranked = [row[2] for row in keyed]
    terms_of = {identity_of(row[2]): row[3] for row in keyed}

    if ranked == list(pool) and not reordered:
        # Поправок нет — порядок предрасчёта уже разнесён по артистам (и
        # лайки расставлены spread_into), перекладывать его незачем.
        chosen = list(pool[:limit])
    else:
        chosen = _greedy_gap(
            ranked,
            lambda item: primary_artist_key(artist_of(item)),
            limit,
            previous_artists,
            MIN_ARTIST_GAP,
        )
    chosen = _one_per_artist(chosen, [item for item in ranked if item not in chosen], primary_of)
    chosen = apply_caps(chosen, [item for item in ranked if item not in chosen])
    # Разведка: место отдаётся случайному кандидату из невыбранной части пула
    # ТОГО ЖЕ класса (новый артист на нового, знакомый на знакомого, лайк на
    # лайк, хит жанра на хит жанра) — иначе разведка раздувала бы долю новых,
    # лайков или жанра сверх квот.
    explored: dict = {}
    rest = [item for item in ranked if item not in chosen]

    for position in range(len(chosen)):
        if rng.random() >= EXPLORE_RATE:
            continue
        kind = kind_of(chosen[position])
        in_portion = {primary_of(item) for item in chosen}
        same = [
            item for item in rest
            if kind_of(item) == kind and primary_of(item) not in in_portion
        ]
        if not same:
            continue
        pick = same[rng.randrange(len(same))]
        rest.remove(pick)
        explored[identity_of(pick)] = round(EXPLORE_RATE / len(same), 5)
        chosen[position] = pick
    chosen = _cap_artist_count(
        chosen, [item for item in ranked if item not in chosen], primary_of, affinity_of, kind_of
    )
    for item in chosen:
        identity = identity_of(item)
        row = {"arm": arm}
        if terms_of.get(identity):
            row["session"] = terms_of[identity]
        if identity in learned_scores:
            row["learned"] = round(learned_scores[identity], 4)
        if identity in explored:
            row["explore"] = True
            row["propensity"] = round(explored[identity], 5)
        extra[identity] = row
    return chosen, extra


def artist_meta_key(artist: str) -> str:
    return primary_artist_key(artist) or artist_key(artist)


def history_meta(item_id: str, artist: str, features: dict) -> dict:
    """Что помнить об отданном треке для разбора сессии (history["meta"])."""
    row = {"artist": artist_meta_key(artist)}
    for name in ("origin", "novel", "script"):
        if features.get(name) is not None:
            row[name] = features[name]
    return row


def clamp_meta(meta: dict, limit: int = 300) -> dict:
    if len(meta) <= limit:
        return meta
    return dict(list(meta.items())[-limit:])


__all__ = [
    "ARMS",
    "EXPLORE_RATE",
    "SessionState",
    "clamp_meta",
    "history_meta",
    "parse_session",
    "pick_arm",
    "pick_rescue",
    "rescue_order",
    "select",
]
