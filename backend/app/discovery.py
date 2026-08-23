"""Баланс между знакомым и новым (``User.discovery_ratio``).

Шкала остаётся общей для рекомендательных endpoint. Дефолтное значение
сохраняет мягкий prior, а явно повышенное значение задаёт минимальную цель
разведки для потока: это не ломает fallback, если у провайдеров нет новых
кандидатов, но и не позволяет богатому пулу лайков поглотить запрос на новые
имена.

У ползунка две стороны, и обе считаются здесь: ``discovery_slots`` — сколько
мест держать под новых артистов, ``liked_slots`` — сколько под уже
понравившееся. Вторая нужна потому, что по одному ранжированию лайки в поток не
попадали вовсе (см. ``routers.flow._liked_candidates``).
"""
from typing import Optional

DEFAULT_DISCOVERY_RATIO = 0.2

# Доля порции под уже понравившееся при ползунке в крайнем «знакомом»
# положении. Меньше половины намеренно: даже когда пользователь просит
# «точнее по знакомому», волна остаётся волной, а не плейлистом лайков.
LIKED_MAX_SHARE = 0.35


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


def liked_slots(limit: int, ratio: float) -> int:
    """Сколько мест в порции держать под уже понравившиеся треки.

    Обратная сторона ``discovery_slots`` и такая же явная цель, а не prior:
    ползунок влево («точнее по знакомому») — доля максимальная, вправо
    («смелее открывать новое») — ноль. Понравившееся нужно в потоке как
    музыка, а не только как сигнал вкуса: без своей квоты оно проигрывало
    общему ранжированию всегда, на любом положении ползунка.

    Ноль на максимуме разведки — намеренно: пользователь попросил новые имена,
    и подмешивать ему собственные лайки было бы прямым противоречием.
    """
    if limit <= 0:
        return 0
    share = LIKED_MAX_SHARE * (1.0 - min(1.0, max(0.0, ratio)))
    return min(limit, round(limit * share))
