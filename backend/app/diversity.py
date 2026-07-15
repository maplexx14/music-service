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


def interleave_artists(items, artist_getter=lambda item: getattr(item, "artist", None)):
    """Stably avoid adjacent artists whenever another candidate is available."""
    remaining = list(items)
    ordered = []
    previous_artist = None

    while remaining:
        selected_index = 0
        if previous_artist is not None:
            for index, item in enumerate(remaining):
                artist = (artist_getter(item) or "").strip().casefold()
                if artist != previous_artist:
                    selected_index = index
                    break

        item = remaining.pop(selected_index)
        ordered.append(item)
        previous_artist = (artist_getter(item) or "").strip().casefold()

    return ordered


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
