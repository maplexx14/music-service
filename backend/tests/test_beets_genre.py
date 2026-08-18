"""Жанровый словарь beets (app/beets_genre.py) и его встройка в genre_keywords.

Сценарий, из которого выросла интеграция: у внешнего трека genre либо пуст,
либо свободная строка провайдера ("Dark Wave", "Eurodance", "Drum & Bass").
Наши 12 ключей её не знают, infer_genre_from_text возвращает None — и в
taste.py срабатывает пункт 4 «жанр неопределим», где кандидата проверяет только
грубый языковой прокси, а у provenance_trusted не проверяет вообще ничего.
Именно этим путём в волну и просачивалось постороннее.

Проверяем ровно две вещи: beets ДОБАВЛЯЕТ определения там, где раньше был None,
и при этом НЕ переопределяет наш словарь — ни спорные имена (trap у beets из
ветки UK garage!), ни защиту от ложных срабатываний в прозе.
"""

import pytest

from app import beets_genre
from app.genre_keywords import genre_is_compatible, infer_genre_from_text

requires_beets = pytest.mark.skipif(
    not beets_genre.available(), reason="beets не установлен в этом окружении"
)


@pytest.fixture(autouse=True)
def _reset_beets_cache():
    """canonical/to_internal мемоизированы на процесс — иначе тест, который
    подменяет доступность beets, отравляет кэш остальным."""
    beets_genre.reset_cache()
    yield
    beets_genre.reset_cache()


@requires_beets
def test_alias_table_normalizes_provider_spelling():
    """Написание провайдера → каноническое имя beets (aliases.yaml)."""
    assert beets_genre.canonical("Rock & Roll") == "rock and roll"
    assert beets_genre.canonical("Drum & Bass") == "drum and bass"
    assert beets_genre.canonical("RnB") == "r&b"
    # Строка "жанр и жанр" целиком в whitelist не попадает — разбираем по
    # разделителю и берём первую узнанную часть.
    assert beets_genre.canonical("Hip-Hop & Rap") == "hip hop"
    # Выдуманного жанра beets не знает — молчит, а не угадывает.
    assert beets_genre.canonical("совершенно выдуманный жанр") is None
    assert beets_genre.canonical("") is None


@requires_beets
def test_tree_rolls_unknown_genre_up_to_our_key():
    """Дерево наследования сводит незнакомое имя к одному из 12 ключей."""
    assert beets_genre.to_internal("Dark Wave") == "electronic"
    assert beets_genre.to_internal("Witch House") == "electronic"
    assert beets_genre.to_internal("Eurodance") == "electronic"
    assert beets_genre.to_internal("Rock & Roll") == "rock"
    assert beets_genre.to_internal("Classical Music") == "classical"
    # Цепочка наследования — это данные beets, а не наша догадка.
    assert "electronic" in beets_genre.lineage("dark wave")


@requires_beets
def test_our_reading_of_disputed_names_wins():
    """Расхождения с beets закреплены за нами (beets_genre._APP_OWNED).

    У beets trap — поджанр UK garage (trap → uk garage → electronic). Отдай мы
    решение дереву, слушателю рэпа поехало бы техно.
    """
    assert beets_genre.to_internal("Trap") == "trap"
    assert beets_genre.to_internal("trap music") == "trap"
    # Дерево beets при этом действительно ведёт trap в электронику — тест
    # бессмысленен, если это перестанет быть так.
    assert "electronic" in beets_genre.lineage("trap")
    # phonk beets не знает вовсе, а у нас это ключ №1.
    assert beets_genre.to_internal("Phonk") == "phonk"
    # lo-fi beets вешает под avant-garde, у нас это самостоятельный ключ.
    assert beets_genre.to_internal("Lo-Fi") == "lofi"


@requires_beets
def test_genre_outside_our_vocabulary_gives_no_opinion():
    """Жанр вне наших 12 ключей — это None («мнения нет»), а не «не подходит»."""
    assert beets_genre.to_internal("K-Pop") is None
    assert beets_genre.to_internal("Bluegrass") is None


