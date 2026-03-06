import redis.asyncio as redis
import json
from typing import Optional, Any
import os

redis_client = redis.Redis(
    host=os.getenv("REDIS_HOST", "redis"),
    port=int(os.getenv("REDIS_PORT", 6379)),
    db=0,
    decode_responses=True
)

async def mark_user_online(user_id: int):
    """Mark a user as online for 5 minutes"""
    try:
        await redis_client.setex(f"online:user:{user_id}", 300, "1")
    except Exception:
        pass

async def get_online_users_count() -> int:
    """Get the count of currently online users"""
    try:
        keys = await redis_client.keys("online:user:*")
        return len(keys)
    except Exception:
        return 0

async def get_cache(key: str) -> Optional[Any]:
    """Get value from cache"""
    try:
        value = await redis_client.get(key)
        if value:
            return json.loads(value)
        return None
    except Exception:
        return None

async def set_cache(key: str, value: Any, expire: int = 3600):
    """Set value in cache with expiration (default 1 hour)"""
    try:
        await redis_client.setex(key, expire, json.dumps(value))
    except Exception:
        pass

async def delete_cache(key: str):
    """Delete value from cache"""
    try:
        await redis_client.delete(key)
    except Exception:
        pass

async def clear_pattern(pattern: str):
    """Clear all keys matching pattern"""
    try:
        keys = await redis_client.keys(pattern)
        if keys:
            await redis_client.delete(*keys)
    except Exception:
        pass
