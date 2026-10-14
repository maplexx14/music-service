"""Как юзер на деле принимает новых артистов в волне.

Ползунок ``User.discovery_ratio`` — это просьба, а не факт. Телеметрия волны
показала, что при ползунке 0.55 новые артисты занимали ~43% порции и
дослушивались в 3 раза реже знакомых. Здесь считается отношение долей
«хороших» исходов (дослушал до ``GOOD_COMPLETION`` или лайкнул) у новых и
знакомых артистов за последние ``WINDOW_DAYS``; ``effective_discovery_ratio``
сжимает им запрошенную новизну.

Новизна берётся из ``recommendation_impressions.features["novel"]`` — так её
видел ранкер в момент отдачи. У строк до появления features её восстанавливаем
по истории: был ли у юзера положительный сигнал по артисту раньше показа.

Оценка сглажена к общей доле хороших исходов с весом ``PRIOR_WEIGHT``: пока
исходов мало, фактор близок к 1 и ползунок работает как раньше.
"""
from __future__ import annotations

import logging
import math
import random
from bisect import bisect_left
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.cache import get_cache, set_cache
from app.feedback_labels import FEEDBACK_EVENT_TYPES, GOOD_COMPLETION, OutcomeTracker
from app.models import (
    Playlist,
    Track,
    playlist_tracks,
    recommendation_events,
    recommendation_impressions,
    user_play_events,
)

logger = logging.getLogger(__name__)

WINDOW_DAYS = 30
PRIOR_WEIGHT = 50.0
MIN_FACTOR = 0.2
# Меньше знакомых артистов — фактор не применяется. У тонкого профиля
# «знакомые» — это горстка имён, выбранных самим юзером, и сравнение с ними
# нечестно: новинки подобраны плохо просто потому, что угадывать не из чего.
# Сжатие новизны здесь закрыло бы юзеру ровно тот путь, которым профиль растёт.
MIN_FAMILIAR_ARTISTS = 10
_CACHE_KEY = "discovery:acceptance:v1:{}"
_CACHE_TTL = 3600
# Априор источника кандидата (features.origin) по фактическому приёму. На проде
# (2026-10-01, 14 дней) источники расходились в 20 раз: liked 12.5% «хорошо»,
# local 0.6% при 84% «плохо», а ручной скор этого не видел — у local высокий
# affinity знакомого артиста. Доля сглажена к общей с весом ORIGIN_PRIOR_WEIGHT.
ORIGIN_PRIOR_WEIGHT = 30.0
ORIGIN_MIN_OUTCOMES = 100
ORIGIN_TERM_WEIGHT = 0.6
# Поправка — логарифм отношения к общей доле, зажатый в коридор. Вверх зажим
# узкий: лучший источник (лайки) и так держит квота, а широкий бонус вернул бы
# волну к повтору коллекции.
ORIGIN_LOG_RATIO_RANGE = (-1.5, 0.5)
_ORIGIN_CACHE_KEY = "discovery:origins:v1:{}"