@requires_beets
def test_compound_genre_in_title_is_now_detected():
    """Раньше здесь был None и кандидат уходил на языковую проверку."""
    assert infer_genre_from_text("Nostalgia - Dark Wave Mix") == "electronic"
    # Написание слитно тоже ловится: в whitelist "dark wave", слова внутри
    # имени соединены через [\\s\\-]* именно поэтому.
    assert infer_genre_from_text("Darkwave nostalgia") == "electronic"
    # "trip hop" наш словарь не знает (его "hip hop" по границе слова не
    # совпадает), а дерево beets ведёт его через downtempo в наш chill.
    assert infer_genre_from_text("Trip Hop Session") == "chill"


@requires_beets
def test_our_dictionary_is_asked_first():
    """Кириллица и фонк — наши, beets о них не знает и не должен вмешиваться."""
    assert infer_genre_from_text("Фонк ремикс") == "phonk"
    assert infer_genre_from_text("русский рэп", "исполнитель") == "hip-hop"
    # "trap" у нас свой ключ, а не электроника из дерева beets.
    assert infer_genre_from_text("Hard Trap Type Beat") == "trap"


@requires_beets
def test_single_words_in_prose_still_do_not_match():
    """Регрессия, которой болел genre_keywords: слово ВНУТРИ другого слова.

    В whitelist beets 1568 имён, среди них "house", "acid", "dub". По прозе
    ищем только СОСТАВНЫЕ имена — иначе "Warehouse Party" снова стал бы
    электроникой, а "Grape Juice" — рэпом.
    """
    assert infer_genre_from_text("Warehouse Party") is None
    assert infer_genre_from_text("Popular Song") is None
    assert infer_genre_from_text("Grape Juice") is None


@requires_beets
def test_unknown_provider_genre_reaches_the_right_listener():
    """genre_is_compatible: "Eurodance" больше не отбраковка для электроники.

    До интеграции своё «имя не узнал» означало False независимо от вкуса, то
    есть легитимный жанр вырезался у того, кто его как раз слушает.
    """
    assert genre_is_compatible("Eurodance", "Some Title", "Some Artist", {"electronic"})
    assert genre_is_compatible("Dark Wave", "Some Title", "Some Artist", {"electronic"})
    # И по-прежнему отбраковка для того, кто слушает другое.
    assert not genre_is_compatible("Eurodance", "Some Title", "Some Artist", {"hip-hop"})
    assert not genre_is_compatible("Bluegrass", "Some Title", "Some Artist", {"hip-hop"})
    # Пустой вкус — сверять не с чем, режем выдачу только осмысленно.
    assert genre_is_compatible("Eurodance", "Some Title", "Some Artist", set())


@requires_beets
def test_subgenres_are_real_names_from_the_tree():
    """Поджанры для разведки — настоящие имена, а не наши общие ключи."""
    names = beets_genre.subgenres({"hip-hop"})
    assert names, "дерево beets должно дать поджанры хип-хопа"
    assert "hip-hop" not in names and "hip hop" not in names
    assert "gangsta rap" in names and "old school hip hop" in names
    # Каждое имя каноническое (то есть из whitelist beets): в дереве есть и
    # служебные узлы-группировки вроде "east asian", по которым у провайдера
    # искать нечего.
    assert all(beets_genre.canonical(name) == name for name in names)

    # phonk и trap намеренно не спускаются по дереву: phonk его не знает, а
    # trap у beets из ветки UK garage.
    assert beets_genre.subgenres({"phonk"}) == []
    assert beets_genre.subgenres({"trap"}) == []
    assert beets_genre.subgenres(set()) == []


def test_without_beets_behaviour_is_exactly_as_before(monkeypatch):
    """Образ без beets — не отказ, а прежнее поведение.

    Не под skipif: это ровно тот случай, когда образ ещё не пересобран, и он
    обязан работать в любом окружении.
    """
    monkeypatch.setattr(beets_genre, "_load", lambda: None)

    assert beets_genre.available() is False
    assert beets_genre.canonical("Rock & Roll") is None
    assert beets_genre.to_internal("Dark Wave") is None
    assert beets_genre.lineage("dark wave") == []
    assert beets_genre.detect("Nostalgia - Dark Wave Mix") is None
    assert beets_genre.subgenres({"hip-hop"}) == []

    # Свой словарь работает как всегда, а всё, чего он не знает, снова None.
    assert infer_genre_from_text("Фонк ремикс") == "phonk"
    assert infer_genre_from_text("Nostalgia - Dark Wave Mix") is None
    assert not genre_is_compatible("Eurodance", "t", "a", {"electronic"})
