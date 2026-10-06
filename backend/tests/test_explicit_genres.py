"""Явно выбранные жанры в профиле вкуса (настройки/онбординг).

Раньше выбор весил как два трека истории и терялся у слушателя с длинной
историей, а поджанры Last.fm («russian rap», «grunge») не давали ключевых
слов вовсе: словарь знает только 12 веток. Проверяем, что выбор теперь держит
долю профиля, сводится к ветке и попадает в ключевые слова сверх тройки
частых.
"""

from collections import Counter

from app import genre_keywords
from app.genre_keywords import (
    EXPLICIT_GENRE_SHARE,
    GENRE_KEYWORDS,
    top_genre_keywords,
    weighted_explicit_genres,
)
from app.recommendation_scoring import content_match


def test_explicit_genres_keep_minimum_weight_on_cold_start():
    assert weighted_explicit_genres(["phonk", "jazz"], 0) == ["phonk", "phonk", "jazz", "jazz"]


def test_explicit_genres_scale_with_history():
    history = ["hip-hop"] * 300
    explicit = weighted_explicit_genres(["jazz", "rock"], len(history))
    share = len(explicit) / (len(history) + len(explicit))
    # Не меньше заявленной доли (округление вверх может дать чуть больше).
    assert EXPLICIT_GENRE_SHARE <= share < EXPLICIT_GENRE_SHARE + 0.01
    assert Counter(explicit)["jazz"] == Counter(explicit)["rock"]


def test_explicit_genres_ignore_blanks_and_duplicates():
    assert weighted_explicit_genres(["Jazz", "jazz", "", None], 0) == ["jazz", "jazz"]


def test_subgenre_maps_to_branch_keywords(monkeypatch):
    monkeypatch.setattr(
        genre_keywords, "internal_genre_key",
        lambda g: {"russian rap": "hip-hop"}.get(g, g if g in GENRE_KEYWORDS else None),
    )
    assert top_genre_keywords({"russian rap": 4}) == GENRE_KEYWORDS["hip-hop"]


def test_explicit_genres_join_top_n(monkeypatch):
    """Длинная история заняла тройку частых — выбранный жанр всё равно даёт
    свои ключевые слова."""
    counts = {"hip-hop": 200, "rock": 150, "electronic": 100, "jazz": 2}
    keywords = top_genre_keywords(counts, explicit=["jazz"])
    assert set(GENRE_KEYWORDS["jazz"]) <= set(keywords)
    assert set(GENRE_KEYWORDS["hip-hop"]) <= set(keywords)


def test_content_match_by_branch(monkeypatch):
    from app import recommendation_scoring

    monkeypatch.setattr(
        recommendation_scoring, "internal_genre_key",
        lambda g: {"russian rap": "hip-hop", "hip-hop": "hip-hop"}.get(g),
    )
    # Выбран «russian rap», провайдер пометил трек просто «Hip-Hop».
    assert content_match({"genre": "Hip-Hop"}, ["russian rap"]) == 0.3
    assert content_match({"genre": "russian rap"}, ["russian rap"]) == 1.0
    assert content_match({"genre": "Jazz"}, ["russian rap"]) == 0.0
