"""Проверка вкусового фильтра (app/taste.py) и привязки жанра к артисту.

Сценарии взяты из реального бага: слушателю русского рэпа в рекомендации
попадали поп/ретро — через (1) подстрочный матчинг ключевого слова внутри
другого слова и (2) добор популярным, где у трека жанр неопределим.
"""

from app.artist_genre import artists_matching_keywords
from app.lang import dominant_is_cyrillic
from app.taste import make_relevance_check, track_check

from tests.test_recommendations import _track


def _rap_check(**kw):
    return make_relevance_check(
        trusted_artist_keys={"madk1d"},
        user_genres={"hip-hop", "trap"},
        **kw,
    )


def test_trusted_artist_passes_regardless():
    keep = _rap_check(prefer_cyrillic=True)
    # Латиница + неопределимый жанр, но артист курирован юзером.
    assert keep("madk1d", "true adam")


def test_incompatible_genre_rejected():
    keep = _rap_check()
    # "pop" в названии — жанр определяется и не входит во вкус.
    assert not keep("Some Star", "Dirty Gay Teen Pop Superstars")


def test_foreign_script_rejected():
    keep = _rap_check()
    assert not keep("K8V", "Ai Đưa Em Về - Tia ft. Lê Thiện Hiếu")


def test_language_decides_when_genre_unknown():
    """Жанр неопределим — решает доминирующий язык библиотеки."""
    ru = _rap_check(prefer_cyrillic=True)
    assert ru("нексюша", "Айтишник")
    assert not ru("Rick Astley", "Never Gonna Give You Up")

    # У англоязычного юзера — ровно наоборот (язык не захардкожен).
    en = _rap_check(prefer_cyrillic=False)
    assert en("Rick Astley", "Never Gonna Give You Up")
    assert not en("нексюша", "Айтишник")

    # Смешанный вкус — язык не сигнал, не режем.
    mixed = _rap_check(prefer_cyrillic=None)
    assert mixed("Rick Astley", "Never Gonna Give You Up")


def test_require_signal_rejects_unconfirmed():
    """Для добора «ничем не связанным» нужен ПОЛОЖИТЕЛЬНЫЙ сигнал.
    Без require_signal неопределимый жанр проходит (~99% каталога)."""
    soft = _rap_check(prefer_cyrillic=None)
    strict = _rap_check(prefer_cyrillic=None, require_signal=True)
    assert soft("Whoever", "Some Untagged Track")
    assert not strict("Whoever", "Some Untagged Track")
    # Доверенный артист проходит даже в строгом режиме.
    assert strict("madk1d", "Some Untagged Track")


def test_dominant_language():
    ru = [f"трек {i} про рэп" for i in range(9)] + ["english title"]
    assert dominant_is_cyrillic(ru) is True
    assert dominant_is_cyrillic([f"english {i}" for i in range(12)]) is False
    # Пополам — сигнала нет; мало данных — тоже.
    half = [f"русский {i}" for i in range(6)] + [f"english {i}" for i in range(6)]
    assert dominant_is_cyrillic(half) is None
    assert dominant_is_cyrillic(["русский трек"]) is None


def test_keyword_matches_whole_word_only(db):
    """`rap` не должен матчить "pornogRAPhy", `pop` — "Big POPpa".
    Иначе привязка жанра к артисту тянула в выдачу ВЕСЬ чужой каталог."""
    _track(db, "Violent Pornography", "System Of A Down")
    _track(db, "Big Poppa", "The Notorious B.I.G.")
    _track(db, "Real Rap Anthem", "Actual Rapper")

    matched = artists_matching_keywords(db, ["rap", "pop"])
    assert "actual rapper" in matched
    assert "system of a down" not in matched
    assert "the notorious b.i.g." not in matched


def test_track_check_accepts_orm_track(db):
    """track_check работает на ORM-объекте (и учитывает явный genre)."""
    keep = track_check(_rap_check(prefer_cyrillic=True))
    assert keep(_track(db, "Толпы", "madk1d"))
    assert not keep(_track(db, "Wheel of Fortune", "Ace of Base", genre="Pop"))
