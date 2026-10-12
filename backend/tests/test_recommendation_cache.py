from app import recommendation_cache
from app.cache import get_cache, redis_client
from app.recommendation_scoring import ALGORITHM_VERSION


def _cleanup(*user_ids):
    for user_id in user_ids:
        recommendation_cache.invalidate_recommendation_cache(user_id)


def test_cache_key_format():
    key = recommendation_cache.recommendation_cache_key(
        user_id=42,
        limit=20,
        bucket="evening",
    )

    assert key == f"recs:library:{ALGORITHM_VERSION}:42:20:evening"


def test_invalidation_drops_every_stored_delivery_of_the_user():
    _cleanup(42, 43)
    keys = [
        recommendation_cache.recommendation_cache_key(42, 20, "evening"),
        recommendation_cache.recommendation_cache_key(42, 40, None),
        # Выдача прошлой версии скорера тоже должна сноситься.
        recommendation_cache.recommendation_cache_key(42, 20, "evening", algorithm_version="hybrid-v3"),
    ]
    for key in keys:
        recommendation_cache.store_recommendations(42, key, {"tracks": []}, expire=300)
        recommendation_cache.remember_delivery(key, "req-1")
    other_key = recommendation_cache.recommendation_cache_key(43, 20, "evening")
    recommendation_cache.store_recommendations(43, other_key, {"tracks": []}, expire=300)

    recommendation_cache.invalidate_recommendation_cache(42)

    for key in keys:
        assert get_cache(key) is None
        assert redis_client.get(f"{key}:delivery") is None
    assert redis_client.exists("recs:index:42") == 0
    # Чужая выдача не задета.
    assert get_cache(other_key) == {"tracks": []}
    _cleanup(43)


def test_delivery_stored_after_invalidation_is_indexed_again():
    _cleanup(42)
    key = recommendation_cache.recommendation_cache_key(42, 20, None)
    recommendation_cache.store_recommendations(42, key, {"tracks": []}, expire=300)
    recommendation_cache.invalidate_recommendation_cache(42)
    recommendation_cache.store_recommendations(42, key, {"tracks": [1]}, expire=300)

    recommendation_cache.invalidate_recommendation_cache(42)

    assert get_cache(key) is None


def test_cache_key_changes_with_algorithm_version():
    previous_key = recommendation_cache.recommendation_cache_key(
        user_id=42,
        limit=20,
        bucket="evening",
        algorithm_version="hybrid-v3",
    )
    current_key = recommendation_cache.recommendation_cache_key(
        user_id=42,
        limit=20,
        bucket="evening",
        algorithm_version="hybrid-v4",
    )

    assert previous_key != current_key
    assert previous_key == "recs:library:hybrid-v3:42:20:evening"
    assert current_key == "recs:library:hybrid-v4:42:20:evening"


def test_single_flight_serializes_same_key_and_cleans_up():
    import asyncio

    from app.routers import recommendations

    running = 0
    peak = 0

    async def worker(key):
        nonlocal running, peak
        async with recommendations._single_flight(key):
            running += 1
            peak = max(peak, running)
            await asyncio.sleep(0.01)
            running -= 1

    async def main():
        await asyncio.gather(*[worker("k1") for _ in range(5)])
        assert peak == 1
        assert recommendations._compute_locks == {}
        # разные ключи не блокируют друг друга
        await asyncio.gather(worker("a"), worker("b"))
        assert peak == 2
        assert recommendations._compute_locks == {}

    asyncio.run(main())


def test_single_flight_timeout_falls_through(monkeypatch):
    import asyncio

    from app.routers import recommendations

    monkeypatch.setattr(recommendations, "_SINGLE_FLIGHT_WAIT", 0.05)
    entered = []

    async def holder():
        async with recommendations._single_flight("k"):
            await asyncio.sleep(0.3)

    async def waiter():
        async with recommendations._single_flight("k"):
            entered.append(True)

    async def main():
        t = asyncio.create_task(holder())
        await asyncio.sleep(0.01)
        await waiter()
        assert entered == [True]
        await t
        assert recommendations._compute_locks == {}

    asyncio.run(main())
