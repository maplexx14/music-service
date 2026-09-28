from typing import Optional

from app.cache import clear_pattern, redis_client
from app.recommendation_scoring import ALGORITHM_VERSION


_RECOMMENDATION_CACHE_NAMESPACE = "recs:library"
_LEGACY_RECOMMENDATION_CACHE_NAMESPACE = "recs:v3-library"

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


def claim_delivery(cache_key: str, request_id: str) -> Optional[str]:
    """Застолбить request_id за закэшированной выдачей.

    None — окно наше, выдачу надо записать под request_id. Строка — выдачу
    уже записали в пределах окна, вернуть её id и ничего не писать. SET NX
    атомарен между воркерами. Redis недоступен — None (fail open): лишняя
    запись показа лучше потерянной.
    """
    key = _delivery_key(cache_key)
    try:
        if redis_client.set(key, request_id, nx=True, ex=DELIVERY_DEDUP_TTL):
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


def invalidate_recommendation_cache(user_id: int) -> None:
    # Clear every scorer generation for this user.  The current generation is
    # versioned to prevent stale rankings surviving a rollout; the legacy
    # namespace is included so an in-flight old worker cannot serve its entry
    # after a preference/playback mutation.
    clear_pattern(f"{_RECOMMENDATION_CACHE_NAMESPACE}:*:{user_id}:*")
    clear_pattern(f"{_LEGACY_RECOMMENDATION_CACHE_NAMESPACE}:{user_id}:*")
