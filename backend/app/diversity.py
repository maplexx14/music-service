"""Ограничение повторов одного артиста в выдаче.

Кандидаты в рекомендациях/волне обычно сортируются по play_count — из-за
этого несколько самых заигранных артистов вкуса перебивают всех остальных
и раз за разом занимают большую часть выдачи. cap_per_artist сохраняет
порядок (важные/популярные треки остаются впереди), но не даёт одному
артисту занять больше max_per_artist мест.
"""
import re
from typing import Callable, List, TypeVar

T = TypeVar("T")


def _artist_key(name: str) -> str:
    return re.sub(r"\s+", " ", (name or "").strip().lower())


def cap_per_artist(
    items: List[T],
    max_per_artist: int = 2,
    artist_of: Callable[[T], str] = lambda t: t.artist,
) -> List[T]:
    """Возвращает items в исходном порядке, отбросив те, что превышают лимит
    max_per_artist на артиста (первые max_per_artist по каждому — в приоритете,
    т.к. порядок обычно уже отсортирован по релевантности/популярности)."""
    counts: dict = {}
    result: List[T] = []
    for item in items:
        key = _artist_key(artist_of(item))
        n = counts.get(key, 0)
        if n >= max_per_artist:
            continue
        counts[key] = n + 1
        result.append(item)
    return result
