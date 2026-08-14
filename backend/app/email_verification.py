"""Подтверждение почты: одноразовые токены и отправка письма.

До подтверждения данные регистрации и случайный одноразовый токен живут в
Redis 24 ч. Строка в SQL-таблице users появляется только при успешном переходе
по ссылке; TTL Redis автоматически убирает брошенные регистрации.

Отправка — через app.mailer (там же настройки SMTP_*). Если SMTP не настроен
(типичная локальная разработка), письмо не уходит, а ссылка пишется в лог —
поток регистрации остаётся проходимым без почтового сервера.
"""
from dataclasses import asdict, dataclass
import hashlib
import json
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


class RegistrationAlreadyPending(RuntimeError):
    """Имя или почта уже заняты незавершённой регистрацией."""


class RegistrationNotPending(RuntimeError):
    """Заявка уже подтверждается, подтверждена или протухла."""


@dataclass(frozen=True)
class PendingRegistration:
    id: str
    username: str
    email: str
    hashed_password: str


def _token_key(token: str) -> str:
    # Храним хэш, а не сам токен: дамп Redis не должен давать готовые ссылки
    # подтверждения для чужих аккаунтов.
    digest = hashlib.sha256(token.encode()).hexdigest()
    return f"email:verify:{digest}"


def _user_tokens_key(user_id: int) -> str:
    return f"email:verify:user:{user_id}"


def _registration_key(registration_id: str) -> str:
    return f"email:registration:{registration_id}"


def _registration_index_key(field: str, value: str) -> str:
    digest = hashlib.sha256(value.encode()).hexdigest()
    return f"email:registration:{field}:{digest}"


def _registration_token_key(token: str) -> str:
    digest = hashlib.sha256(token.encode()).hexdigest()
    return f"email:registration:token:{digest}"


def _registration_current_token_key(registration_id: str) -> str:
    return f"email:registration:current-token:{registration_id}"


def _decode_pending(raw: str | bytes | None) -> PendingRegistration | None:
    if not raw:
        return None
    try:
        payload = json.loads(raw)
        return PendingRegistration(
            id=payload["id"],
            username=payload["username"],
            email=payload["email"],
            hashed_password=payload["hashed_password"],
        )
    except (TypeError, ValueError, KeyError, json.JSONDecodeError):
        return None


def create_pending_registration(
    username: str, email: str, hashed_password: str
) -> tuple[PendingRegistration, str]:
    """Атомарно резервирует имя и почту вне SQL до подтверждения ссылки."""
    pending = PendingRegistration(
        id=secrets.token_urlsafe(24),
        username=username,
        email=email,
        hashed_password=hashed_password,
    )
    token = secrets.token_urlsafe(32)
    script = """
    if redis.call('exists', KEYS[1]) == 1 or redis.call('exists', KEYS[2]) == 1 then
        return 0
    end
    redis.call('setex', KEYS[1], ARGV[1], ARGV[2])
    redis.call('setex', KEYS[2], ARGV[1], ARGV[2])
    redis.call('setex', KEYS[3], ARGV[1], ARGV[3])
    redis.call('setex', KEYS[4], ARGV[1], ARGV[2])
    redis.call('setex', KEYS[5], ARGV[1], ARGV[4])
    return 1
    """
    try:
        created = redis_client.eval(
            script,
            5,
            _registration_index_key("username", username),
            _registration_index_key("email", email),
            _registration_key(pending.id),
            _registration_token_key(token),
            _registration_current_token_key(pending.id),
            VERIFY_TOKEN_TTL_SEC,
            pending.id,
            json.dumps(asdict(pending)),
            _registration_token_key(token),
        )
    except Exception as exc:  # noqa: BLE001
        raise VerificationUnavailable(str(exc)) from exc
    if not created:
        raise RegistrationAlreadyPending
    return pending, token


def get_pending_registration(username: str) -> PendingRegistration | None:
    try:
        registration_id = redis_client.get(
            _registration_index_key("username", username)
        )
        if not registration_id:
            return None
        if not redis_client.exists(_registration_current_token_key(registration_id)):
            return None
        return _decode_pending(redis_client.get(_registration_key(registration_id)))
    except Exception as exc:  # noqa: BLE001
        raise VerificationUnavailable(str(exc)) from exc


