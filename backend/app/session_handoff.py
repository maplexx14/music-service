"""Передача сессии из Safari в приложение на экране «Домой» (iOS).

У установленного веб-приложения на iOS своё хранилище: localStorage Safari
туда не попадает, и после «На экран Домой» новичок снова вводил пароль и код
из письма «новое устройство». Окно RECENT_VERIFY_WINDOW_SEC спасает только
в первые полчаса и с того же IP.

Залогиненная вкладка Safari берёт одноразовый токен и кладёт его в два места:
HttpOnly-cookie (iOS может скопировать cookie Safari в приложение при
установке) и start_url манифеста (iOS берёт его при «На экран Домой»).
Приложение без сессии при запуске меняет токен на вход. Токен выдан
залогиненной сессии, поэтому вход по нему — без пароля и кода, как
продолжение той же сессии на том же телефоне.

В Redis лежит только sha256 токена: утечка дампа не даёт войти.
"""
import hashlib
import logging
import os
import secrets

from app.cache import redis_client

logger = logging.getLogger(__name__)

# Сутки: подсказка об установке всплывает через секунды, но ставят и позже.
# Неиспользованный токен гаснет сам, использованный — сразу.
HANDOFF_TTL_SEC = int(os.getenv("SESSION_HANDOFF_TTL_SEC", str(24 * 3600)))
HANDOFF_COOKIE = "bolt_handoff"


class HandoffUnavailable(Exception):
    """Redis недоступен — вход по паролю, как раньше."""


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _token_key(digest: str) -> str:
    return f"auth:handoff:{digest}"


def _user_key(user_id: int) -> str:
    return f"auth:handoff-for:{user_id}"


def issue_handoff(user_id: int) -> str:
    """Новый токен юзера; прежний гаснет — живой всегда один."""
    token = secrets.token_urlsafe(32)
    digest = _digest(token)
    try:
        previous = redis_client.get(_user_key(user_id))
        if previous:
            if isinstance(previous, bytes):
                previous = previous.decode()
            redis_client.delete(_token_key(previous))
        redis_client.setex(_token_key(digest), HANDOFF_TTL_SEC, str(user_id))
        redis_client.setex(_user_key(user_id), HANDOFF_TTL_SEC, digest)
    except Exception as exc:  # noqa: BLE001
        raise HandoffUnavailable(str(exc)) from exc
    return token


def revoke_handoff(user_id: int) -> None:
    """Гасит живой токен юзера: выход, «забыть все устройства», смена пароля.
    Redis недоступен — токен доживёт свой срок, выход от этого не ломаем."""
    try:
        digest = redis_client.get(_user_key(user_id))
        if digest:
            if isinstance(digest, bytes):
                digest = digest.decode()
            redis_client.delete(_token_key(digest))
        redis_client.delete(_user_key(user_id))
    except Exception:  # noqa: BLE001
        logger.warning("could not revoke session handoff of user %s", user_id)


def consume_handoff(token: str) -> int | None:
    """id юзера по токену; токен гаснет. None — чужой, протух или уже взят."""
    if not token:
        return None
    digest = _digest(token)
    # Взять и погасить атомарно: два запуска приложения разом не войдут оба.
    # Указатель юзера на токен чистим, только если он ещё на этот токен.
    script = """
    local value = redis.call('get', KEYS[1])
    if value then
        redis.call('del', KEYS[1])
        local user_key = 'auth:handoff-for:' .. value
        if redis.call('get', user_key) == ARGV[1] then redis.call('del', user_key) end
    end
    return value
    """
    try:
        raw = redis_client.eval(script, 1, _token_key(digest), digest)
    except Exception as exc:  # noqa: BLE001
        raise HandoffUnavailable(str(exc)) from exc
    if raw is None:
        return None
    if isinstance(raw, bytes):
        raw = raw.decode()
    try:
        return int(raw)
    except ValueError:
        return None
