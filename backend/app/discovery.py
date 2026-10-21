"""Баланс между знакомым и новым (``User.discovery_ratio``).

Шкала остаётся общей для рекомендательных endpoint. Дефолтное значение
сохраняет мягкий prior, а явно повышенное значение задаёт минимальную цель
разведки для потока: это не ломает fallback, если у провайдеров нет новых
кандидатов, но и не позволяет богатому пулу лайков поглотить запрос на новые
имена.

Здесь же считаются обе явные квоты порции: ``discovery_slots`` — сколько мест
держать под новых артистов, ``liked_slots`` — сколько под уже понравившееся.
Вторая нужна потому, что по одному ранжированию лайки в поток не попадали
вовсе (см. ``routers.flow._liked_candidates``). Раньше она была обратной
стороной этого же ползунка; с 2026-10-22 ей управляет свой ползунок «Любимые
треки» (app/flow_tuning.py), а ползунок новых артистов сужает её только
сверху — местами, которые заняла цель новизны (``routers.flow._liked_cap``).
"""
from typing import Optional

DEFAULT_DISCOVERY_RATIO = 0.2

# Доля порции под уже понравившееся при «Любимых треках» по центру — столько
# же, сколько раньше давал ползунок новых артистов на дефолте (3 из 15). На
# максимуме «Любимых» вдвое больше: волна и тогда не становится плейлистом
# лайков. Прежняя связка с ползунком новых артистов (0.25 × (1 − ratio),
# выбор 2026-10-10) убрана 2026-10-22: два ползунка тянули одно и то же, и
# «Любимые» на максимуме при новых 90% давали ноль лайков.
LIKED_SHARE = 0.2


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


def liked_slots(limit: int, factor: float = 1.0) -> int:
    """Сколько мест в порции держать под уже понравившиеся треки.

    Явная цель, а не prior, как и ``discovery_slots``: понравившееся нужно в
    потоке как музыка, а не только как сигнал вкуса — без своей квоты оно
    проигрывало общему ранжированию всегда.

    ``factor`` — ползунок «Любимые треки» (FlowTuning.liked_factor): 0 — без
    лайков, 1 — ``LIKED_SHARE``, 2 — вдвое больше. Новизна сюда не входит:
    места под неё вычитает ``routers.flow._liked_cap``, и на максимуме
    ползунка новых артистов лайков по-прежнему ноль.
    """
    if limit <= 0:
        return 0
    share = LIKED_SHARE * min(2.0, max(0.0, factor))
    return min(limit, round(limit * share))

