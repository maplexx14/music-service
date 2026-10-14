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
"""
from __future__ import annotations

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
ORIGIN_TERM = 1.2
NOVELTY_TERM = 1.0
SCRIPT_TERM = 0.6
LEARNED_TERM = 0.6
# Исходный порядок пула — уже результат ранжирования, поэтому без
# свидетельств сессии он и остаётся: соседние места отличаются на шаг.
_BASE_STEP = 0.08
EXPLORE_RATE = 0.1
MIN_ARTIST_GAP = 4


def pick_arm(rng: Optional[random.Random] = None) -> str:
    rng = rng or random
    return "session" if rng.random() < SESSION_ARM_SHARE else "control"


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
        self.origin_pos = Counter()
        self.origin_neg = Counter()
        self.novel_pos = Counter()
        self.novel_neg = Counter()
        self.script_pos = Counter()
        self.script_neg = Counter()
        self.positive_artists: list[str] = []
        self.pos = 0.0
        self.neg = 0.0
        self.count = 0
        weight = 1.0
        for code, item_id in reversed(list(events)):
            meta = meta_of(item_id) or {}
            artist = meta.get("artist") or ""
            if artist:
                self.artist[artist] += _ARTIST_WEIGHTS[code] * weight
            good = code in ("l", "c", "f")
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
                if artist and artist not in self.positive_artists:
                    self.positive_artists.append(artist)
            else:
                self.neg += weight
            self.count += 1
            weight *= SESSION_DECAY

    @property
    def empty(self) -> bool:
        return self.count == 0

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
) -> tuple[list, dict]:
    """Порция из пула для варианта ``arm``: (items, {identity: доп. признаки}).

    control — первые ``limit`` пула как есть (порядок предрасчёта). session —
    пул переставлен по сессии и ранкеру, разнос артистов жадно, плюс одно
    место разведки с вероятностью ``EXPLORE_RATE`` на позицию.
    """
    extra: dict = {}

    def is_novel(item) -> bool:
        return bool((features.get(identity_of(item)) or {}).get("novel"))

    def is_liked(item) -> bool:
        return (features.get(identity_of(item)) or {}).get("origin") == "liked"

    def is_capped(item) -> bool:
        return capped is not None and bool(capped(item))

    def apply_caps(chosen: list, rest: list) -> list:
        # Квота лайков считается на весь пул (на несколько выдач), а ранкер
        # ставит лайки выше всего — без потолка на выдачу они уходили в первые
        # порции пачкой (прод, 2026-10-14: 2–3 лайка из 6 при квоте 1).
        return _apply_caps(
            chosen, rest,
            [(capped, capped_max), (is_novel, novel_max), (is_liked, liked_max)],
        )

    if arm != "session":
        chosen = apply_caps(list(pool[:limit]), list(pool[limit:]))
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

    if ranked == list(pool):
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
    chosen = apply_caps(chosen, [item for item in ranked if item not in chosen])
    # Разведка: место отдаётся случайному кандидату из невыбранной части пула
    # ТОГО ЖЕ класса (новый артист на нового, знакомый на знакомого, лайк на
    # лайк, хит жанра на хит жанра) — иначе разведка раздувала бы долю новых,
    # лайков или жанра сверх квот.
    explored: dict = {}
    rest = [item for item in ranked if item not in chosen]

    def kind_of(item) -> tuple:
        return is_novel(item), is_liked(item), is_capped(item)

    for position in range(len(chosen)):
        if rng.random() >= EXPLORE_RATE:
            continue
        kind = kind_of(chosen[position])
        same = [item for item in rest if kind_of(item) == kind]
        if not same:
            continue
        pick = same[rng.randrange(len(same))]
        rest.remove(pick)
        explored[identity_of(pick)] = round(EXPLORE_RATE / len(same), 5)
        chosen[position] = pick
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
    "select",
]
