"""Грубое определение жанра трека по ключевым словам в названии/авторе.

У внешних треков (SoundCloud, YT Music) поле genre почти всегда пустое —
провайдеры его просто не отдают. Но само название трека часто прямо называет
жанр ("... Phonk Remix", "... Trap Type Beat", "... Lo-Fi Mix") — это дешёвый
дополнительный сигнал, который не хуже честного genre учитывать в вкусовом
профиле и при подборе кандидатов.

Не претендует на точность полноценной жанровой классификации — простое
совпадение по подстроке, порядок словаря — это и приоритет (специфичное
раньше общего, например "phonk" проверяется раньше "electronic").
"""
import re
from collections import Counter
from typing import Optional

from sqlalchemy import func

GENRE_KEYWORDS: dict = {
    "phonk": ["phonk", "фонк", "drift phonk"],
    "trap": ["trap", "трэп", "треп"],
    "hip-hop": ["rap", "hip hop", "hip-hop", "рэп", "хип-хоп", "хип хоп"],
    "rock": ["rock", "рок", "metal", "метал", "punk", "панк"],
    "electronic": [
        "edm", "techno", "техно", "dubstep", "дабстеп", "house", "хаус",
        "electro", "электро", "dnb", "drum and bass", "hardstyle",
    ],
    "remix": ["remix", "ремикс", "mashup", "мэшап", "bootleg"],
    "lofi": ["lofi", "lo-fi", "lo fi"],
    "pop": ["pop", "поп"],
    "jazz": ["jazz", "джаз"],
    "classical": ["classical", "классика", "orchestra", "оркестр", "symphony", "симфони"],
    "reggae": ["reggae", "регги"],
    "folk": ["folk", "фолк", "народн"],
    "chill": ["chill", "ambient", "эмбиент", "релакс", "relax"],
}

_KEYWORD_PATTERNS = {
    genre: re.compile(r"|".join(re.escape(kw) for kw in kws), re.IGNORECASE)
    for genre, kws in GENRE_KEYWORDS.items()
}


def infer_genre_from_text(title: str, artist: str = "") -> Optional[str]:
    """Возвращает первый жанр, чьи ключевые слова встретились в title/artist,
    либо None, если ничего не подошло."""
    text = f"{title or ''} {artist or ''}"
    if not text.strip():
        return None
    for genre, pattern in _KEYWORD_PATTERNS.items():
        if pattern.search(text):
            return genre
    return None


def top_genre_keywords(genre_counts: dict, top_n: int = 3) -> list:
    """Плоский список ключевых слов top_n самых частых жанров вкуса
    пользователя (genre_counts: жанр -> сколько раз встретился, явно через
    Track.genre или по ключевым словам). Ограничение top_n — чтобы не
    раздувать дальнейшие запросы десятками слов на разношёрстной истории."""
    if not genre_counts:
        return []
    top_genres = [g for g, _ in Counter(genre_counts).most_common(top_n)]
    keywords = []
    for genre in top_genres:
        keywords.extend(GENRE_KEYWORDS.get(genre, []))
    return keywords


def build_keyword_filters(title_col, genre_counts: dict, top_n: int = 3) -> list:
    """SQL-условия (title ILIKE %keyword%) для top_n самых частых жанров вкуса."""
    return [
        func.lower(title_col).like(f"%{kw.lower()}%")
        for kw in top_genre_keywords(genre_counts, top_n)
    ]
