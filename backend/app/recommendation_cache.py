from typing import Any, Optional

from app.cache import redis_client, set_cache
from app.recommendation_scoring import ALGORITHM_VERSION


_RECOMMENDATION_CACHE_NAMESPACE = "recs:library"

# Индекс закэшированных выдач юзера: SET с ключами всех его выдач (разные
# limit/bucket/версии скорера). Инвалидация читает его вместо SCAN по всему
# keyspace Redis — SCAN шёл на каждый play/skip/listen/лайк и стоил
# keyspace/200 round-trip'ов. TTL с запасом больше самого долгого TTL выдачи,
# чтобы индекс не истёк раньше ключей, которые в нём записаны.
_INDEX_TTL = 3600

# Ключи выдач и их :delivery удаляются атомарно с индексом: иначе выдача,
# записанная между чтением индекса и его удалением, выпала бы из индекса и
# пережила бы следующую инвалидацию.
_INVALIDATE_SCRIPT = """
local keys = redis.call('smembers', KEYS[1])
for _, key in ipairs(keys) do
    redis.call('del', key, key .. ':delivery')
end
redis.call('del', KEYS[1])
return #keys
"""

# Окно дедупликации показов. Повторная отдача ТОГО ЖЕ закэшированного списка
# тому же юзеру в пределах окна — это одна выдача (двойной fetch в StrictMode,
# возврат на страницу, refetch при фокусе), а не новая: переиспользуем её
# request_id и не пишем 20 строк в recommendation_impressions заново. Без
# этого INSERT показов был самой дорогой частью ответа из кэша (~6–10 мс БД
# против <1 мс у остальных эндпоинтов). Подтверждения видимости от клиента
# идемпотентны по visible=False, так что повторный показ той же выдачи и
# событий не раздувает.
DELIVERY_DEDUP_TTL = 60


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


def _delivery_key(cache_key: str) -> str:
    # Под тем же префиксом, что и кэш выдачи: invalidate_recommendation_cache
    # сносит оба ключа разом, и после лайка/прослушивания новая выдача
    # получает новый request_id.
    return f"{cache_key}:delivery"


def claim_delivery(user_id: int, cache_key: str, request_id: str) -> Optional[str]:
    """Застолбить request_id за закэшированной выдачей.

    None — окно наше, выдачу надо записать под request_id. Строка — выдачу
    уже записали в пределах окна, вернуть её id и ничего не писать. SET NX
    атомарен между воркерами. Redis недоступен — None (fail open): лишняя
    запись показа лучше потерянной.
    """
    key = _delivery_key(cache_key)
    try:
        if redis_client.set(key, request_id, nx=True, ex=DELIVERY_DEDUP_TTL):
            # Выдача могла попасть в кэш мимо индекса (записана до выката
            # индекса) — тогда её :delivery пережил бы инвалидацию.
            _add_to_index(user_id, cache_key)
            return None
        # Ключ мог истечь между SET и GET — тогда None, пишем под своим id.
        return redis_client.get(key)
    except Exception:
        return None


def remember_delivery(cache_key: str, request_id: str) -> None:
    """Свежий расчёт выдачи: следующие отдачи из кэша в окне — та же выдача."""
    try:
        redis_client.set(_delivery_key(cache_key), request_id, ex=DELIVERY_DEDUP_TTL)
    except Exception:
        pass


def _index_key(user_id: int) -> str:
    return f"recs:index:{user_id}"


def _add_to_index(user_id: int, cache_key: str) -> None:
    try:
        index_key = _index_key(user_id)
        pipe = redis_client.pipeline(transaction=False)
        pipe.sadd(index_key, cache_key)
        pipe.expire(index_key, _INDEX_TTL)
        pipe.execute()
    except Exception:
        pass


def store_recommendations(user_id: int, cache_key: str, payload: Any, expire: int) -> None:
    """Закэшировать выдачу и записать её ключ в индекс юзера.

    Сначала сама выдача, потом индекс: в обратном порядке инвалидация между
    шагами снесла бы индекс, и записанная следом выдача в него уже не попала бы.
    """
    set_cache(cache_key, payload, expire=expire)
    _add_to_index(user_id, cache_key)


def invalidate_recommendation_cache(user_id: int) -> None:
    # Все поколения скорера юзера лежат в одном индексе: ключ версионирован
    # (ALGORITHM_VERSION), но store_recommendations пишет в индекс любой.
    try:
        redis_client.eval(_INVALIDATE_SCRIPT, 1, _index_key(user_id))
    except Exception:
        pass
