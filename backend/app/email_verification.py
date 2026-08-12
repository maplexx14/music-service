"""Подтверждение почты: одноразовые токены и отправка письма.

Токен — случайная строка, живёт в Redis 24 ч и гасится при первом
использовании. В БД его нет намеренно: это расходник, а не состояние юзера,
и TTL Redis снимает вопрос уборки протухших.

Отправка — через app.mailer (там же настройки SMTP_*). Если SMTP не настроен
(типичная локальная разработка), письмо не уходит, а ссылка пишется в лог —
поток регистрации остаётся проходимым без почтового сервера.
"""
import hashlib
import logging
import os
import secrets
from urllib.parse import quote

from app.cache import redis_client
from app.mailer import send_mail, smtp_configured  # noqa: F401 — smtp_configured в публичном API модуля

logger = logging.getLogger("email_verification")

# Сутки: письмо могут открыть не сразу (спам-папка, вечерняя регистрация).
# Дольше держать одноразовый вход в аккаунт не стоит.
VERIFY_TOKEN_TTL_SEC = int(os.getenv("EMAIL_VERIFY_TOKEN_TTL_SEC", str(24 * 3600)))

# Базовый адрес фронта для ссылки в письме. Через nginx фронт и API живут на
# одном origin, поэтому дефолт указывает на него же.
PUBLIC_URL = os.getenv("PUBLIC_URL", "http://localhost").rstrip("/")


class VerificationUnavailable(RuntimeError):
    """Redis недоступен — токен некуда положить, значит подтверждение не
    работает. Лучше честная ошибка, чем письмо с заведомо мёртвой ссылкой."""


def _token_key(token: str) -> str:
    # Храним хэш, а не сам токен: дамп Redis не должен давать готовые ссылки
    # подтверждения для чужих аккаунтов.
    digest = hashlib.sha256(token.encode()).hexdigest()
    return f"email:verify:{digest}"


def _user_tokens_key(user_id: int) -> str:
    return f"email:verify:user:{user_id}"


def issue_token(user_id: int) -> str:
    """Новый токен подтверждения для юзера.

    Прошлый токен инвалидируется: после «отправить письмо снова» старая
    ссылка не должна работать — иначе утёкшее первое письмо остаётся
    действующим ключом от аккаунта.
    """
    token = secrets.token_urlsafe(32)
    try:
        previous = redis_client.get(_user_tokens_key(user_id))
        if previous:
            redis_client.delete(_token_key(previous))
        redis_client.setex(_token_key(token), VERIFY_TOKEN_TTL_SEC, str(user_id))
        # Обратная ссылка нужна только чтобы гасить предыдущий токен.
        redis_client.setex(_user_tokens_key(user_id), VERIFY_TOKEN_TTL_SEC, token)
    except Exception as exc:  # noqa: BLE001 — сеть/таймаут Redis
        raise VerificationUnavailable(str(exc)) from exc
    return token


def consume_token(token: str) -> int | None:
    """Возвращает user_id и гасит токен. None — токен неверен или протух.

    Гашение через getdel атомарно: две параллельные попытки по одной ссылке
    не подтвердят аккаунт дважды.
    """
    if not token:
        return None
    try:
        raw = redis_client.getdel(_token_key(token))
    except Exception as exc:  # noqa: BLE001
        raise VerificationUnavailable(str(exc)) from exc
    if raw is None:
        return None
    try:
        user_id = int(raw)
    except (TypeError, ValueError):
        return None
    try:
        redis_client.delete(_user_tokens_key(user_id))
    except Exception:  # noqa: BLE001 — обратная ссылка протухнет сама по TTL
        pass
    return user_id


def build_verify_url(token: str) -> str:
    return f"{PUBLIC_URL}/verify-email?token={quote(token)}"


def send_verification_email(to_email: str, username: str, token: str) -> bool:
    """Отправляет письмо. True — ушло по SMTP, False — SMTP не настроен либо
    отправка не удалась (ссылка в обоих случаях уходит в лог).

    Ошибку наружу НЕ поднимаем: аккаунт уже создан, и падение почтового
    сервера не должно превращать регистрацию в 500. Юзер увидит экран
    «проверьте почту» и сможет запросить письмо повторно.
    """
    verify_url = build_verify_url(token)
    return send_mail(
        to_email,
        "Подтвердите почту — Music Streaming",
        f"Здравствуйте, {username}!\n\n"
        f"Подтвердите адрес почты, чтобы войти в аккаунт:\n{verify_url}\n\n"
        f"Ссылка действует 24 часа. Если вы не регистрировались, "
        f"просто проигнорируйте это письмо.\n",
        # Ссылка в логе — штатный путь локальной разработки без почтового
        # сервера, иначе поток регистрации нечем пройти.
        log_fallback=f"verification link for {to_email}: {verify_url}",
    )
