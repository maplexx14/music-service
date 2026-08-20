from typing import Optional

from app.cache import clear_pattern
from app.recommendation_scoring import ALGORITHM_VERSION


_RECOMMENDATION_CACHE_NAMESPACE = "recs:library"
_LEGACY_RECOMMENDATION_CACHE_NAMESPACE = "recs:v3-library"


def recommendation_cache_key(
    user_id: int,
    limit: int,
    bucket: Optional[str],
    algorithm_version: str = ALGORITHM_VERSION,
) -> str:
    return (
        f"{_RECOMMENDATION_CACHE_NAMESPACE}:"
        f"{algorithm_version}:{user_id}:{limit}:{bucket or 'any'}"
    )


def invalidate_recommendation_cache(user_id: int) -> None:
    # Clear every scorer generation for this user.  The current generation is
    # versioned to prevent stale rankings surviving a rollout; the legacy
    # namespace is included so an in-flight old worker cannot serve its entry
    # after a preference/playback mutation.
    clear_pattern(f"{_RECOMMENDATION_CACHE_NAMESPACE}:*:{user_id}:*")
    clear_pattern(f"{_LEGACY_RECOMMENDATION_CACHE_NAMESPACE}:{user_id}:*")
