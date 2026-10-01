"""Единая разметка исхода показа: «хорошо», «плохо» или нейтрально.

Раньше правила жили в нескольких местах и расходились. Популяционный сигнал
волны считал позитивом любой ``listen``/``play``, а фронт шлёт ``listen`` при
КАЖДОМ уходе с трека, в том числе сразу после скипа. На проде (2026-10-01)
так «понравившимися» выглядели 88% треков волны против 11% по честной метке,
и у 2469 из 3219 треков один и тот же юзер был одновременно «за» и «против».

Правила (события одной позиции или одного юзера по треку, по времени):

* явная оценка главнее поведения: последний из like/unlike и dislike/undislike
  решает, если он в силе (лайк — хорошо, дизлайк — плохо);
* иначе дослушивание до ``GOOD_COMPLETION`` — хорошо;
* иначе скип или уход раньше ``BAD_COMPLETION`` — плохо;
* остальное (25–80%, ``play`` без ``listen``) — нейтрально.
"""
from __future__ import annotations

from typing import Optional

GOOD_COMPLETION = 0.8
BAD_COMPLETION = 0.25
FEEDBACK_EVENT_TYPES = ("listen", "like", "unlike", "skip", "dislike", "undislike")

_EXPLICIT = {"like": "good", "unlike": None, "dislike": "bad", "undislike": None}


class OutcomeTracker:
    """Копит события одной позиции; события подавать в порядке времени."""

    __slots__ = ("explicit", "completion", "skipped")

    def __init__(self) -> None:
        self.explicit: Optional[str] = None
        self.completion: Optional[float] = None
        self.skipped = False

    def add(self, event_type: str, value=None) -> None:
        if event_type in _EXPLICIT:
            if event_type in ("unlike", "undislike"):
                # Снятие оценки отменяет только свою же оценку: unlike после
                # дизлайка дизлайк не трогает.
                cancelled = "good" if event_type == "unlike" else "bad"
                if self.explicit == cancelled:
                    self.explicit = None
            else:
                self.explicit = _EXPLICIT[event_type]
        elif event_type == "skip":
            self.skipped = True
        elif event_type == "listen" and value is not None:
            self.completion = max(self.completion or 0.0, float(value))

    @property
    def label(self) -> Optional[str]:
        if self.explicit is not None:
            return self.explicit
        if self.completion is not None and self.completion >= GOOD_COMPLETION:
            return "good"
        if self.skipped or (self.completion is not None and self.completion < BAD_COMPLETION):
            return "bad"
        return None

    @property
    def good(self) -> bool:
        return self.label == "good"

    @property
    def bad(self) -> bool:
        return self.label == "bad"
