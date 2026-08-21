"""Мягкий prior на открытие новых артистов (``User.discovery_ratio``).

Оба рекомендательных endpoint используют одну шкалу, но она больше не делит
ответ на знакомые и незнакомые слоты. Значение лишь сдвигает общий score
кандидата: акустическая близость, плейлисты и поведение пользователя остаются
важнее, поэтому релевантный трек не отбрасывается из-за класса артиста.
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
