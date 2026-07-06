import os

from slowapi import Limiter
from slowapi.util import get_remote_address

# Хранилище лимитов в Redis — общее для всех воркеров/процессов. С дефолтным
# in-memory каждый воркер считал бы лимиты отдельно (в N раз слабее ограничение).
REDIS_HOST = os.getenv("REDIS_HOST", "redis")
REDIS_PORT = os.getenv("REDIS_PORT", "6379")
_storage_uri = f"redis://{REDIS_HOST}:{REDIS_PORT}"

limiter = Limiter(key_func=get_remote_address, storage_uri=_storage_uri)
