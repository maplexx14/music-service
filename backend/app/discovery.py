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
# 0.25 — выбор владельца продукта, 2026-10-10: при 0.35 его ползунок 0.6
# давал 3 лайка из 15, это много; теперь 2 (на дефолте 3, в крайнем «знакомом» 4).
LIKED_MAX_SHARE = 0.25


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


def effective_discovery_ratio(ratio: float, acceptance_factor: float = 1.0) -> float:
    """Ползунок как потолок: фактическая доля новизны по ответам самого юзера.

    ``acceptance_factor`` — во сколько раз новые артисты принимаются хуже
    знакомых (1.0 — одинаково, см. ``discovery_feedback``). Сжимается только
    часть ползунка ВЫШЕ дефолта: дефолтный мягкий prior не трогаем, а явно
    попрошенная новизна отдаётся в той мере, в какой юзер её реально слушает.
    Замер на проде: новые артисты в волне дослушивались в 3 раза реже знакомых
    при ползунке 0.55, то есть половина порции уходила в скипы.
    """
    ratio = min(1.0, max(0.0, float(ratio)))
    if ratio <= DEFAULT_DISCOVERY_RATIO:
        return ratio
    factor = min(1.0, max(0.0, float(acceptance_factor)))
    return DEFAULT_DISCOVERY_RATIO + (ratio - DEFAULT_DISCOVERY_RATIO) * factor
