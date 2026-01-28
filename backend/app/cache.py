import redis
import json
from typing import Optional, Any
import os

redis_client = redis.Redis(
    host=os.getenv("REDIS_HOST", "redis"),
    port=int(os.getenv("REDIS_PORT", 6379)),
    db=0,
    decode_responses=True
)


def get_cache(key: str) -> Optional[Any]:
    """Get value from cache"""
    try:
        value = redis_client.get(key)
        if value:
            return json.loads(value)
        return None
    except Exception:
        return None


def set_cache(key: str, value: Any, expire: int = 3600):
    """Set value in cache with expiration (default 1 hour)"""
    try:
        redis_client.setex(key, expire, json.dumps(value))
    except Exception:
        pass


def delete_cache(key: str):
    """Delete value from cache"""
    try:
        redis_client.delete(key)
    except Exception:
        pass


def clear_pattern(pattern: str):
    """Clear all keys matching pattern"""
    try:
        keys = redis_client.keys(pattern)
        if keys:
            redis_client.delete(*keys)
    except Exception:
        pass
