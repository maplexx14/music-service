"""Из названий уже прослушанных/лайкнутых треков выделяем часто повторяющиеся
слова как дополнительный сигнал вкуса — НЕ привязанный к фиксированному
словарю жанров (см. genre_keywords.py). Фиксированный словарь по определению
не может знать заранее каждое слово, которое для конкретного пользователя
окажется значимым ("гей ремикс", конкретный мемный тег, название типа бита и
т.п.) — вместо этого здесь слово становится сигналом само по себе, если оно
статистически повторяется в истории пользователя достаточно часто.
"""
import re
from collections import Counter
from typing import Iterable

# Шумовые слова в названиях треков — сами по себе ничего не говорят о вкусе,
# даже если часто повторяются (это метаданные формата, а не жанр/тема).
_STOPWORDS = {
    "feat", "ft", "official", "video", "audio", "lyrics", "lyric", "hd", "hq",
    "remastered", "remaster", "version", "prod", "mix", "original",
    "featuring", "type", "beat", "instrumental", "the", "and",
    "официальный", "клип", "текст", "слова", "аудио",
    # Модификаторы формата, а не темы/жанра (см. genre_keywords.MODIFIER_KEYWORDS)
    # — "ремикс"/"remix" встречается почти в каждом названии у любителей
    # ремиксов конкретного жанра/темы и без этого превращался в тег,
    # матчащий ЛЮБОЙ трек с "Remix" в названии независимо от темы/жанра.
    "remix", "ремикс", "mashup", "мэшап", "bootleg", "ver", "тикток", "tiktok",
    # Слова стиля-обработки ("... Slowed + Reverb", "Sped Up", "Nightcore") —
    # тоже формат, а не вкус: как тег матчат ЛЮБОЙ замедленный/ускоренный трек
    # (напр. постороннее UK-drill "LV Sandals (Slowed)").
    "slowed", "reverb", "реверб", "sped", "spedup", "nightcore", "найткор",
    "slow", "speed", "boosted",
}
_WORD_RE = re.compile(r"[a-zа-яё0-9]+", re.IGNORECASE)
_MIN_WORD_LEN = 3
# Слово должно встретиться в названиях минимум стольких РАЗНЫХ треков, чтобы
# не превратить случайное совпадение в единственном названии в "сигнал".
_MIN_OCCURRENCES = 2
_MAX_TAGS = 8


def extract_words(text: str) -> list:
    return [w.lower() for w in _WORD_RE.findall(text or "") if len(w) >= _MIN_WORD_LEN]


def build_title_tag_profile(weighted_titles: Iterable[tuple]) -> dict:
    """weighted_titles — итерируемое (title, weight), weight обычно затухающий
    по времени вес записи (как и для артистов/жанров). Возвращает
    {слово: суммарный_вес} для слов, встретившихся минимум в _MIN_OCCURRENCES
    разных названиях и не являющихся стоп-словом — top _MAX_TAGS по весу."""
    occurrence_count: Counter = Counter()
    weight_sum: dict = {}
    for title, weight in weighted_titles:
        words_in_title = set(extract_words(title))
        for word in words_in_title:
            if word in _STOPWORDS:
                continue
            occurrence_count[word] += 1
            weight_sum[word] = weight_sum.get(word, 0.0) + weight

    tags = {
        word: weight_sum[word]
        for word, count in occurrence_count.items()
        if count >= _MIN_OCCURRENCES
    }
    top = sorted(tags.items(), key=lambda kv: kv[1], reverse=True)[:_MAX_TAGS]
    return dict(top)


def build_tag_filters(title_col, tags: Iterable[str], min_matches: int = 2) -> list:
    """SQL-условия для переданных тегов вкуса — совпадение НЕСКОЛЬКИХ
    (min_matches) тегов в одном названии ОДНОВРЕМЕННО.

    Одно совпадающее слово само по себе не значит "тот же дух" — теги
    вытаскиваются статистически из истории и часто содержат неоднозначные
    "тематические" слова (например "гей"), которые встречаются и в
    совершенно посторонних треках на ту же тему (серьёзные песни про геев,
    иностранные совпадения по подстроке "Gây"), а не только в русском
    мем-контенте, который пользователь реально слушает.

    Поэтому лоне-тег НЕ используется как самостоятельный фильтр-пылесос:
    если у юзера меньше min_matches значимых тегов — тег-матчинг не даёт
    условий вовсе (return []), и подбор опирается на артистов + радио-сиды.
    Когда тегов хватает, требуем пару (напр. "сво" И "гей") — это отсекает
    случайные одиночные совпадения и оставляет специфичный русский мем."""
    from itertools import combinations

    from sqlalchemy import and_, func

    tags = list(tags)
    if len(tags) < min_matches:
        return []
    return [
        and_(*(func.lower(title_col).like(f"%{tag.lower()}%") for tag in combo))
        for combo in combinations(tags, min_matches)
    ]
