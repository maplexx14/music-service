"""Баланс открытия новых артистов (``User.discovery_ratio``).

Шкала остаётся общей для рекомендательных endpoint. Дефолтное значение
сохраняет мягкий prior, а явно повышенное значение задаёт минимальную цель
разведки для потока: это не ломает fallback, если у провайдеров нет новых
кандидатов, но и не позволяет богатому пулу лайков поглотить запрос на новые
имена.
"""
from typing import Optional

DEFAULT_DISCOVERY_RATIO = 0.2


def discovery_ratio(user) -> float:
    """Вернуть силу мягкого prior, гарантированно в диапазоне [0.0, 1.0].

    Читает атрибут защитно: у юзера из старой сессии/фикстуры поля может не
    быть вовсе, а None приходит из строки, созданной до миграции 0015.
    """
    raw: Optional[float] = getattr(user, "discovery_ratio", None)
    if raw is None:
        return DEFAULT_DISCOVERY_RATIO
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return DEFAULT_DISCOVERY_RATIO
    return min(1.0, max(0.0, value))


def discovery_slots(limit: int, ratio: float) -> int:
    """Return the requested number of new-artist slots for a batch.

    A zero ratio explicitly disables the target. Any positive ratio gets at
    least one slot when the batch is non-empty; the caller may still fall back
    to familiar tracks when the discovery pool is exhausted.
    """
    if limit <= 0 or ratio <= 0:
        return 0
    return min(limit, max(1, round(limit * ratio)))
