"""Общие утилиты для нормализации имён артистов.

Используются в recommendations.py, flow.py, diversity.py, ytdlp.py и
artists.py для единообразного сравнения имён артистов из разных источников
(SoundCloud/YT Music отдают одно имя в разном регистре/формате).
"""
import re
from typing import Optional


def artist_key(name: str) -> str:
    """Нормализованный ключ артиста: lowercase, trim, одинарные пробелы."""
    return re.sub(r"\s+", " ", (name or "").strip().lower())


def norm_artist_name(name: str) -> str:
    """Имя артиста в сравнимый вид: регистр, пунктуация, лишние пробелы."""
    s = re.sub(r"[^\w\s]", " ", (name or "").lower())
    return re.sub(r"\s+", " ", s).strip()


# Кириллица → латиница. Один артист живёт в выдаче под двумя написаниями: в
# медиатеке «Zemfira» (так пришло из SoundCloud), в YouTube Music «Земфира».
# Пока имена сравниваются побайтно, поиск показывает две карточки на одного
# артиста, а страница латинского написания не находит ни каталога YT Music
# (ytdlp сверяет найденное имя с запросом), ни собственных треков.
_CYRILLIC_TO_LATIN = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "yo",
    "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "shch",
    "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
    # Украинский/белорусский: те же выдачи, те же дубли.
    "і": "i", "ї": "yi", "є": "ye", "ґ": "g", "ў": "u",
}


def to_latin(name: str) -> str:
    """Имя латиницей: кириллица транслитерируется, латиница остаётся как есть."""
    return "".join(_CYRILLIC_TO_LATIN.get(ch, ch) for ch in (name or "").lower())


# Схемы романизации расходятся в считаных местах: й/ы → y или i, я → ya/ia/ja,
# ж → zh или j, х → kh или h, щ → shch или sch, ц → ts или c. Свод к одному
# виду делает сравнение независимым от того, кто именно писал имя латиницей.
#
# Диграфы заменяются первыми: иначе следующие правила разберут их по буквам —
# «zh» → «j» → «i», проглоченная ж, и «Жанна» совпала бы с «Анной». Замена —
# пунктуация, а не буква и не цифра: буква попала бы под следующие правила, а
# цифра столкнулась бы с цифрой из самого имени («Би-2»). Пунктуацию же
# norm_artist_name уже вырезал, из имени она прийти не может.
_FOLD_DIGRAPHS = (
    (r"shch|shh|sch", "~"),  # щ
    (r"zh", "@"),            # ж
    (r"sh", "#"),            # ш
    (r"ch", "$"),            # ч
    (r"ts|tc", "%"),         # ц
    (r"kh|h", "^"),          # х
)
_FOLD_TAIL = (
    (r"x", "ks"),   # Max ↔ Макс
    (r"j", "i"),    # j как й: Julia ↔ Юлия
)
# Скольжение «й/и» перед гласной: Мария = Mariya = Maria = Mariia. Весь
# набег [yi] перед гласной сводится к одному «i» — этого хватает, чтобы
# написания совпали, и при этом «Mia» не схлопывается с «Ma»: без гласной
# следом правило не срабатывает вовсе.
_GLIDE_RE = re.compile(r"[yi]+(?=[aeou])")


def translit_key(name: str) -> str:
    """Ключ «тот же артист» вне зависимости от алфавита и схемы романизации.

    «Земфира» и «Zemfira», «Каспийский груз» и «Kaspiyskiy Gruz» дают один
    ключ. Огрубление намеренно однобокое: лучше не склеить два написания
    (пользователь увидит две карточки, как сейчас), чем склеить двух разных
    артистов. Поэтому неоднозначное «c» → «к» не делаем: оно свело бы вместе
    самостоятельные латинские имена (Cara и Kara), а выигрыш — редкое
    «Victor» вместо обычного «Viktor».
    """
    s = to_latin(norm_artist_name(name))
    for pattern, repl in _FOLD_DIGRAPHS + _FOLD_TAIL:
        s = re.sub(pattern, repl, s)
    s = _GLIDE_RE.sub("i", s).replace("y", "i")
    # Удвоение — вопрос вкуса транскрибирующего (Molli/Molly/Moli), не имени.
    return re.sub(r"(.)\1+", r"\1", s)


def same_artist(left: str, right: str) -> bool:
    """Два имени — один артист (с точностью до алфавита и романизации)?"""
    key = translit_key(left)
    return bool(key) and key == translit_key(right)


