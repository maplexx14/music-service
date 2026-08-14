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

GENRE_KEYWORDS: dict = {
    "phonk": ["phonk", "фонк", "drift phonk", "funk"],
    "trap": ["trap", "трэп", "треп"],
    "hip-hop": ["rap", "hip hop", "hip-hop", "рэп", "хип-хоп", "хип хоп"],
    "rock": ["rock", "рок", "metal", "метал", "punk", "панк"],
    "electronic": [
        "edm", "techno", "техно", "dubstep", "дабстеп", "house", "хаус",
        "electro", "электро", "dnb", "drum and bass", "hardstyle",
    ],
    "lofi": ["lofi", "lo-fi", "lo fi"],
    "pop": ["pop", "поп"],
    "jazz": ["jazz", "джаз"],
    "classical": ["classical", "классика", "orchestra", "оркестр", "symphony", "симфони"],
    "reggae": ["reggae", "регги"],
    "folk": ["folk", "фолк", "народн"],
    "chill": ["chill", "ambient", "эмбиент", "релакс", "relax"],
}

# Читаемые подписи жанров для UI выбора предпочтений. Ключи совпадают
# с GENRE_KEYWORDS — именно ключи хранятся в User.preferred_genres.
GENRE_LABELS: dict = {
    "phonk": "Фонк",
    "trap": "Трэп",
    "hip-hop": "Хип-хоп / Рэп",
    "rock": "Рок",
    "electronic": "Электроника",
    "lofi": "Lo-Fi",
    "pop": "Поп",
    "jazz": "Джаз",
    "classical": "Классика",
    "reggae": "Регги",
    "folk": "Фолк",
    "chill": "Chill / Ambient",
}

# "remix"/"кавер"/"мэшап" и т.п. — не самостоятельный жанр и не тема, а
# слово-МОДИФИКАТОР формата. Само по себе оно ничего не сужает (ремиксов на
# платформе миллион), поэтому не должно ни определять жанр, ни быть
# самостоятельным тегом/ключевым словом матчинга (в title_tags._STOPWORDS
# оно исключено ровно поэтому). Запись оставлена как документация того, что
# эти слова намеренно не участвуют в подборе кандидатов.
#
# NB: была попытка использовать модификатор как обязательное co-условие
# («гей» И «ремикс») — откачена: у реального юзера ремиксы составляют <50%
# библиотеки (там ещё порно-аудио, вульгарные песни, «сво ремиксы» и т.п.),
# так что признак remix-доминантности не тот. Разделяет вкус скорее
# «русский мем-контент vs иностранное/серьёзное» — см. lang.is_foreign_script
# и требование пары тегов в title_tags.build_tag_filters.
MODIFIER_KEYWORDS: dict = {
    "remix": [
        "remix", "ремикс", "mashup", "мэшап", "bootleg",
        "cover", "кавер", "пародия", "parody",
    ],
}

# Матчим ключевое слово ТОЛЬКО как отдельное слово (границы \b), а не как
# подстроку: без этого "techno" ловил "Ayo Technology" (50 Cent → electronic),
# "house" — "warehouse", "pop" — "popular", "rap" — "grape" и т.п. Именно эти
# ложные срабатывания раздували редкий жанр (electronic) до топового и тянули
# в выдачу нерелевантные треки (afro/club house слушателю рэпа).
_KEYWORD_PATTERNS = {
    genre: re.compile(
        r"\b(?:" + "|".join(re.escape(kw) for kw in kws) + r")\b", re.IGNORECASE
    )
    for genre, kws in GENRE_KEYWORDS.items()
}


def infer_genre_from_text(title: str, artist: str = "") -> Optional[str]:
    """Возвращает первый жанр, чьи ключевые слова встретились в title/artist,
    либо None, если ничего не подошло. Слова-модификаторы (remix и т.п.)
    сами по себе жанром не считаются."""
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
    раздувать дальнейшие запросы десятками слов на разношёрстной истории.

    Слова-модификаторы (remix и т.п., см. MODIFIER_KEYWORDS) сюда намеренно
    НЕ подмешиваются — это блуждающее слово, которое совпадает с заголовками
    совершенно несвязанных треков (было заведено и тут же откачено — см.
    историю бага, когда вьетнамский трек с "Remix" в названии попадал в
    рекомендации гей-ремикс-слушателю именно через этот путь)."""
    if not genre_counts:
        return []
    top_genres = [g for g, _ in Counter(genre_counts).most_common(top_n)]
    keywords = []
    for genre in top_genres:
        keywords.extend(GENRE_KEYWORDS.get(genre, []))
    return keywords


def build_keyword_filters(title_col, genre_counts: dict, top_n: int = 3) -> list:
    """SQL-условия для top_n самых частых жанров вкуса.

    Матчим по ГРАНИЦЕ СЛОВА (Postgres regex ~* с \\y), а не подстрокой LIKE
    %kw%: иначе "house" совпадал с "warehouse", "techno" с "technology" и т.п.,
    протаскивая в кандидаты нерелевантные треки (см. _KEYWORD_PATTERNS)."""
    return [
        title_col.op("~*")(r"\y" + kw.lower() + r"\y")
        for kw in top_genre_keywords(genre_counts, top_n)
    ]


def genre_is_compatible(explicit_genre, title: str, artist: str, user_genres: set) -> bool:
    """Кандидат прошёл в выдачу по слабому сигналу (ключевое слово в
    названии, тег вкуса) — но это ничего не говорит о жанре самого трека:
    слово могло встретиться у совершенно другого по духу трека. Если жанр
    трека (явный или угаданный по названию) удаётся определить и он не
    входит в жанры вкуса пользователя — трек отбраковываем, а не тянем в
    рекомендации только по совпадению подстроки. Если жанр определить не
    удалось — пропускаем (нечего сверять, лучше не резать выдачу вслепую)."""
    if not user_genres:
        return True
    genre = explicit_genre or infer_genre_from_text(title, artist)
    if genre is None:
        return True
    normalized_user_genres = {
        str(value).strip().lower() for value in user_genres if value
    }
    normalized_genre = str(genre).strip().lower()
    if normalized_genre in normalized_user_genres:
        return True
    # Провайдеры часто присылают свободную строку вроде "Rock & Roll" вместо
    # внутреннего ключа "rock". Прогоняем метаданные через тот же словарь.
    inferred = infer_genre_from_text(normalized_genre)
    return inferred in normalized_user_genres if inferred else False
