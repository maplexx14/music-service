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
import re
from functools import lru_cache
from itertools import combinations
from typing import Iterable, Optional

from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session


@lru_cache(maxsize=256)
def _word_re(keyword: str):
    return re.compile(r"\b" + re.escape(keyword) + r"\b", re.IGNORECASE)


def artists_matching_keywords(
    db: Session,
    keywords: Iterable[str],
    min_matches: int = 1,
    restrict_artists: Optional[set] = None,
) -> set:
    """Нормализованные (lowercase) имена артистов, у которых хотя бы один
    трек в локальной базе содержит одно из keywords в названии (или,
    при min_matches>=2, НЕСКОЛЬКО keywords одновременно в одном названии).

    min_matches=1 годится для жанровых слов (genre_keywords) — там сами слова
    однозначны ("phonk", "trap"). Для тегов вкуса, вытащенных статистически из
    истории (title_tags), одно неоднозначное тематическое слово ("гей") может
    совпасть у совершенно постороннего артиста с одним серьёзным треком на ту
    же тему — там нужен min_matches>=2, чтобы тянуть целый чужой каталог
    только по действительно специфичному, а не по случайному совпадению.

    restrict_artists: искать только среди этих (уже нормализованных) имён.
    Таблица tracks общая для всех юзеров и владельца у трека нет, поэтому без
    ограничения сюда попадает чужая библиотека: юзер, импортировавший плейлист,
    приводил своих артистов в выдачу всем остальным — привязка жанра к артисту
    затем тянула ВЕСЬ каталог такого артиста. Передавайте сюда артистов, по
    которым у юзера есть собственный сигнал. Заодно снимает full-scan по всей
    таблице."""
    from app.models import Track

    keywords = [kw for kw in keywords if kw]
    if not keywords:
        return set()
    if restrict_artists is not None and not restrict_artists:
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
    # LIKE %kw% — дешёвый предфильтр в SQL, но он матчит слово ВНУТРИ другого:
    # "rap" в "Violent PornogRAPhy", "pop" в "Big POPpa", "trap" в "YUNG TRAPPA".
    # Через привязку жанра к артисту это тянуло в выдачу ВЕСЬ чужой каталог
    # (System Of A Down любителю русского рэпа). Границу слова проверяем в
    # Python — SQL-regex по-разному пишется в Postgres (\y) и SQLite (нет его).
    q = db.query(func.lower(Track.artist), Track.title).filter(or_(*conditions))
    if restrict_artists:
        q = q.filter(func.lower(Track.artist).in_(restrict_artists))
    rows = q.all()
    lowered = [kw.lower() for kw in keywords]
    matched = set()
    for artist, title in rows:
        if not artist:
            continue
        hits = sum(1 for kw in lowered if _word_re(kw).search(title or ""))
        if hits >= max(1, min_matches):
            matched.add(artist)
    return matched
