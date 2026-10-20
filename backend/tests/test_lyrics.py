"""Прокси текстов к lrclib: выбор записи и кэш (routers/lyrics.py)."""

from app.cache import redis_client
from app.routers import lyrics


def _clear(artist, title, duration):
    redis_client.delete(f"lyrics:v1:{artist.lower()}|{title.lower()}|{duration}")


def test_search_prefers_synced_of_same_recording():
    results = [
        {"duration": 250, "syncedLyrics": "[00:01.00] live"},
        {"duration": 201, "syncedLyrics": "[00:01.00] album"},
    ]
    assert lyrics._pick_from_search(results, 200) == {"synced": "[00:01.00] album"}


def test_search_falls_back_to_plain_without_timestamps():
    results = [{"duration": 250, "syncedLyrics": "[00:01.00] live\n[00:02.50][00:09.00] again"}]
    assert lyrics._pick_from_search(results, 200) == {"plain": "live\nagain"}
    assert lyrics._pick_from_search("garbage", 200) == {}


def test_lyrics_endpoint_caches_result(client, monkeypatch):
    _clear("Artist", "Song", 200)
    calls = []

    async def fake_lookup(artist, title, duration):
        calls.append((artist, title, duration))
        return {"synced": "[00:01.00] hi"}

    monkeypatch.setattr(lyrics, "_lookup", fake_lookup)
    params = {"artist": "Artist", "title": "Song", "duration": 200}
    first = client.get("/api/lyrics", params=params)
    second = client.get("/api/lyrics", params=params)
    assert first.status_code == 200, first.text
    assert first.json() == {"synced": "[00:01.00] hi", "plain": None}
    assert second.json() == first.json()
    assert calls == [("Artist", "Song", 200)]
    _clear("Artist", "Song", 200)


def test_lyrics_provider_failure_is_not_cached(client, monkeypatch):
    import httpx

    _clear("Down", "Song", 0)

    async def failing_lookup(artist, title, duration):
        raise httpx.ConnectError("boom")

    monkeypatch.setattr(lyrics, "_lookup", failing_lookup)
    response = client.get("/api/lyrics", params={"artist": "Down", "title": "Song"})
    assert response.status_code == 502
    assert redis_client.get("lyrics:v1:down|song|0") is None


def test_lrclib_429_is_retried_with_app_user_agent(monkeypatch):
    """Прод, 2026-10-20: lrclib за Cloudflare отвечал 429 на дефолтный UA
    python-httpx, и 17% текстов уходили в 502."""
    import asyncio

    import httpx

    seen = []

    def handler(request):
        seen.append(request.headers.get("user-agent"))
        if len(seen) == 1:
            return httpx.Response(429)
        return httpx.Response(200, json={"syncedLyrics": "[00:01.00] hi"})

    real_client = httpx.AsyncClient

    def client_factory(**kwargs):
        return real_client(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(lyrics.httpx, "AsyncClient", client_factory)
    monkeypatch.setattr(lyrics, "_RETRY_DELAY_SEC", 0)

    assert asyncio.run(lyrics._lookup("Artist", "Song", 200)) == {"synced": "[00:01.00] hi"}
    assert len(seen) == 2
    assert all(ua and ua.startswith("bolt-music/") for ua in seen)
