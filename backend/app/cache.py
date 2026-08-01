import asyncio
import redis
import json
from typing import Optional, Any
import os

# Таймауты обязательны: без socket_timeout зависший/перегруженный Redis
# блокирует вызывающий тред НАВСЕГДА. Все sync-эндпоинты живут в anyio
# threadpool (THREADPOOL_TOKENS штук на воркер), поэтому один недоступный
# Redis выжирает весь threadpool и роняет ВЕСЬ воркер, включая эндпоинты,
# которым кэш не нужен. С таймаутом вызов падает, get_cache/set_cache глотают
# исключение (см. ниже) и запрос идёт в обход кэша — деградация, не отказ.
#
# max_connections ограничивает пул на процесс-воркер: без лимита пул растёт
# по числу конкурентных тредов и упирается в maxclients Redis'а.
redis_client = redis.Redis(
    host=os.getenv("REDIS_HOST", "redis"),
    port=int(os.getenv("REDIS_PORT", 6379)),
    db=0,
    decode_responses=True,
    socket_timeout=float(os.getenv("REDIS_SOCKET_TIMEOUT", "2.0")),
    socket_connect_timeout=float(os.getenv("REDIS_CONNECT_TIMEOUT", "2.0")),
    socket_keepalive=True,
    # Пингует соединение, простоявшее дольше интервала, до отдачи запроса —
    # иначе первый запрос после простоя падает на разорванном сокете.
    health_check_interval=30,
    retry_on_timeout=True,
    max_connections=int(os.getenv("REDIS_MAX_CONNECTIONS", "100")),
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


# Async-обёртки для вызова из async def: redis-клиент синхронный, и прямой
# вызов get/set_cache из корутины блокирует event loop на сетевом round-trip —
# под нагрузкой это стопорит ВСЕ async-эндпоинты, а не только вызывающий.
# Sync-эндпоинты (def) работают в threadpool — им обёртки не нужны.
async def get_cache_async(key: str) -> Optional[Any]:
    return await asyncio.to_thread(get_cache, key)


async def set_cache_async(key: str, value: Any, expire: int = 3600):
    await asyncio.to_thread(set_cache, key, value, expire)


def delete_cache(key: str):
    """Delete value from cache"""
    try:
        redis_client.delete(key)
    except Exception:
        pass


def clear_pattern(pattern: str):
    """Clear matching keys incrementally without blocking Redis with KEYS."""
    try:
        batch = []
        for key in redis_client.scan_iter(match=pattern, count=200):
            batch.append(key)
            if len(batch) >= 200:
                redis_client.delete(*batch)
                batch.clear()
        if batch:
            redis_client.delete(*batch)
    except Exception:
        pass


async def clear_pattern_async(pattern: str):
    """Async wrapper for clear_pattern — avoids blocking event loop."""
    await asyncio.to_thread(clear_pattern, pattern)
