"""Одноразовые ссылки восстановления пароля, хранящиеся в Redis."""
import hashlib
import logging
import os
import secrets
from urllib.parse import quote

from app.cache import redis_client
from app.email_verification import PUBLIC_URL
from app.mailer import send_mail

logger = logging.getLogger("password_reset")

RESET_TOKEN_TTL_SEC = int(os.getenv("PASSWORD_RESET_TOKEN_TTL_SEC", "3600"))


class PasswordResetUnavailable(RuntimeError):
    """Redis недоступен, поэтому одноразовую ссылку нельзя выпустить."""


def _token_key(token: str) -> str:
    digest = hashlib.sha256(token.encode()).hexdigest()
    return f"password:reset:{digest}"


def _user_token_key(user_id: int) -> str:
    return f"password:reset:user:{user_id}"


def issue_reset_token(user_id: int) -> str:
    """Выписывает ссылку и инвалидирует предыдущую ссылку пользователя."""
    token = secrets.token_urlsafe(32)
    token_key = _token_key(token)
    script = """
    local previous = redis.call('get', KEYS[1])
    if previous then redis.call('del', previous) end
    redis.call('setex', KEYS[1], ARGV[1], KEYS[2])
    redis.call('setex', KEYS[2], ARGV[1], ARGV[2])
    return 1
    """
    try:
        redis_client.eval(
            script,
            2,
            _user_token_key(user_id),
            token_key,
            RESET_TOKEN_TTL_SEC,
            user_id,
        )
    except Exception as exc:  # noqa: BLE001
        raise PasswordResetUnavailable(str(exc)) from exc
    return token


def consume_reset_token(token: str) -> int | None:
    """Атомарно поглощает токен и возвращает id пользователя."""
    script = """
    local user_id = redis.call('get', KEYS[1])
    if not user_id then return nil end
    redis.call('del', KEYS[1])
    redis.call('del', 'password:reset:user:' .. user_id)
    return user_id
    """
    try:
        raw = redis_client.eval(script, 1, _token_key(token))
    except Exception as exc:  # noqa: BLE001
        raise PasswordResetUnavailable(str(exc)) from exc
    if raw is None:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def send_password_reset_email(to_email: str, username: str, token: str) -> bool:
    reset_url = f"{PUBLIC_URL}/reset-password?token={quote(token)}"
    return send_mail(
        to_email,
        "Восстановление пароля — Music Streaming",
        f"Здравствуйте, {username}!\n\n"
        f"Чтобы задать новый пароль, перейдите по ссылке:\n{reset_url}\n\n"
        "Ссылка действует 1 час и может быть использована только один раз. "
        "Если вы не запрашивали восстановление, просто проигнорируйте письмо.\n",
        log_fallback=f"password reset link for {to_email}: {reset_url}",
    )
