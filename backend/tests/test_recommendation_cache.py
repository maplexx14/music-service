from app import recommendation_cache
from app.recommendation_scoring import ALGORITHM_VERSION


def test_invalidation_matches_the_keys_used_by_recommendations(monkeypatch):
    cleared = []
    monkeypatch.setattr(recommendation_cache, "clear_pattern", cleared.append)

    key = recommendation_cache.recommendation_cache_key(
        user_id=42,
        limit=20,
        bucket="evening",
    )
    recommendation_cache.invalidate_recommendation_cache(42)

    assert key == f"recs:library:{ALGORITHM_VERSION}:42:20:evening"
    assert cleared == [
        f"recs:library:*:42:*",
        "recs:v3-library:42:*",
    ]


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
