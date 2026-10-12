from app import cache


class _FakeRedis:
    def __init__(self, acquired: bool, pttl: int = -2):
        self.acquired = acquired
        self.remaining = pttl
        self.calls = []

    def set(self, key, value, *, nx, px):
        self.calls.append((key, value, nx, px))
        return self.acquired

    def pttl(self, _key):
        return self.remaining


def test_rate_slot_is_acquired_atomically(monkeypatch):
    redis = _FakeRedis(acquired=True)
    monkeypatch.setattr(cache, "redis_client", redis)

    assert cache.acquire_rate_slot("youtube:rate", 1.5) == 0
    assert redis.calls == [("youtube:rate", "1", True, 1500)]


def test_rate_slot_returns_remaining_delay(monkeypatch):
    redis = _FakeRedis(acquired=False, pttl=725)
    monkeypatch.setattr(cache, "redis_client", redis)

    assert cache.acquire_rate_slot("youtube:rate", 1.5) == 0.725


def test_get_cache_async_batches_concurrent_reads_into_one_mget(monkeypatch):
    import asyncio
    import json

    from app import cache

    calls = []

    class FakeRedis:
        def mget(self, keys):
            calls.append(list(keys))
            return [json.dumps({"k": k}) if k != "missing" else None for k in keys]

    monkeypatch.setattr(cache, "redis_client", FakeRedis())

    async def main():
        return await asyncio.gather(
            cache.get_cache_async("a"),
            cache.get_cache_async("b"),
            cache.get_cache_async("a"),
            cache.get_cache_async("missing"),
        )

    assert asyncio.run(main()) == [{"k": "a"}, {"k": "b"}, {"k": "a"}, None]
    assert calls == [["a", "b", "missing"]]


def test_get_cache_async_redis_failure_returns_none(monkeypatch):
    import asyncio

    from app import cache

    class Broken:
        def mget(self, keys):
            raise ConnectionError("down")

    monkeypatch.setattr(cache, "redis_client", Broken())

    async def main():
        return await asyncio.gather(cache.get_cache_async("a"), cache.get_cache_async("b"))

    assert asyncio.run(main()) == [None, None]
