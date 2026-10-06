"""Карточки артистов для сетки выбора любимых (artist_cards.py).

Проверяем без сети: фото берётся только у совпавшего по имени артиста (чужое
фото хуже пустого), похожие не повторяют уже показанных, а сбой Deezer не
кэшируется как «артиста нет».
"""

import asyncio
from unittest import mock

import pytest

from app import artist_cards


@pytest.fixture
def cache():
    store = {}

    async def get(key):
        return store.get(key)

    async def put(key, value, expire=0):
        store[key] = value

    with mock.patch.object(artist_cards, "get_cache_async", get), mock.patch.object(
        artist_cards, "set_cache_async", put
    ):
        yield store


def _artist(id_, name, fans=100):
    return {"id": id_, "name": name, "nb_fan": fans, "picture_big": f"https://cdn-images.dzcdn.net/{id_}.jpg"}


def _api(responses):
    calls = []

    async def fake(path, params=None):
        calls.append(path)
        return responses.get(path)

    return fake, calls


def test_card_only_for_matching_artist(cache):
    fake, _ = _api({"/search/artist": {"data": [_artist(1, "Someone Else"), _artist(2, "Zemfira", 175279)]}})
    with mock.patch.object(artist_cards, "_api_get", fake):
        card = asyncio.run(artist_cards.artist_card("Земфира"))
    # Имя остаётся пользовательским, фото и фанаты — от совпавшего артиста.
    assert card == {"name": "Земфира", "cover_url": "https://cdn-images.dzcdn.net/2.jpg", "fans": 175279, "deezer_id": 2}


def test_no_match_gives_bare_card(cache):
    fake, _ = _api({"/search/artist": {"data": [_artist(1, "Someone Else")]}})
    with mock.patch.object(artist_cards, "_api_get", fake):
        card = asyncio.run(artist_cards.artist_card("Nobody"))
    assert card["cover_url"] is None and card["fans"] == 0


def test_api_failure_not_cached(cache):
    fake, calls = _api({})
    with mock.patch.object(artist_cards, "_api_get", fake):
        asyncio.run(artist_cards.artist_card("Ed Sheeran"))
        asyncio.run(artist_cards.artist_card("Ed Sheeran"))
    assert calls == ["/search/artist", "/search/artist"]
    assert not cache


def test_similar_skips_shown_and_caches_neighbours(cache):
    fake, calls = _api({
        "/search/artist": {"data": [_artist(10, "Ed Sheeran")]},
        "/artist/10/related": {"data": [
            _artist(11, "Sam Smith"), _artist(12, "Ed Sheeran"),
            _artist(13, "Coldplay"), _artist(14, "Maroon 5"), _artist(15, "OneRepublic"),
        ]},
    })
    with mock.patch.object(artist_cards, "_api_get", fake):
        similar = asyncio.run(artist_cards.similar_cards("Ed Sheeran", 3, exclude=["sam smith"]))
        # Сосед уже в кэше карточек — клик по нему не ищет его заново.
        asyncio.run(artist_cards.artist_card("Coldplay"))
    assert [c["name"] for c in similar] == ["Coldplay", "Maroon 5", "OneRepublic"]
    assert calls == ["/search/artist", "/artist/10/related"]