def reissue_pending_token(pending: PendingRegistration) -> str:
    """Выписывает свежую ссылку и инвалидирует предыдущую."""
    token = secrets.token_urlsafe(32)
    script = """
    local previous = redis.call('get', KEYS[1])
    if not previous then
        return 0
    end
    redis.call('del', previous)
    redis.call('setex', KEYS[2], ARGV[1], ARGV[2])
    redis.call('setex', KEYS[1], ARGV[1], KEYS[2])
    redis.call('expire', KEYS[3], ARGV[1])
    redis.call('expire', KEYS[4], ARGV[1])
    redis.call('expire', KEYS[5], ARGV[1])
    return 1
    """
    try:
        reissued = redis_client.eval(
            script,
            5,
            _registration_current_token_key(pending.id),
            _registration_token_key(token),
            _registration_key(pending.id),
            _registration_index_key("username", pending.username),
            _registration_index_key("email", pending.email),
            VERIFY_TOKEN_TTL_SEC,
            pending.id,
        )
    except Exception as exc:  # noqa: BLE001
        raise VerificationUnavailable(str(exc)) from exc
    if not reissued:
        raise RegistrationNotPending
    return token


def consume_pending_token(token: str) -> PendingRegistration | None:
    """Атомарно забирает заявку по одноразовой ссылке."""
    if not token:
        return None
    script = """
    local registration_id = redis.call('get', KEYS[1])
    if not registration_id then
        return nil
    end
    local current_key = ARGV[1] .. registration_id
    if redis.call('get', current_key) ~= KEYS[1] then
        return nil
    end
    local pending = redis.call('get', ARGV[2] .. registration_id)
    if not pending then
        redis.call('del', KEYS[1])
        redis.call('del', current_key)
        return nil
    end
    redis.call('del', KEYS[1])
    redis.call('del', current_key)
    return pending
    """
    try:
        raw = redis_client.eval(
            script,
            1,
            _registration_token_key(token),
            "email:registration:current-token:",
            "email:registration:",
        )
        return _decode_pending(raw)
    except Exception as exc:  # noqa: BLE001
        raise VerificationUnavailable(str(exc)) from exc


def restore_pending_token(pending: PendingRegistration, token: str) -> None:
    """Возвращает ссылку, если SQL-транзакция неожиданно не завершилась."""
    try:
        with redis_client.pipeline(transaction=True) as pipe:
            pipe.setex(
                _registration_key(pending.id),
                VERIFY_TOKEN_TTL_SEC,
                json.dumps(asdict(pending)),
            )
            pipe.setex(
                _registration_index_key("username", pending.username),
                VERIFY_TOKEN_TTL_SEC,
                pending.id,
            )
            pipe.setex(
                _registration_index_key("email", pending.email),
                VERIFY_TOKEN_TTL_SEC,
                pending.id,
            )
            pipe.setex(
                _registration_token_key(token), VERIFY_TOKEN_TTL_SEC, pending.id
            )
            pipe.setex(
                _registration_current_token_key(pending.id),
                VERIFY_TOKEN_TTL_SEC,
                _registration_token_key(token),
            )
            pipe.execute()
    except Exception as exc:  # noqa: BLE001
        raise VerificationUnavailable(str(exc)) from exc


def delete_pending_registration(pending: PendingRegistration) -> None:
    try:
        current = redis_client.get(_registration_current_token_key(pending.id))
        keys = [
            _registration_key(pending.id),
            _registration_index_key("username", pending.username),
            _registration_index_key("email", pending.email),
            _registration_current_token_key(pending.id),
        ]
        if current:
            keys.append(current)
        redis_client.delete(*keys)
    except Exception:  # noqa: BLE001 — ключи всё равно протухнут по TTL
        logger.exception("could not clean pending registration %s", pending.id)


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

    Ошибку наружу НЕ поднимаем: заявка уже сохранена, и падение почтового
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
