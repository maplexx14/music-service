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
from typing import Iterable

from sqlalchemy import func, or_
from sqlalchemy.orm import Session


def artists_matching_keywords(db: Session, keywords: Iterable[str]) -> set:
    """Нормализованные (lowercase) имена артистов, у которых хотя бы один
    трек в локальной базе содержит одно из keywords в названии."""
    from app.models import Track

    keywords = [kw for kw in keywords if kw]
    if not keywords:
        return set()
    conditions = [func.lower(Track.title).like(f"%{kw.lower()}%") for kw in keywords]
    rows = (
        db.query(func.lower(Track.artist))
        .filter(or_(*conditions))
        .distinct()
        .all()
    )
    return {r[0] for r in rows if r[0]}
