"""Тонкая настройка волны (``User.flow_tuning``) — ползунки в «Рекомендациях».

Четыре ручки, каждая в [0, 1]. Середина (0.5) — ровно прежнее поведение
волны: юзер, который ползунков не трогал, получает ту же волну, что и до их
появления, а крайние положения растягивают уже существующие константы
ранкера, а не включают новые механизмы.

* ``liked`` — сколько понравившегося подмешивать: множитель квоты
  ``discovery.liked_slots`` от 0 до 2. Ползунок новых артистов её больше не
  меняет, только занимает места сверху; на его максимуме лайков нет.
* ``depth`` — хиты или редкое. По всей волне — вес популярности в ранкере
  ×3…×⅓; у любимых артистов ещё и масштаб ``_DEEP_CUT_SCALE`` от 1.5
  (почти только топ) до 24 (почти равномерно по дискографии).
* ``variety`` — как часто повторять артиста: штраф повтора ×⅓…×3 и
  минимальный разнос треков артиста 2…6.
* ``recent`` — на что опираться при поиске похожего: на недавно
  дослушанное и лайкнутое или на всю коллекцию. Доля свежих сидов 0…все.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Mapping

KEYS = ("liked", "depth", "variety", "recent")
NEUTRAL = 0.5

# Разнос треков одного артиста в порции при среднем положении «разнообразия» —
# прежний _MIN_ARTIST_GAP и flow_session.MIN_ARTIST_GAP.
_BASE_ARTIST_GAP = 4
_BASE_DEEP_CUT_SCALE = 6.0


def _clamp(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return NEUTRAL
    if number != number:  # NaN
        return NEUTRAL
    return min(1.0, max(0.0, number))


@dataclass(frozen=True)
class FlowTuning:
    liked: float = NEUTRAL
    depth: float = NEUTRAL
    variety: float = NEUTRAL
    recent: float = NEUTRAL

    @property
    def liked_factor(self) -> float:
        """Множитель квоты понравившегося: 0 → 0, 0.5 → 1, 1 → 2."""
        return 2.0 * self.liked

    @property
    def deep_cut_scale(self) -> float:
        """Масштаб exp(-r / scale) по месту трека в топе артиста: 0 → 1.5
        (почти только хиты), 0.5 → 6 (как было), 1 → 24 (почти равномерно)."""
        return _BASE_DEEP_CUT_SCALE * 2.0 ** ((self.depth - NEUTRAL) * 4.0)

    @property
    def hits_factor(self) -> float:
        """Множитель веса популярности в ранкере волны: 0 → 3 (хиты сильно
        вперёд), 0.5 → 1 (как было), 1 → ⅓ (популярность почти не помогает)."""
        return 3.0 ** ((NEUTRAL - self.depth) * 2.0)

    @property
    def repeat_factor(self) -> float:
        """Множитель штрафа за повтор артиста: 0 → ⅓, 0.5 → 1, 1 → 3."""
        return 3.0 ** ((self.variety - NEUTRAL) * 2.0)

    @property
    def artist_gap(self) -> int:
        """Минимальный разнос треков одного артиста: 0 → 2, 0.5 → 4, 1 → 6."""
        return _BASE_ARTIST_GAP + round((self.variety - NEUTRAL) * 4.0)

    def fresh_seeds(self, base: int) -> int:
        """Сколько сидов брать из недавних позитивов вместо ``base``
        (прежний _FRESH_SEED_SHARE): 0 → 0, 0.5 → base, 1 → 2·base."""
        return round(base * 2.0 * self.recent)

    def as_dict(self) -> dict:
        return {key: round(value, 2) for key, value in asdict(self).items()}


def parse(raw: Any) -> FlowTuning:
    """Настройки из JSON строки юзера; чужие ключи и мусор — в середину."""
    if not isinstance(raw, Mapping):
        return FlowTuning()
    return FlowTuning(**{key: _clamp(raw.get(key, NEUTRAL)) for key in KEYS})


def flow_tuning(user) -> FlowTuning:
    """Настройки юзера; у старой сессии/фикстуры поля может не быть вовсе."""
    return parse(getattr(user, "flow_tuning", None))