def query_names_artist(q: str, artist: str) -> bool:
    """Запрос — это имя артиста, а не что-то другое?

    Сравниваем по словам, а не строкой целиком: «weeknd» — это The Weeknd, а
    точное равенство такой запрос отбросило бы. Требуем, чтобы КАЖДОЕ слово
    запроса было словом имени — так название трека («numb») каталог артиста не
    подтянет, даже если поиск по артистам что-то на него вернул.

    Слова сводятся к translit_key: запрос «Zemfira» должен опознавать артиста
    «Земфира», иначе её каталог и треки достаются только одному написанию.
    """
    query_words = {translit_key(w) for w in norm_artist_name(q).split()}
    artist_words = {translit_key(w) for w in norm_artist_name(artist).split()}
    return bool(query_words) and query_words <= artist_words


# Разделители в строке исполнителя: «A, B», «A & B», «A feat. B», «A x B».
# Нужны, чтобы у каждого участника коллаборации была своя страница, а не одна
# общая на всю склеенную строку (ytmusic отдаёт участников именно через ", ").
# Точку в «feat.» съедаем явным \s|$ вместо \b: между «.» и пробелом границы
# слова нет, и «feat.» резалось как «feat» + осиротевшая точка в имени.
# «/» в разделители НЕ входит: это часть имён вроде AC/DC, а как склейка
# практически не встречается.
_ARTIST_SPLIT_RE = re.compile(
    r"\s*(?:"
    r",|;|&|·|•"
    r"|\bfeat\.?(?=\s|$)"
    r"|\bft\.?(?=\s|$)"
    r"|\bwith(?=\s)"
    r"|\bvs\.?(?=\s|$)"
    r"|(?<=\s)x(?=\s)"
    r")\s*",    re.IGNORECASE,
)


def split_artists(name: str) -> list[str]:
    """Разбивает строку исполнителя на отдельные имена.

    Пустые куски и дубли (с точностью до artist_key) отбрасываем; если после
    разбора ничего не осталось — возвращаем исходную строку как есть, чтобы у
    трека всегда был хотя бы один кликабельный исполнитель.
    """
    parts: list[str] = []
    seen: set[str] = set()
    for raw in _ARTIST_SPLIT_RE.split(name or ""):
        piece = raw.strip(" -–—")
        key = artist_key(piece)
        if not key or key in seen:
            continue
        seen.add(key)
        parts.append(piece)
    if parts:
        return parts
    fallback = (name or "").strip()
    return [fallback] if fallback else []


# --- «Артист - Название» в заголовке трека («артисты-загрузчики») -----------
#
# SoundCloud полон каналов-перезаливщиков: аккаунт сам ничего не исполняет, а
# выкладывает чужое, указывая настоящего исполнителя прямо в названии трека —
# «Kordhell - Murder In My Mind». Имя такого аккаунта исполнителем не является:
# без разбора одна витрина уезжала в медиатеку «артистом» сотни чужих треков,
# её страница собирала музыку разных людей, а профиль вкуса получал имя,
# которого пользователь никогда не слушал.
#
# Разбор намеренно осторожный: принять часть названия за артиста дороже, чем не
# опознать перезаливщика (первое портит и страницу артиста, и профиль вкуса,
# второе лишь сохраняет нынешнее поведение), поэтому всё сомнительное
# остаётся как есть — исполнителем становится аккаунт. Известный остаточный
# промах — префикс релиза вместо имени («Succession - Andante Risoluto», где
# исполнитель Nicholas Britell); его снимают метаданные провайдера
# (publisher_metadata.artist / album_title), когда они есть.

# Разделитель — только с пробелами по краям: «Sub-Zero» и «K-391» не должны
# разъезжаться на артиста и название.
_TITLE_SPLIT_RE = re.compile(r"\s+[-–—―‒]\s+|\s+\|\s+")

# Промо-обвязка перед именем: «[FREE] Artist - Title», «PREMIERE: Artist -
# Title», «FREE DL | Artist - Title».
_PROMO = (
    r"free(?:\s*(?:dl|d/l|download|release))?|premieres?|exclusive|out\s*now"
    r"|new|unreleased|teaser|snippet|preview|repost|sponsored"
    r"|премьера|эксклюзив|новинка|бесплатно"
)
_PROMO_PREFIX_RE = re.compile(
    r"^\s*(?:"
    r"[\(\[{]\s*(?:" + _PROMO + r")[^)\]}]{0,24}[)\]}]"
    r"|(?:" + _PROMO + r")\s*[:|]"
    r")\s*",
    re.IGNORECASE,
)

