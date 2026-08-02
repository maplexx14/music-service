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

    # Смешанный вкус — язык не сигнал. Но у юзера с выраженным вкусом
    # (артисты/жанры) незнакомый артист с неопределимым жанром всё равно не
    # проходит: сигналов не осталось ни одного, а «не противоречит» — не
    # подтверждение (см. has_taste в taste.py).
    mixed = _rap_check(prefer_cyrillic=None)
    assert not mixed("Rick Astley", "Never Gonna Give You Up")
    # Настоящий холодный старт (вкуса нет вообще) — пропускаем, иначе новому
    # юзеру показывать было бы нечего.
    cold = make_relevance_check(trusted_artist_keys=set(), user_genres=set())
    assert cold("Rick Astley", "Never Gonna Give You Up")


def test_keywords_match_whole_word_only():
    """Регрессия: `kw in text` матчил слово ВНУТРИ другого слова.

    У любителя рэпа ключевое слово "trap" совпадало с ню-метал-группой Trapt,
    и она оказывалась ЕДИНСТВЕННЫМ, что проходило вкусовой фильтр из радио.
    """
    keep = _rap_check(prefer_cyrillic=None, keywords=["rap", "trap"])
    assert not keep("Trapt", "Headstrong")
    assert not keep("Some Band", "Grape Juice")
    # Слово целиком — по-прежнему сигнал.
    assert keep("Actual Rapper", "Real Rap Anthem")


def test_provenance_passes_similar_artist():
    """Кандидат добыт расширением курированного артиста (радио/граф артистов).

    Родословная и есть сигнал: у похожего артиста нет ни genre в метаданных, ни
    жанрового слова в названии, поэтому без provenance_trusted фильтр вырезал
    ПОХОЖИХ подчистую и в волне оставались только уже выбранные юзером артисты.
    """
    related = _rap_check(prefer_cyrillic=None, keywords=["rap", "trap"], provenance_trusted=True)
    plain = _rap_check(prefer_cyrillic=None, keywords=["rap", "trap"])
    assert related("OG BUDA", "Париж")
    assert not plain("OG BUDA", "Париж"), "тест бессмысленен: трек проходит и без провенанса"

    # Провенанс сильнее языкового прокси: похожий артист на «неродном» для
    # библиотеки языке — это и есть искомое новое, резать его нельзя.
    ru_only = _rap_check(prefer_cyrillic=True, provenance_trusted=True)
    assert ru_only("Yeat", "Rich Minion")

    # Но не отменяет жёсткие гейты.
    assert not related("K8V", "Ai Đưa Em Về")  # чужая письменность
    assert not related("Some Star", "Dirty Teen Pop Superstars")  # жанр не совпал


def test_require_signal_beats_provenance():
    """Добор глобально популярным родословной не имеет — там строгость выше."""
    strict = _rap_check(
        prefer_cyrillic=None, require_signal=True, provenance_trusted=True
    )
    assert not strict("Whoever", "Some Untagged Track")
    assert strict("madk1d", "Some Untagged Track")


def test_require_signal_rejects_unconfirmed():
    """Для добора «ничем не связанным» нужен ПОЛОЖИТЕЛЬНЫЙ сигнал.

    Мягкая проверка пропускает трек по грубому сигналу (совпал доминирующий
    язык библиотеки), строгая — нет: у добора глобально популярным связи со
    вкусом не бывает вовсе, и там нужно именно подтверждение.
    """
    soft = _rap_check(prefer_cyrillic=True)
    strict = _rap_check(prefer_cyrillic=True, require_signal=True)
    assert soft("нексюша", "Айтишник")
    assert not strict("нексюша", "Айтишник")
    # Доверенный артист проходит даже в строгом режиме.
    assert strict("madk1d", "Some Untagged Track")
    # Трек совсем без сигналов не проходит ни в одном режиме.
    assert not soft("Whoever", "Some Untagged Track")


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
