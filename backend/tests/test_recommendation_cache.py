from app import recommendation_cache


def test_invalidation_matches_the_keys_used_by_recommendations(monkeypatch):
    cleared = []
    monkeypatch.setattr(recommendation_cache, "clear_pattern", cleared.append)

    key = recommendation_cache.recommendation_cache_key(
        user_id=42,
        limit=20,
        bucket="evening",
    )
    recommendation_cache.invalidate_recommendation_cache(42)

    assert key == "recs:v3-library:42:20:evening"
    assert cleared == ["recs:v3-library:42:*"]
