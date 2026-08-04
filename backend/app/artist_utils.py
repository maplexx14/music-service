"""Общие утилиты для нормализации имён артистов.

Используются в recommendations.py, flow.py, diversity.py, ytdlp.py и
artists.py для единообразного сравнения имён артистов из разных источников
(SoundCloud/YT Music отдают одно имя в разном регистре/формате).
"""
import re


def artist_key(name: str) -> str:
    """Нормализованный ключ артиста: lowercase, trim, одинарные пробелы."""
    return re.sub(r"\s+", " ", (name or "").strip().lower())


def norm_artist_name(name: str) -> str:
    """Имя артиста в сравнимый вид: регистр, пунктуация, лишние пробелы."""
    s = re.sub(r"[^\w\s]", " ", (name or "").lower())
    return re.sub(r"\s+", " ", s).strip()


def query_names_artist(q: str, artist: str) -> bool:
    """Запрос — это имя артиста, а не что-то другое?

    Сравниваем по словам, а не строкой целиком: «weeknd» — это The Weeknd, а
    точное равенство такой запрос отбросило бы. Требуем, чтобы КАЖДОЕ слово
    запроса было словом имени — так название трека («numb») каталог артиста не
    подтянет, даже если поиск по артистам что-то на него вернул.
    """
    query_words = set(norm_artist_name(q).split())
    artist_words = set(norm_artist_name(artist).split())
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
