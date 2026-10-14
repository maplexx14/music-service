"""Обучаемый ранкер волны: логистическая регрессия по телеметрии отдачи.

Ручной скор (recommendation_scoring.score_components) — сумма слагаемых с
весами, подобранными по инцидентам. По телеметрии он почти ничего не решает:
у нового артиста affinity = 0, жанра у внешних треков нет, и новые кандидаты
различаются лишь популярностью и бонусом источника. Здесь веса тех же самых
признаков (они уже пишутся в ``recommendation_impressions.features``) берутся
из исходов: «хорошо» (лайк, дослушал от 55%) против «плохо» (скип, дизлайк,
<25%), нейтральное не учится. Сильный позитив (лайк, от 80%) весит
``STRONG_WEIGHT`` примеров.

Модель маленькая намеренно: юзеров десятки, и 9 из 10 исходов — один
человек. Нейросеть или бустинг на таком объёме выучили бы шум. Глобальная
модель — для всех; у юзера, набравшего ``USER_MIN_ROWS`` размеченных
показов, — своя, обученная поверх глобальной (старт с её весов, регуляризация
к ним). Модель сохраняется, только если на отложенной по времени части она
различает исходы лучше монетки (``MIN_AUC``) и лучше ручного скора хотя бы на
``MIN_GAIN`` — иначе выдача обходится без неё.

Без numpy (его нет в образе): данных тысячи строк, признаков десятки —
полный градиентный спуск укладывается в секунды в flow-warmer.
"""
from __future__ import annotations

import json
import logging
import math
import time
from datetime import datetime, timedelta, timezone
from typing import Callable, Iterable, Optional

from app.cache import redis_client

logger = logging.getLogger(__name__)

MODEL_VERSION = 1
_GLOBAL_KEY = f"flow:ranker:v{MODEL_VERSION}:global"
_USER_KEY = f"flow:ranker:v{MODEL_VERSION}:user:{{}}"
_MODEL_TTL = 7 * 24 * 60 * 60
WINDOW_DAYS = 30
MIN_ROWS = 300
USER_MIN_ROWS = 800
MIN_AUC = 0.55
# Модель вровень с ручным скором ничего не даёт, только переставляет порцию
# случайно (прод, 2026-10-14: глобальная 0.649 против ручного 0.653).
MIN_GAIN = 0.01
HOLDOUT_SHARE = 0.2
EPOCHS = 20
# Свежие показы важнее: дальше хвост только удлиняет обучение.
MAX_ROWS = 12000
LEARNING_RATE = 0.05
L2 = 0.02
STRONG_WEIGHT = 2.0

COMPONENTS = (
    "affinity", "content", "popularity", "freshness", "source", "novelty",
    "context", "population", "discovery", "repeat", "origin", "language",
)
ORIGINS = (
    "liked", "local", "favorite", "lastfm_similar", "similar_hits", "radio",
    "artist_graph", "soundcloud", "genre", "tag", "probe",
)
FEATURE_NAMES = (
    *(f"c:{name}" for name in COMPONENTS),
    *(f"o:{name}" for name in ORIGINS),
    "novel", "hit", "not_hit", "cyr", "fresh_cluster", "relaxed", "proximity",
)


def vectorize(features: dict) -> list[float]:
    """Признаки показа (features из телеметрии) -> вектор FEATURE_NAMES."""
    features = features if isinstance(features, dict) else {}
    components = features.get("components") or {}
    origin = features.get("origin")
    hit = features.get("hit")
    row = [float(components.get(name) or 0.0) for name in COMPONENTS]
    row += [1.0 if origin == name else 0.0 for name in ORIGINS]
    row += [
        1.0 if features.get("novel") else 0.0,
        1.0 if hit is True else 0.0,
        1.0 if hit is False else 0.0,
        1.0 if features.get("script") == "cyr" else 0.0,
        1.0 if features.get("fresh_cluster") else 0.0,
        1.0 if features.get("relaxed") else 0.0,
        float(features.get("proximity") or 0.0),
    ]
    return row


def _sigmoid(value: float) -> float:
    if value >= 0:
        return 1.0 / (1.0 + math.exp(-value))
    exp = math.exp(value)
    return exp / (1.0 + exp)


