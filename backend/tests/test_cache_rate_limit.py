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
