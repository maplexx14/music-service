"""Мейнстрим-фильтр: хиты известных артистов, глубокий каталог — любимым."""

import asyncio

import pytest

from app import mainstream
from app.cache import clear_pattern, get_cache


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    clear_pattern("mainstream:*")
    monkeypatch.setenv("LASTFM_API_KEY", "test-key")
    yield
    clear_pattern("mainstream:*")


def _norm(name):
    return name.strip().lower()


def test_is_hit_requires_known_artist_and_top_title():
    info = {"listeners": 90_000, "top": ["Мама, я люблю", "Gone Forever (Remastered)"]}
    assert mainstream.is_hit(info, "мама, я люблю", _norm)
    assert mainstream.is_hit(info, "gone forever", _norm)
    assert not mainstream.is_hit(info, "deep cut", _norm)
    assert not mainstream.is_hit({**info, "listeners": 45_000}, "мама, я люблю", _norm)
    assert not mainstream.is_hit(None, "мама, я люблю", _norm)
    # Короткое название префиксом не совпадает.
    assert not mainstream.is_hit({"listeners": 10**6, "top": ["Go"]}, "gone", _norm)


def _fake_call(responses, calls):
    async def _call(client, method, artist, **params):
        calls.append((method, artist))
        return responses[(method, artist)]

    return _call


def test_artist_hits_fetch_cache_and_not_found(monkeypatch):
    calls = []
    monkeypatch.setattr(mainstream, "_call", _fake_call({
        ("artist.getinfo", "Anacondaz"): {"artist": {"stats": {"listeners": "92245"}}},
        ("artist.gettoptracks", "Anacondaz"): {"toptracks": {"track": [{"name": "Мама, я люблю"}]}},
        ("artist.getinfo", "nobody"): {"error": 6, "message": "not found"},
        ("artist.gettoptracks", "nobody"): {"error": 6, "message": "not found"},
    }, calls))

    result = asyncio.run(mainstream.artist_hits(["Anacondaz", "nobody"], timeout=5))
    assert result["anacondaz"] == {"listeners": 92245, "top": ["Мама, я люблю"]}
    assert result["nobody"] == {"listeners": 0, "top": []}

    calls.clear()
    assert asyncio.run(mainstream.artist_hits(["anacondaz"], timeout=5))["anacondaz"]["listeners"] == 92245
    assert calls == []


def test_rate_limit_is_not_cached(monkeypatch):
    monkeypatch.setattr(mainstream, "_call", _fake_call({
        ("artist.getinfo", "busy"): {"error": 29, "message": "rate limit"},
        ("artist.gettoptracks", "busy"): {"toptracks": {"track": []}},
    }, []))

    assert asyncio.run(mainstream.artist_hits(["busy"], timeout=5)) == {"busy": None}
    assert get_cache("mainstream:artist:v1:busy") is None


def test_slow_lookup_returns_unknown_and_warms_cache(monkeypatch):
    async def _slow(client, method, artist, **params):
        await asyncio.sleep(0.2)
        if method == "artist.getinfo":
            return {"artist": {"stats": {"listeners": "100000"}}}
        return {"toptracks": {"track": [{"name": "Hit"}]}}

    monkeypatch.setattr(mainstream, "_call", _slow)

    async def scenario():
        first = await mainstream.artist_hits(["slow"], timeout=0.01)
        await asyncio.sleep(0.4)
        second = await mainstream.artist_hits(["slow"], timeout=0.01)
        return first, second

    first, second = asyncio.run(scenario())
    assert first == {"slow": None}
    assert second["slow"] == {"listeners": 100000, "top": ["Hit"]}


def test_without_key_nothing_is_fetched(monkeypatch):
    monkeypatch.delenv("LASTFM_API_KEY")

    async def _boom(*args, **kwargs):
        raise AssertionError("network")

    monkeypatch.setattr(mainstream, "_call", _boom)
    assert asyncio.run(mainstream.artist_hits(["x"], timeout=1)) == {"x": None}


def test_similar_artists_cached_and_not_found(monkeypatch):
    calls = []

    async def _call(client, method, artist, **params):
        calls.append(artist)
        if artist == "ghost":
            return {"error": 6, "message": "not found"}
        return {"similarartists": {"artist": [{"name": "Seether"}, {"name": "Breaking Benjamin"}]}}

    monkeypatch.setattr(mainstream, "_call", _call)

    assert asyncio.run(mainstream.similar_artists("Three Days Grace")) == ["Seether", "Breaking Benjamin"]
    assert asyncio.run(mainstream.similar_artists("three days grace")) == ["Seether", "Breaking Benjamin"]
    assert asyncio.run(mainstream.similar_artists("ghost")) == []
    assert asyncio.run(mainstream.similar_artists("ghost")) == []
    assert calls == ["Three Days Grace", "ghost"]