def auc(scores: list[float], labels: list[int]) -> float:
    """Площадь под ROC (вероятность, что хороший выше плохого); 0.5 — монетка."""
    pairs = sorted(zip(scores, labels))
    positives = sum(labels)
    negatives = len(labels) - positives
    if not positives or not negatives:
        return 0.5
    rank_sum = 0.0
    index = 0
    while index < len(pairs):
        end = index
        while end + 1 < len(pairs) and pairs[end + 1][0] == pairs[index][0]:
            end += 1
        average_rank = (index + end) / 2 + 1
        rank_sum += average_rank * sum(label for _s, label in pairs[index:end + 1])
        index = end + 1
    return (rank_sum - positives * (positives + 1) / 2) / (positives * negatives)


def _standardize(rows: list[list[float]]):
    size = len(rows[0])
    mean = [sum(row[i] for row in rows) / len(rows) for i in range(size)]
    std = []
    for i in range(size):
        variance = sum((row[i] - mean[i]) ** 2 for row in rows) / len(rows)
        std.append(math.sqrt(variance) or 1.0)
    return mean, std


def _fit(
    rows: list[list[float]],
    labels: list[int],
    mean: list[float],
    std: list[float],
    *,
    prior: Optional[list[float]] = None,
    epochs: int = EPOCHS,
    sample_weights: Optional[list[float]] = None,
) -> list[float]:
    """Веса [bias, w...] по стандартизованным признакам; L2 тянет к ``prior``.

    Стохастический спуск: полный градиент на чистом Python стоил минуту на
    3 тысячах строк, SGD сходится за пару десятков проходов в секунды.
    """
    import random

    size = len(mean)
    x = [[(row[i] - mean[i]) / std[i] for i in range(size)] for row in rows]
    weights = list(prior) if prior else [0.0] * (size + 1)
    anchor = list(prior) if prior else [0.0] * (size + 1)
    count = len(x)
    sample_weights = sample_weights or [1.0] * count
    # Классы несбалансированы (хорошо ~5–10%): веса классов уравнивают вклад,
    # иначе модель учит в основном «всё плохо» и ранжирует хуже.
    positives = max(1, sum(labels))
    negatives = max(1, count - positives)
    class_weight = {1: count / (2 * positives), 0: count / (2 * negatives)}
    order = list(range(count))
    rng = random.Random(0)
    for epoch in range(epochs):
        rng.shuffle(order)
        rate = LEARNING_RATE / (1.0 + epoch)
        for index in order:
            features = x[index]
            label = labels[index]
            logit = weights[0] + sum(w * v for w, v in zip(weights[1:], features))
            error = (_sigmoid(logit) - label) * class_weight[label] * sample_weights[index]
            weights[0] -= rate * error
            for i, value in enumerate(features, start=1):
                weights[i] -= rate * (error * value + L2 * (weights[i] - anchor[i]) / count)
    return weights


def _logit(model: dict, vector: list[float]) -> float:
    weights = model["weights"]
    mean = model["mean"]
    std = model["std"]
    return weights[0] + sum(
        w * (value - m) / s for w, value, m, s in zip(weights[1:], vector, mean, std)
    )


def train(samples: Iterable[tuple], *, prior: Optional[dict] = None) -> Optional[dict]:
    """samples: (features, label 1/0, время показа[, вес]). Модель или None.

    Качество — AUC на последних по времени ``HOLDOUT_SHARE`` показов, после
    чего модель дообучается на всех. Ниже ``MIN_AUC`` или не лучше ручного
    скора на ``MIN_GAIN`` — None.
    """
    data = sorted(samples, key=lambda row: row[2])[-MAX_ROWS:]
    if len(data) < MIN_ROWS:
        return None
    vectors = [vectorize(row[0]) for row in data]
    labels = [int(row[1]) for row in data]
    weights_of = [float(row[3]) if len(row) > 3 else 1.0 for row in data]
    if sum(labels) < 10 or len(labels) - sum(labels) < 10:
        return None
    split = int(len(data) * (1 - HOLDOUT_SHARE))
    mean, std = _standardize(vectors)
    start = prior["weights"] if prior and len(prior.get("weights") or []) == len(mean) + 1 else None
    weights = _fit(vectors[:split], labels[:split], mean, std, prior=start, sample_weights=weights_of[:split])
    probe = {"weights": weights, "mean": mean, "std": std}
    holdout_auc = auc([_logit(probe, v) for v in vectors[split:]], labels[split:])
    baseline = auc(
        [sum(float(v) for v in ((row[0].get("components") or {}).values())) for row in data[split:]],
        labels[split:],
    )
    if holdout_auc < MIN_AUC or holdout_auc < baseline + MIN_GAIN:
        logger.info("ranker rejected: auc=%.3f baseline=%.3f n=%d", holdout_auc, baseline, len(data))
        return None
    weights = _fit(vectors, labels, mean, std, prior=start, sample_weights=weights_of)
    return {
        "version": MODEL_VERSION,
        "features": list(FEATURE_NAMES),
        "weights": weights,
        "mean": mean,
        "std": std,
        "n": len(data),
        "positives": sum(labels),
        "auc": round(holdout_auc, 4),
        "baseline_auc": round(baseline, 4),
        "trained_at": time.time(),
    }


