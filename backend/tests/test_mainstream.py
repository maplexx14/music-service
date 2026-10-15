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


def test_hit_is_only_top_three():
    info = {"listeners": 500_000, "top": ["One", "Two", "Three", "Fourth Song", "Fifth Song"]}
    assert mainstream.is_hit(info, "three", _norm)
    assert not mainstream.is_hit(info, "fourth song", _norm)


def test_gate_refills_by_artist_fame_not_play_count():
    """У внешних кандидатов play_count пуст — добор по нему шёл в случайном
    порядке и пускал нишевых артистов с малоизвестными песнями."""
    infos = {
        "big": {"listeners": 2_000_000, "top": ["A", "B", "C", "Deep Hit", "E"]},
        "mid": {"listeners": 300_000, "top": ["X", "Y", "Z"]},
        "niche": {"listeners": 4_000, "top": ["Obscure"]},
    }
    items = [
        {"artist": "niche", "title": "obscure", "play_count": 0},
        {"artist": "mid", "title": "album track", "play_count": 0},
        {"artist": "big", "title": "deep hit", "play_count": 0},
        {"artist": "big", "title": "a", "play_count": 0},
    ]

    kept, hits = mainstream.gate(
        items,
        infos=infos,
        exempt=lambda item: False,
        artist_of=lambda item: item["artist"],
        title_of=lambda item: item["title"],
        norm_title=_norm,
        limit=3,
        popularity=lambda item: item["play_count"],
    )

    # Хит первым, затем топ-10 известного, затем по слушателям; нишевый —
    # только если места останутся.
    assert [(i["artist"], i["title"]) for i in kept] == [
        ("big", "a"), ("big", "deep hit"), ("mid", "album track"),
    ]
    assert sum(hits.values()) == 1
