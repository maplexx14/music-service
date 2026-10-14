import os
import time
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


# Метка последнего негативного сигнала (скип/дизлайк) — для готовых порций
# потока: если после предрасчёта ничего не отвергнуто, выдача не ходит в БД за
# свежими скипами (см. flow._take_ready_portion). Только негатив: listen/like
# приходят на каждый трек, и с ними метка была бы свежее любой порции.
_NEGATIVE_SIGNAL_TTL = 2 * 60 * 60


def negative_signal_key(user_id: int) -> str:
    return f"flow:negative:{user_id}"


def mark_negative_signal(user_id: int) -> None:
    """Звать ПОСЛЕ коммита скипа/дизлайка: читающий видит метку — увидит и строку."""
    try:
        redis_client.set(
            negative_signal_key(user_id), str(time.time()), ex=_NEGATIVE_SIGNAL_TTL
        )
    except Exception:
        pass


# Пересчёт готовой порции потока по сигналу юзера (см. app/flow_warmer.py).
# Следующую порцию flow-warmer считает сразу после выдачи текущей, а фронт
# просит её только через ~15 треков (за 8 до конца очереди): лайки и скипы за
# это время в ранжирование не попадали, выдача лишь вычищала скипнутых
# артистов. Явное действие (лайк, дизлайк, их отмена) и серия скипов ставят
# юзера в отложенную очередь; каждый следующий сигнал отодвигает срок
# (ZADD GT), так что серия сливается в один расчёт. Одиночный скип пересчёта не
# стоит: трек и его артиста и так убирает выдача, а скипов в потоке много.
FLOW_PC_DELAYED = "flow:pc:delayed"
_FLOW_SIGNAL_DELAY = float(os.getenv("FLOW_SIGNAL_DELAY_SEC", "30"))
_FLOW_SIGNAL_SKIPS = int(os.getenv("FLOW_SIGNAL_SKIPS", "2"))
_FLOW_SIGNAL_TTL = 2 * 60 * 60


def flow_pc_meta_key(user_id: int) -> str:
    # Пишется выдачей потока (flow._enqueue_precompute) на сутки.
    return f"flow:pc:meta:{user_id}"


def flow_ready_key(user_id: int) -> str:
    """Готовый пул потока (см. routers.flow._take_ready_portion)."""
    return f"flow:ready:{user_id}"


def invalidate_flow_ready(user_id: int) -> None:
    """Сбросить готовый пул и попросить flow-warmer посчитать новый: настройки
    (ползунок новизны, любимые артисты, жанры, исключения) поменялись, а пул
    посчитан под старые. Прод, 2026-10-14: ползунок опустили с 0.6 до 0.2, а
    пул под 0.6 продолжал отдаваться до 90 минут."""
    try:
        redis_client.delete(flow_ready_key(user_id))
    except Exception:
        pass
    mark_flow_signal(user_id, "explicit")


def flow_signal_key(user_id: int) -> str:
    """Время сигнала, после которого готовая порция устарела."""
    return f"flow:pc:signal:{user_id}"


def flow_skips_key(user_id: int) -> str:
    """Разные треки, скипнутые после последнего расчёта порции."""
    return f"flow:pc:skips:{user_id}"


def mark_flow_signal(user_id: int, kind: str, identity: Optional[str] = None) -> None:
    """Звать ПОСЛЕ коммита. kind="explicit" — лайк/дизлайк и их отмена,
    kind="skip" — скип трека identity (local:id или source:external_id: скип
    одного трека приходит и в /tracks/{id}/skip, и в /recommendations/events)."""
    try:
        # Потоком за сутки не пользовался — готовой порции нет и не нужна.
        if not redis_client.exists(flow_pc_meta_key(user_id)):
            return
        if kind == "skip":
            key = flow_skips_key(user_id)
            pipe = redis_client.pipeline(transaction=False)
            pipe.sadd(key, identity or f"t:{time.time()}")
            pipe.expire(key, _FLOW_SIGNAL_TTL)
            pipe.scard(key)
            if pipe.execute()[-1] < _FLOW_SIGNAL_SKIPS:
                return
            redis_client.delete(key)
        now = time.time()
        pipe = redis_client.pipeline(transaction=False)
        pipe.set(flow_signal_key(user_id), str(now), ex=_FLOW_SIGNAL_TTL)
        pipe.zadd(FLOW_PC_DELAYED, {str(user_id): now + _FLOW_SIGNAL_DELAY}, gt=True)
        pipe.execute()
    except Exception:
        pass


def invalidate_recommendation_cache(user_id: int) -> None:
    # Все поколения скорера юзера лежат в одном индексе: ключ версионирован
    # (ALGORITHM_VERSION), но store_recommendations пишет в индекс любой.
    try:
        redis_client.eval(_INVALIDATE_SCRIPT, 1, _index_key(user_id))
    except Exception:
        pass
