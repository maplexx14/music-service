"""Единая проверка «кандидат в духе вкуса пользователя».

Раньше эта проверка была размазана по трём местам (пул в recommendations.py,
_keep и _matches_taste в flow.py), и каждое чинилось отдельно — поэтому дырка,
закрытая в одном пути, оставалась открытой в остальных. Здесь она одна.

Порядок сигналов — от самого надёжного к самому грубому:

1. Артист, которого юзер сам курировал (лайк/плейлист/явное предпочтение) —
   безусловное «да», без оглядки на язык и жанр.
2. Явно чужая письменность (CJK, вьетнамская диакритика…) — безусловное «нет».
3. Жанр (явный или угаданный по названию) не совпадает с жанрами вкуса — «нет».
4. Жанр определить НЕ удалось и артист незнакомый — единственный оставшийся
   сигнал это язык. genre заполнен у ~1% каталога, поэтому пункт 3 на таком
   треке молча пропускает всё, и раньше именно сюда протекало постороннее
   (Ace of Base, Rick Astley, Joan Jett слушателям русского рэпа).

Язык применяется ТОЛЬКО в пункте 4 и только если библиотека юзера явно
одноязычная. Как общий фильтр он не годится: у слушателя русского рэпа треть
библиотеки — латиницей в названии ("FORTUNA 812 — true adam"), и жёсткое
требование кириллицы вырезало бы релевантное вместе с посторонним.
"""
from typing import Optional

from app.artist_utils import artist_key
from app.genre_keywords import genre_is_compatible, infer_genre_from_text
from app.lang import is_cyrillic, is_foreign_script


def make_relevance_check(
    trusted_artist_keys: set,
    user_genres: set,
    prefer_cyrillic: Optional[bool] = None,
    keywords: Optional[list] = None,
    require_signal: bool = False,
):
    """Возвращает предикат (artist, title, genre) -> bool. См. модульный docstring.

    prefer_cyrillic: True/False/None — доминирующий язык библиотеки юзера
    (lang.dominant_is_cyrillic). None означает «смешанный вкус, язык не сигнал».
    keywords: тематические слова вкуса — последний резерв, когда ни жанр, ни
    язык ничего не говорят (сохраняет прежнее поведение радио в flow.py).
    require_signal: требовать ПОЛОЖИТЕЛЬНОГО подтверждения вкуса, а не просто
    отсутствия противоречия. Нужно там, где кандидат не связан со вкусом вообще
    ничем — добор глобально популярным: у трека с неопределимым жанром (а это
    ~99% каталога) обычная проверка сказала бы «не противоречит» и пропустила
    любой хит. Для основного пула наоборот нужна мягкая проверка: там кандидат
    уже пришёл по артисту/тегу/жанру, и требование второго сигнала вырезало бы
    релевантное.
    """
    trusted = trusted_artist_keys or set()
    genres = user_genres or set()
    kws = [k.lower() for k in (keywords or [])]

    def keep(artist: str, title: str, genre=None) -> bool:
        if artist_key(artist) in trusted:
            return True
        if is_foreign_script(title):
            return False
        detected = genre or infer_genre_from_text(title, artist)
        if detected is not None:
            return genre_is_compatible(detected, title, artist, genres)
        # Жанр неопределим — остаются только грубые сигналы.
        if require_signal:
            return False
        if prefer_cyrillic is not None:
            return is_cyrillic(f"{title} {artist}") == prefer_cyrillic
        if kws:
            text = f"{title} {artist}".lower()
            return any(kw in text for kw in kws)
        # Ни одного сигнала — не режем вслепую (иначе холодный старт пуст).
        return True

    return keep


def track_check(keep):
    """Тот же предикат, но принимающий ORM-Track/ExternalTrackResponse."""

    def keep_track(t) -> bool:
        return keep(t.artist, t.title, getattr(t, "genre", None))

    return keep_track
