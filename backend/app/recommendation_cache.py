from typing import Optional

from app.cache import clear_pattern


_RECOMMENDATION_CACHE_NAMESPACE = "recs:v3-library"


def recommendation_cache_key(
    user_id: int,
    limit: int,
    bucket: Optional[str],
) -> str:
    return (
        f"{_RECOMMENDATION_CACHE_NAMESPACE}:"
        f"{user_id}:{limit}:{bucket or 'any'}"
    )


def invalidate_recommendation_cache(user_id: int) -> None:
    clear_pattern(f"{_RECOMMENDATION_CACHE_NAMESPACE}:{user_id}:*")