def _utc(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _identity(track_id, source, external_id) -> Optional[str]:
    if track_id is not None:
        return f"local:{track_id}"
    if source and external_id:
        return f"{source}:{external_id}"
    return None


def _artist(value) -> str:
    return str(value or "").strip().lower()


def delivery_outcomes(
    db: Session,
    user_id: int,
    *,
    since: datetime,
    surface: str = "flow",
) -> list[dict]:
    """Отданные позиции с исходом: новизна артиста, хорошо/плохо, features.

    Исход размечает ``app.feedback_labels``. Позиции без единого события
    (не дошёл до них) не возвращаются.
    """
    since = _utc(since)
    deliveries = db.execute(
        select(
            recommendation_impressions.c.request_id,
            recommendation_impressions.c.track_id,
            recommendation_impressions.c.source,
            recommendation_impressions.c.external_id,
            recommendation_impressions.c.artist,
            recommendation_impressions.c.title,
            recommendation_impressions.c.shown_at,
            recommendation_impressions.c.features,
            recommendation_impressions.c.score,
            recommendation_impressions.c.position,
            recommendation_impressions.c.algorithm_version,
        ).where(
            recommendation_impressions.c.user_id == user_id,
            recommendation_impressions.c.surface == surface,
            recommendation_impressions.c.shown_at >= since,
            recommendation_impressions.c.request_id.isnot(None),
        )
    ).all()
    if not deliveries:
        return []

    outcomes: dict[tuple[str, str], OutcomeTracker] = {}
    for request_id, track_id, source, external_id, event_type, value in db.execute(
        select(
            recommendation_events.c.request_id,
            recommendation_events.c.track_id,
            recommendation_events.c.source,
            recommendation_events.c.external_id,
            recommendation_events.c.event_type,
            recommendation_events.c.value,
        ).where(
            recommendation_events.c.user_id == user_id,
            recommendation_events.c.surface == surface,
            recommendation_events.c.occurred_at >= since,
            recommendation_events.c.request_id.isnot(None),
            recommendation_events.c.event_type.in_(FEEDBACK_EVENT_TYPES),
        ).order_by(recommendation_events.c.occurred_at, recommendation_events.c.id)
    ).all():
        ident = _identity(track_id, source, external_id)
        if ident is None:
            continue
        outcomes.setdefault((request_id, ident), OutcomeTracker()).add(event_type, value)
    # Внешний трек мог материализоваться между отдачей и событием: тогда в
    # событии уже track_id, а в строке показа — provider id. Сопоставляем по обоим.
    external_to_local = {}
    pairs = {(s, e) for _r, t, s, e, *_x in deliveries if t is None and s and e}
    if pairs:
        for local_id, source, external_id in db.execute(
            select(Track.id, Track.source, Track.external_id).where(
                Track.external_id.in_({e for _s, e in pairs})
            )
        ).all():
            if (source, external_id) in pairs:
                external_to_local[(source, external_id)] = local_id

    history = _positive_history(db, user_id)
    rows = []
    for (
        request_id, track_id, source, external_id, artist, title, shown_at, features,
        score, position, algorithm_version,
    ) in deliveries:
        state = outcomes.get((request_id, _identity(track_id, source, external_id)))
        if state is None and track_id is None:
            local_id = external_to_local.get((source, external_id))
            if local_id is not None:
                state = outcomes.get((request_id, f"local:{local_id}"))
        if state is None:
            continue
        features = features if isinstance(features, dict) else {}
        novel = features.get("novel")
        if novel is None:
            stamps = history.get(_artist(artist)) or []
            novel = bisect_left(stamps, _utc(shown_at)) == 0
        rows.append(
            {
                "novel": bool(novel),
                "good": state.good,
                "strong": state.strong,
                "bad": state.bad,
                "completion": state.completion,
                "score": score,
                "position": position,
                "algorithm_version": algorithm_version,
                "features": features,
                "artist": artist,
                "title": title,
                "shown_at": _utc(shown_at),
            }
        )
    return rows


def acceptance_counts(db: Session, user_id: int, now: Optional[datetime] = None) -> dict:
    """Исходы отданных в волне треков: новые против знакомых артистов."""
    now = _utc(now) or datetime.now(timezone.utc)
    counts = {"novel_good": 0, "novel_n": 0, "familiar_good": 0, "familiar_n": 0}
    for row in delivery_outcomes(db, user_id, since=now - timedelta(days=WINDOW_DAYS)):
        bucket = "novel" if row["novel"] else "familiar"
        counts[f"{bucket}_n"] += 1
        counts[f"{bucket}_good"] += int(row["good"])
    return counts


def _positive_history(db: Session, user_id: int) -> dict[str, list[datetime]]:
    """Когда у юзера появлялся положительный сигнал по артисту (по возрастанию)."""
    rows = db.execute(
        select(Track.artist, playlist_tracks.c.added_at)
        .select_from(
            playlist_tracks.join(Playlist, Playlist.id == playlist_tracks.c.playlist_id)
            .join(Track, Track.id == playlist_tracks.c.track_id)
        )
        .where(Playlist.owner_id == user_id)
    ).all()
    rows += db.execute(
        select(Track.artist, user_play_events.c.played_at)
        .select_from(user_play_events.join(Track, Track.id == user_play_events.c.track_id))
        .where(
            user_play_events.c.user_id == user_id,
            user_play_events.c.completion >= GOOD_COMPLETION,
        )
    ).all()
    history: dict[str, list[datetime]] = {}
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    for artist, ts in rows:
        history.setdefault(_artist(artist), []).append(_utc(ts) or epoch)
    for stamps in history.values():
        stamps.sort()
    return history


def acceptance_factor(counts: dict) -> float:
    """Во сколько раз новые артисты принимаются хуже знакомых, в [MIN_FACTOR, 1]."""
    novel_n = counts.get("novel_n", 0)
    familiar_n = counts.get("familiar_n", 0)
    total = novel_n + familiar_n
    if not total:
        return 1.0
    pooled = (counts.get("novel_good", 0) + counts.get("familiar_good", 0)) / total
    if pooled <= 0:
        return 1.0
    novel_rate = (counts.get("novel_good", 0) + PRIOR_WEIGHT * pooled) / (novel_n + PRIOR_WEIGHT)
    familiar_rate = (counts.get("familiar_good", 0) + PRIOR_WEIGHT * pooled) / (
        familiar_n + PRIOR_WEIGHT
    )
    return max(MIN_FACTOR, min(1.0, novel_rate / familiar_rate))


def cached_acceptance_factor(db: Session, user_id: int) -> float:
    """``acceptance_factor`` с часовым кэшем: история меняется медленно."""
    key = _CACHE_KEY.format(user_id)
    cached = get_cache(key)
    if isinstance(cached, (int, float)):
        return float(cached)
    try:
        factor = acceptance_factor(acceptance_counts(db, user_id))
    except Exception:  # noqa: BLE001 — телеметрия не должна ронять выдачу
        # Упавший запрос оставляет транзакцию Postgres в aborted-состоянии, а
        # сессией дальше пользуется вызывающий код.
        db.rollback()
        logger.exception("discovery acceptance failed user=%s", user_id)
        return 1.0
    set_cache(key, factor, expire=_CACHE_TTL)
    return factor


def origin_counts(db: Session, user_id: int, now: Optional[datetime] = None) -> dict:
    """Исходы по источникам кандидатов: {origin: [good, n]} за ``WINDOW_DAYS``."""
    now = _utc(now) or datetime.now(timezone.utc)
    counts: dict[str, list[int]] = {}
    for row in delivery_outcomes(db, user_id, since=now - timedelta(days=WINDOW_DAYS)):
        origin = row["features"].get("origin")
        if not origin or origin == "unknown":
            continue
        bucket = counts.setdefault(origin, [0, 0])
        bucket[0] += int(row["good"])
        bucket[1] += 1
    return counts


def cached_origin_counts(db: Session, user_id: int) -> dict:
    """``origin_counts`` с часовым кэшем; при ошибке — пусто (поправки нет)."""
    key = _ORIGIN_CACHE_KEY.format(user_id)
    cached = get_cache(key)
    if isinstance(cached, dict):
        return cached
    try:
        counts = origin_counts(db, user_id)
    except Exception:  # noqa: BLE001 — телеметрия не должна ронять выдачу
        db.rollback()
        logger.exception("origin acceptance failed user=%s", user_id)
        return {}
    set_cache(key, counts, expire=_CACHE_TTL)
    return counts


def origin_terms(counts: dict, seed: str) -> dict[str, float]:
    """Поправка скора на источник, сэмплом Томпсона: {origin: term}.

    Доля «хорошо» источника берётся сэмплом из Beta-апостериора, а не точкой:
    источник с малым числом исходов получает разброс в обе стороны и шанс
    проявиться, хорошо изученный — почти постоянную поправку. ``seed`` делает
    сэмпл стабильным внутри одного запроса. Пока исходов меньше
    ``ORIGIN_MIN_OUTCOMES``, поправок нет — источник ``"*"`` (не встречавшийся)
    тоже получает 0.
    """
    total = sum(n for _good, n in counts.values())
    if total < ORIGIN_MIN_OUTCOMES:
        return {}
    pooled = sum(good for good, _n in counts.values()) / total
    if pooled <= 0:
        return {}
    rng = random.Random(seed)
    low, high = ORIGIN_LOG_RATIO_RANGE
    terms = {}
    for origin, (good, n) in sorted(counts.items()):
        alpha = good + ORIGIN_PRIOR_WEIGHT * pooled
        beta = (n - good) + ORIGIN_PRIOR_WEIGHT * (1.0 - pooled)
        sample = max(rng.betavariate(alpha, beta), 1e-6)
        ratio = math.log(sample / pooled)
        terms[origin] = ORIGIN_TERM_WEIGHT * max(low, min(high, ratio))
    return terms


def discovery_acceptance(db: Session, user_id: int, familiar_artist_count: int) -> float:
    """Фактор приёма новизны с защитой тонкого профиля (см. MIN_FAMILIAR_ARTISTS)."""
    if familiar_artist_count < MIN_FAMILIAR_ARTISTS:
        return 1.0
    return cached_acceptance_factor(db, user_id)


# --- Источники кандидатов и язык: исходы и сэмплирование Томпсона ---
#
# Поправка origin_terms двигала score, а отбор порции всё равно шёл общим
# рейтингом: источник local (каталог сервера) на проде за 14 дней (2026-10-13)
# давал 19% волны при 1.4–4.6% «хорошо» и 80–86% «плохо», similar_hits — 0.8%
# и 0% у не-владельцев, artist_graph — 0–2.5%, тогда как favorite у остальных
# 17.6%, liked у владельца 6.2% при 41% «плохо». К тому же поправка включалась
# от 100 исходов юзера — у новых юзеров её не было вовсе. Теперь каждое место
# порции достаётся источнику сэмплом из Beta-апостериора его «награды» у этого
# юзера с априором по всем юзерам (thompson_source_order).
#
# Награда исхода: 1 — лайк или дослушивание до 80% (очень понравился), 0.8 —
# от 55% (понравился), 0 — скип/дизлайк/уход раньше 25% (плохо), 0.5 — между. Одних «хорошо» мало (5% исходов) — у нового
# юзера по ним источники неразличимы неделями; «плохо» — главный сигнал волны.
NEUTRAL_REWARD = 0.5
GOOD_REWARD = 0.8
_OUTCOME_CACHE_KEY = "discovery:outcomes:v1:{}"
_POPULATION_CACHE_KEY = "discovery:outcomes:population:v1"
# Сколько юзеров (последних по показам) складывать в популяционный априор и
# скольким из них за одну сборку разрешено считать исходы заново (без кэша).
POPULATION_USERS = 200
POPULATION_FRESH_COMPUTE = 20
# Вес априора в псевдо-исходах: у юзера с 20 исходами источника его данные и
# популяция весят поровну.
SOURCE_PRIOR_WEIGHT = 20.0
# Потолок уверенности апостериора (alpha + beta). Без него у юзера с тысячей
# исходов сэмплы почти не разбросаны, и Томпсон отдавал места одному лучшему
# источнику до упора (симуляция на цифрах прода: 52% порции из 8 треков
# lastfm_similar, favorite и local по 2%). С потолком источники смешиваются
# примерно по качеству, а оценка быстрее следует за изменениями алгоритма.
SOURCE_EVIDENCE_CAP = 30.0
# Без стольких исходов в популяции сэмплирование не включается: равные
# апостериоры перемешали бы источники случайно, а это хуже рейтинга.
SOURCE_MIN_POPULATION = 200
# Один источник — не больше этой доли порции; и с этой вероятностью место
# достаётся случайному источнику: иначе слабый источник не получал бы показов
# и не смог бы показать, что исправился.
MAX_SOURCE_SHARE = 0.6
SOURCE_EXPLORE = 0.1
# Язык: априор из коллекции юзера, апостериор — по его исходам. Данные прода
# (2026-10-13) разницы не показали ни у кого с историей (владелец: кириллица
# 4.7% «хорошо», латиница 4.1%), поэтому поправка только понижающая и сходит к
# нулю, когда исходы её не подтверждают; заметна она у нового юзера с явно
# одноязычной коллекцией.
LANGUAGE_PRIOR_WEIGHT = 30.0
LANGUAGE_TERM_WEIGHT = 0.6
LANGUAGE_LOG_RATIO_FLOOR = -1.0
LANGUAGE_MIN_TEXTS = 10
# Априорный множитель приёма для письменности с долей share в коллекции:
# share/0.5, зажатый в [LANGUAGE_PRIOR_FLOOR, 1]. Смешанная коллекция — 1.
LANGUAGE_PRIOR_FLOOR = 0.4


def outcome_reward(row: dict) -> float:
    if row.get("good"):
        return 1.0 if row.get("strong", True) else GOOD_REWARD
    if row.get("bad"):
        return 0.0
    return NEUTRAL_REWARD


def outcome_stats(db: Session, user_id: int, now: Optional[datetime] = None) -> dict:
    """Исходы волны за ``WINDOW_DAYS`` по источнику и письменности:
    {"origin": {origin: [good, n, reward]}, "script": {"cyr"|"lat": [...]}}."""
    from app.lang import script_of

    now = _utc(now) or datetime.now(timezone.utc)
    stats: dict = {"origin": {}, "script": {}}
    for row in delivery_outcomes(db, user_id, since=now - timedelta(days=WINDOW_DAYS)):
        reward = outcome_reward(row)
        keys = (
            ("origin", row["features"].get("origin")),
            ("script", script_of(row.get("artist") or "", row.get("title") or "")),
        )
        for group, key in keys:
            if not key or key == "unknown":
                continue
            bucket = stats[group].setdefault(key, [0, 0, 0.0])
            bucket[0] += int(row["good"])
            bucket[1] += 1
            bucket[2] += reward
    return stats


def cached_outcome_stats(db: Session, user_id: int) -> dict:
    """``outcome_stats`` с часовым кэшем; при ошибке — пусто."""
    key = _OUTCOME_CACHE_KEY.format(user_id)
    cached = get_cache(key)
    if isinstance(cached, dict):
        return cached
    try:
        stats = outcome_stats(db, user_id)
    except Exception:  # noqa: BLE001 — телеметрия не должна ронять выдачу
        db.rollback()
        logger.exception("outcome stats failed user=%s", user_id)
        return {"origin": {}, "script": {}}
    set_cache(key, stats, expire=_CACHE_TTL)
    return stats


def cached_population_stats(db: Session, build: bool = True) -> dict:
    """Сумма ``outcome_stats`` последних по показам юзеров волны — априор.

    Сборка без кэша — секунды (исходы каждого юзера), поэтому живой запрос
    волны зовёт с build=False и без кэша обходится без априора, а собирает его
    flow-warmer."""
    cached = get_cache(_POPULATION_CACHE_KEY)
    if isinstance(cached, dict):
        return cached
    total: dict = {"origin": {}, "script": {}}
    if not build:
        return total
    try:
        since = datetime.now(timezone.utc) - timedelta(days=WINDOW_DAYS)
        user_ids = db.execute(
            select(recommendation_impressions.c.user_id)
            .where(
                recommendation_impressions.c.surface == "flow",
                recommendation_impressions.c.shown_at >= since,
            )
            .group_by(recommendation_impressions.c.user_id)
            .order_by(func.max(recommendation_impressions.c.shown_at).desc())
            .limit(POPULATION_USERS)
        ).scalars().all()
        fresh = 0
        for user_id in user_ids:
            stats = get_cache(_OUTCOME_CACHE_KEY.format(user_id))
            if not isinstance(stats, dict):
                if fresh >= POPULATION_FRESH_COMPUTE:
                    continue
                fresh += 1
                stats = cached_outcome_stats(db, user_id)
            for group in ("origin", "script"):
                for key, (good, n, reward) in (stats.get(group) or {}).items():
                    bucket = total[group].setdefault(key, [0, 0, 0.0])
                    bucket[0] += good
                    bucket[1] += n
                    bucket[2] += reward
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.exception("population outcome stats failed")
        return total
    set_cache(_POPULATION_CACHE_KEY, total, expire=_CACHE_TTL)
    return total


def source_posteriors(user: dict, population: dict) -> dict[str, tuple[float, float]]:
    """Beta(alpha, beta) награды каждого источника: исходы юзера поверх
    популяционной доли с весом SOURCE_PRIOR_WEIGHT. Пусто — популяция мала."""
    population_n = sum(n for _good, n, _reward in population.values())
    if population_n < SOURCE_MIN_POPULATION:
        return {}
    pooled = sum(reward for _good, _n, reward in population.values()) / population_n
    if not 0.0 < pooled < 1.0:  # вырожденная награда — Beta с нулевым параметром
        return {}
    posteriors = {"*": (SOURCE_PRIOR_WEIGHT * pooled, SOURCE_PRIOR_WEIGHT * (1.0 - pooled))}
    for origin in set(population) | set(user):
        _pg, pop_n, pop_reward = population.get(origin, (0, 0, 0.0))
        # Доля источника в популяции — сама сглаженная к общей, чтобы источник
        # с парой показов не получал априор 0 или 1.
        rate = (pop_reward + SOURCE_PRIOR_WEIGHT * pooled) / (pop_n + SOURCE_PRIOR_WEIGHT)
        _ug, n, reward = user.get(origin, (0, 0, 0.0))
        alpha = reward + SOURCE_PRIOR_WEIGHT * rate
        beta = (n - reward) + SOURCE_PRIOR_WEIGHT * (1.0 - rate)
        scale = min(1.0, SOURCE_EVIDENCE_CAP / (alpha + beta))
        posteriors[origin] = (alpha * scale, beta * scale)
    return posteriors


def thompson_source_order(
    items: list,
    origin_of,
    posteriors: dict,
    *,
    seed: str,
    window: int,
    max_share: float = MAX_SOURCE_SHARE,
    explore: float = SOURCE_EXPLORE,
) -> list:
    """Переставить кандидатов так, чтобы каждое место доставалось источнику
    сэмплом Томпсона; внутри источника порядок ``items`` (рейтинг) сохраняется.

    В каждом окне из ``window`` мест один источник занимает не больше
    ``max_share``. Пустые ``posteriors`` — порядок без изменений.
    """
    if not posteriors or not items:
        return list(items)
    buckets: dict = {}
    for item in items:
        buckets.setdefault(origin_of(item) or "*", []).append(item)
    if len(buckets) == 1:
        return list(items)
    for queue in buckets.values():
        queue.reverse()  # pop() с конца — дешевле, чем pop(0)
    rng = random.Random(seed)
    cap = max(1, math.ceil(window * max_share))
    used: dict = {}
    ordered = []
    while buckets:
        if len(ordered) % window == 0:
            used = {}
        available = list(buckets)
        allowed = [origin for origin in available if used.get(origin, 0) < cap] or available
        if len(allowed) == 1:
            origin = allowed[0]
        elif rng.random() < explore:
            origin = rng.choice(sorted(allowed))
        else:
            origin = max(
                sorted(allowed),
                key=lambda name: rng.betavariate(
                    *(posteriors.get(name) or posteriors.get("*") or (1.0, 1.0))
                ),
            )
        queue = buckets[origin]
        ordered.append(queue.pop())
        used[origin] = used.get(origin, 0) + 1
        if not queue:
            del buckets[origin]
    return ordered


def language_terms(
    user_scripts: dict, population_scripts: dict, cyr_share: float, texts: int
) -> dict[str, float]:
    """Понижающая поправка score по письменности трека: {"cyr"|"lat": term}.

    Априорный приём письменности — из коллекции (share/0.5 в
    [LANGUAGE_PRIOR_FLOOR, 1]; меньше LANGUAGE_MIN_TEXTS текстов — 1), поверх
    него исходы юзера с весом LANGUAGE_PRIOR_WEIGHT. Поправка — логарифм
    отношения к средней награде юзера, только вниз.
    """
    if texts >= LANGUAGE_MIN_TEXTS:
        shares = {"cyr": cyr_share, "lat": 1.0 - cyr_share}
    else:
        shares = {"cyr": 0.5, "lat": 0.5}
    total_n = sum(n for _good, n, _reward in user_scripts.values())
    if total_n:
        base = sum(reward for _good, _n, reward in user_scripts.values()) / total_n
    else:
        pop_n = sum(n for _good, n, _reward in population_scripts.values())
        base = (
            sum(reward for _good, _n, reward in population_scripts.values()) / pop_n
            if pop_n else NEUTRAL_REWARD
        )
    if base <= 0:
        return {}
    terms = {}
    for script, share in shares.items():
        prior = max(LANGUAGE_PRIOR_FLOOR, min(1.0, share / 0.5))
        _good, n, reward = user_scripts.get(script, (0, 0, 0.0))
        rate = (reward + LANGUAGE_PRIOR_WEIGHT * base * prior) / (n + LANGUAGE_PRIOR_WEIGHT)
        ratio = math.log(max(rate, 1e-6) / base)
        term = LANGUAGE_TERM_WEIGHT * max(LANGUAGE_LOG_RATIO_FLOOR, min(0.0, ratio))
        if term:
            terms[script] = term
    return terms
