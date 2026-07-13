"""Жанр/тема, привязанные к артисту целиком, а не только к конкретному треку.

Раньше матчинг по ключевым словам/тегам (genre_keywords.py, title_tags.py) шёл
исключительно по названию КОНКРЕТНОГО трека-кандидата. Из-за этого при
тестовом прослушивании нескольких треков с одним и тем же словом в названии
(например "гей") в рекомендации попадал только тот единственный трек, где
слово буквально есть в заголовке — остальные треки того же артиста без этого
слова в названии игнорировались, хотя весь артист по сути посвящён той же
теме.

Здесь мы находим артистов, у которых хотя бы часть каталога в локальной базе
матчит нужные ключевые слова, и считаем жанр/тему привязанной к артисту в
целом — так в кандидаты попадают ВСЕ его треки.
"""
from itertools import combinations
from typing import Iterable

from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session


def artists_matching_keywords(db: Session, keywords: Iterable[str], min_matches: int = 1) -> set:
    """Нормализованные (lowercase) имена артистов, у которых хотя бы один
    трек в локальной базе содержит одно из keywords в названии (или,
    при min_matches>=2, НЕСКОЛЬКО keywords одновременно в одном названии).

    min_matches=1 годится для жанровых слов (genre_keywords) — там сами слова
    однозначны ("phonk", "trap"). Для тегов вкуса, вытащенных статистически из
    истории (title_tags), одно неоднозначное тематическое слово ("гей") может
    совпасть у совершенно постороннего артиста с одним серьёзным треком на ту
    же тему — там нужен min_matches>=2, чтобы тянуть целый чужой каталог
    только по действительно специфичному, а не по случайному совпадению."""
    from app.models import Track

    keywords = [kw for kw in keywords if kw]
    if not keywords:
        return set()
    if min_matches <= 1:
        conditions = [func.lower(Track.title).like(f"%{kw.lower()}%") for kw in keywords]
    elif len(keywords) < min_matches:
        # Неоднозначные теги (title_tags) требуют пары — одиночный тег как
        # фильтр-пылесос тянет весь чужой каталог по случайному совпадению.
        return set()
    else:
        conditions = [
            and_(*(func.lower(Track.title).like(f"%{kw.lower()}%") for kw in combo))
            for combo in combinations(keywords, min_matches)
        ]
    rows = (
        db.query(func.lower(Track.artist))
        .filter(or_(*conditions))
        .distinct()
        .all()
    )
    return {r[0] for r in rows if r[0]}