# Левая часть, которая исполнителем быть не может: номер дорожки, промо-слово.
_NOT_ARTIST_RE = re.compile(
    r"^(?:\d{1,3}[.)]?|track\s*\d+|" + _PROMO + r")$", re.IGNORECASE
)

# Правая часть — только пометка версии: значит слева НЕ артист, а название
# трека («Midnight City - Extended Mix»).
_VERSION_ONLY_RE = re.compile(
    r"^(?:(?:extended|original|radio|club|dub|vip|instrumental|acoustic|live"
    r"|dirty|clean|slowed|reverb|sped\s*up|nightcore|festival|bass|tech|deep"
    r"|future|hard)\s+){0,2}"
    r"(?:mix|edit|remix|version|master|remaster(?:ed)?|cut|bootleg|flip|dub"
    r"|vip|intro|outro|interlude|snippet|preview|demo|instrumental|acapella"
    r"|single|ep|lp)$",
    re.IGNORECASE,
)

# Имя исполнителя короткое: длинная левая часть — это описание релиза, а не имя.
_ARTIST_TITLE_MAX_WORDS = 6
_ARTIST_TITLE_MAX_CHARS = 50


def split_title_artist(title: str) -> Optional[tuple[str, str]]:
    """«Артист - Название» → (артист, название). None, если разбор ненадёжен."""
    raw = _PROMO_PREFIX_RE.sub("", title or "").strip()
    parts = _TITLE_SPLIT_RE.split(raw, maxsplit=1)
    if len(parts) != 2:
        return None
    artist, rest = (part.strip(" -–—―‒|") for part in parts)
    if not artist or not rest:
        return None
    if len(artist) > _ARTIST_TITLE_MAX_CHARS:
        return None
    if len(artist.split()) > _ARTIST_TITLE_MAX_WORDS:
        return None
    if _NOT_ARTIST_RE.match(artist) or _VERSION_ONLY_RE.match(rest):
        return None
    return artist, rest


def resolve_track_artist(
    title: str,
    uploader: str = "",
    declared: str = "",
    album: str = "",
) -> tuple[str, str]:
    """(исполнитель, название) для трека, у которого известен лишь аккаунт.

    declared — исполнитель из метаданных провайдера (у SoundCloud это
    publisher_metadata.artist): он авторитетнее и аккаунта, и разбора названия.
    album — релиз оттуда же: если именно он стоит префиксом в заголовке, слева
    не исполнитель. uploader — имя аккаунта, последний резерв.
    """
    title = (title or "").strip()
    declared = (declared or "").strip()
    split = split_title_artist(title)
    if split and album and same_artist(split[0], album):
        split = None  # префикс — название релиза, а не имя исполнителя
    if declared:
        # Префикс дублирует исполнителя («Kordhell - Murder In My Mind» при
        # publisher_metadata.artist = «Kordhell») — в названии он лишний.
        if split and same_artist(split[0], declared):
            return declared, split[1]
        return declared, title
    if split:
        return split
    return (uploader or "").strip() or "Unknown Artist", title


def effective_artist_title(
    title: str,
    artist: str,
    *,
    source: str = "",
    album: str = "",
) -> tuple[str, str]:
    """Resolve the artist/title pair used by recommendation signals.

    The parser is deliberately scoped to SoundCloud: on other providers a
    hyphen in a title is much more likely to be part of the actual title.
    """
    artist = str(artist or "").strip()
    title = str(title or "").strip()
    if str(source or "").strip().lower() != "soundcloud":
        return artist, title
    return resolve_track_artist(title, uploader=artist, album=str(album or ""))


def effective_track_artist_title(track) -> tuple[str, str]:
    """Return recommendation metadata without rewriting the stored track.

    Older SoundCloud imports may have persisted the uploader account in
    ``Track.artist`` while keeping the real artist in a title such as
    ``Artist - Track``.  New imports are already normalized, so this helper is
    intentionally idempotent and only applies the title parser to SoundCloud
    rows.  The raw ORM/provider object remains untouched for display and
    playback metadata.
    """
    return effective_artist_title(
        getattr(track, "title", "") or "",
        getattr(track, "artist", "") or "",
        source=getattr(track, "source", "") or "",
        album=getattr(track, "album", "") or "",
    )