def samples_from_outcomes(rows: Iterable[dict]) -> list[tuple[dict, int, float, float]]:
    """Строки delivery_outcomes -> обучающие примеры; нейтральные пропускаются."""
    samples = []
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    for row in rows:
        if not (row.get("good") or row.get("bad")):
            continue
        features = row.get("features") or {}
        if not features.get("components"):
            continue
        shown_at = row.get("shown_at") or epoch
        weight = STRONG_WEIGHT if row.get("good") and row.get("strong") else 1.0
        samples.append((features, 1 if row.get("good") else 0, shown_at.timestamp(), weight))
    return samples


def train_and_store(db, user_ids: Iterable[int], now: Optional[datetime] = None) -> dict:
    """Обучить глобальную и пользовательские модели и положить их в Redis."""
    from app.discovery_feedback import delivery_outcomes

    now = now or datetime.now(timezone.utc)
    since = now - timedelta(days=WINDOW_DAYS)
    per_user = {}
    for user_id in user_ids:
        try:
            per_user[user_id] = samples_from_outcomes(delivery_outcomes(db, user_id, since=since))
        except Exception:  # noqa: BLE001
            db.rollback()
            logger.exception("ranker samples failed user=%s", user_id)
    report = {"global": None, "users": {}}
    global_model = train([s for samples in per_user.values() for s in samples])
    _store(_GLOBAL_KEY, global_model)
    if global_model is not None:
        report["global"] = {k: global_model[k] for k in ("n", "auc", "baseline_auc")}
    for user_id, samples in per_user.items():
        model = train(samples, prior=global_model) if len(samples) >= USER_MIN_ROWS else None
        _store(_USER_KEY.format(user_id), model)
        if model is not None:
            report["users"][user_id] = {k: model[k] for k in ("n", "auc", "baseline_auc")}
    return report


def _store(key: str, model: Optional[dict]) -> None:
    """Отклонённая модель стирает прежнюю: иначе та работала бы ещё неделю
    (TTL), хотя на свежих данных уже не лучше ручного скора."""
    if model is None:
        redis_client.delete(key)
    else:
        redis_client.set(key, json.dumps(model), ex=_MODEL_TTL)


def load(user_id: int) -> Optional[dict]:
    """Модель юзера, иначе глобальная, иначе None."""
    for key in (_USER_KEY.format(user_id), _GLOBAL_KEY):
        try:
            raw = redis_client.get(key)
        except Exception:  # noqa: BLE001 — без Redis выдача обходится без ранкера
            return None
        if not raw:
            continue
        try:
            model = json.loads(raw)
        except (TypeError, ValueError):
            continue
        if model.get("version") == MODEL_VERSION and model.get("features") == list(FEATURE_NAMES):
            return model
    return None


def scorer(model: Optional[dict]) -> Optional[Callable[[dict], Optional[float]]]:
    """features показа -> логит P(хорошо); None — модели нет."""
    if not model:
        return None

    def score(features: dict) -> Optional[float]:
        if not isinstance(features, dict) or not features.get("components"):
            return None
        return _logit(model, vectorize(features))

    return score


def main() -> None:
    """Обучение отдельным процессом: flow-warmer зовёт его раз в сутки, чтобы
    минуты чистого Python не держали GIL расчётов порций."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    from sqlalchemy import select

    from app.database import SessionLocal
    from app.models import recommendation_impressions

    since = datetime.now(timezone.utc) - timedelta(days=WINDOW_DAYS)
    db = SessionLocal()
    try:
        user_ids = db.execute(
            select(recommendation_impressions.c.user_id)
            .where(
                recommendation_impressions.c.surface == "flow",
                recommendation_impressions.c.shown_at >= since,
            )
            .group_by(recommendation_impressions.c.user_id)
        ).scalars().all()
        report = train_and_store(db, user_ids)
    finally:
        db.close()
    logger.info("ranker trained: %s", json.dumps(report, default=str))


if __name__ == "__main__":
    main()
