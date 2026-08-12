"""Двухфакторка через почту: одноразовый 6-значный код.

Код живёт в Redis (не в БД): это расходник со сроком годности, TTL снимает
вопрос уборки протухших. В Redis лежит bcrypt-хэш, а не сам код — дамп базы
в пределах десятиминутного окна не должен давать готовый второй фактор.

Пространство 6 цифр — всего 10^6, поэтому одного TTL мало: есть счётчик
попыток на код (см. EMAIL_CODE_MAX_ATTEMPTS), при исчерпании код гасится
целиком, и нужен новый. Плюс cooldown на повторную отправку, чтобы
эндпоинт не превращался в рассыльщик писем на чужой ящик.
"""
import logging
import os
import secrets

from app.auth import get_password_hash, verify_password
from app.cache import redis_client
from app.mailer import send_mail

logger = logging.getLogger("email_2fa")

# 10 минут: письмо идёт не мгновенно, юзер может переключиться в почтовый
# клиент и вернуться. Дольше держать живой второй фактор незачем.
EMAIL_CODE_TTL_SEC = int(os.getenv("EMAIL_2FA_CODE_TTL_SEC", "600"))

# 6 цифр — то, что юзер готов перенабрать руками из письма. Слабость короткого
# кода компенсируется TTL, лимитом попыток и rate-limit на эндпоинте.
EMAIL_CODE_LENGTH = 6

# Пять попыток на код. При 10^6 вариантах это шанс 5*10^-6 на угадывание за
# время жизни кода; дальше код гасится и злоумышленнику нужен новый (а он
# уходит на почту владельца).
EMAIL_CODE_MAX_ATTEMPTS = int(os.getenv("EMAIL_2FA_MAX_ATTEMPTS", "5"))

# Минута между письмами: без неё повторная отправка — готовый инструмент
# заваливания чужого ящика.
EMAIL_CODE_RESEND_COOLDOWN_SEC = int(os.getenv("EMAIL_2FA_RESEND_COOLDOWN_SEC", "60"))

# Разные назначения — разные ключи: код, высланный для включения 2FA в
# настройках, не должен проходить как второй фактор на входе, и наоборот.
PURPOSE_LOGIN = "login"
PURPOSE_ENABLE = "enable"

# Без SMTP код доставить нечем, а вход с нового устройства требует его
# обязательно — то есть ненастроенная почта запирает всех снаружи. В локальной
# разработке (DEBUG) поэтому пишем код в лог: это единственный способ пройти
# вход без почтового сервера. В продакшене — никогда: код в логе это второй
# фактор к живому паролю, лежащий рядом с ним в одном файле.
LOG_CODE_WITHOUT_SMTP = os.getenv("DEBUG", "").lower() in ("1", "true", "yes")


class EmailCodeUnavailable(RuntimeError):
    """Redis недоступен — код некуда положить или нечем проверить. Значит
    почтовая двухфакторка не работает, и вход надо отклонять (fail-closed),
    а не пускать без второго фактора."""


class EmailCodeCooldown(RuntimeError):
    """Письмо просили слишком часто. Не ошибка: предыдущий код ещё живой."""

    def __init__(self, seconds_left: int):
        super().__init__(f"retry in {seconds_left}s")
        self.seconds_left = seconds_left


def mask_email(email: str) -> str:
    """j••••n@example.com — на экране входа надо показать, КУДА ушёл код, но
    не печатать чужой адрес целиком: экран входа виден до аутентификации."""
    address = (email or "").strip()
    if "@" not in address:
        return "•••"
    local, _, domain = address.partition("@")
    if len(local) <= 2:
        hidden = "•" * max(len(local), 1)
    else:
        hidden = f"{local[0]}{'•' * (len(local) - 2)}{local[-1]}"
    return f"{hidden}@{domain}"


def _code_key(user_id: int, purpose: str) -> str:
    return f"2fa:mail:code:{purpose}:{user_id}"


def _attempts_key(user_id: int, purpose: str) -> str:
    return f"2fa:mail:tries:{purpose}:{user_id}"


def _cooldown_key(user_id: int, purpose: str) -> str:
    return f"2fa:mail:cooldown:{purpose}:{user_id}"


def generate_email_code() -> str:
    """Ровно EMAIL_CODE_LENGTH цифр, ведущие нули сохраняются: код всегда
    одной длины, иначе поле ввода и сравнение начинают расходиться."""
    upper = 10**EMAIL_CODE_LENGTH
    return str(secrets.randbelow(upper)).zfill(EMAIL_CODE_LENGTH)


def normalize_email_code(code: str) -> str:
    """Из письма код нередко копируют с пробелом посередине — оставляем
    только цифры, иначе валидный код молча не подойдёт."""
    return "".join(ch for ch in (code or "") if ch.isdigit())


def issue_email_code(user_id: int, purpose: str = PURPOSE_LOGIN) -> str:
    """Новый код: гасит предыдущий, обнуляет счётчик попыток, ставит cooldown.

    Поднимает EmailCodeCooldown, если письмо просили меньше минуты назад —
    предыдущий код при этом остаётся действующим, вызывающему обычно
    достаточно сказать юзеру «код уже отправлен».
    """
    try:
        fresh = redis_client.set(
            _cooldown_key(user_id, purpose), "1", nx=True, ex=EMAIL_CODE_RESEND_COOLDOWN_SEC
        )
        if not fresh:
            ttl = redis_client.ttl(_cooldown_key(user_id, purpose))
            raise EmailCodeCooldown(max(int(ttl or 0), 1))

        code = generate_email_code()
        # Новый код вытесняет старый: два одновременно действующих кода — это
        # вдвое больше шансов на угадывание и путаница в письмах.
        redis_client.setex(
            _code_key(user_id, purpose), EMAIL_CODE_TTL_SEC, get_password_hash(code)
        )
        redis_client.delete(_attempts_key(user_id, purpose))
    except EmailCodeCooldown:
        raise
    except Exception as exc:  # noqa: BLE001 — сеть/таймаут Redis
        raise EmailCodeUnavailable(str(exc)) from exc
    return code
def code_pending(user_id: int, purpose: str = PURPOSE_LOGIN) -> bool:
    """Есть ли сейчас живой код. Нужно фронту: после перезагрузки страницы
    показать «код отправлен» вместо кнопки «выслать»."""
    try:
        return bool(redis_client.exists(_code_key(user_id, purpose)))
    except Exception as exc:  # noqa: BLE001
        raise EmailCodeUnavailable(str(exc)) from exc


def verify_email_code(user_id: int, code: str, purpose: str = PURPOSE_LOGIN) -> bool:
    """Проверяет код и гасит его при совпадении (одноразовость).

    Неудачные попытки считаются; на EMAIL_CODE_MAX_ATTEMPTS код гасится
    целиком — иначе десять минут жизни кода превращаются в окно для перебора
    10^6 вариантов. Счётчик инкрементируется ДО сверки: иначе параллельные
    попытки успевали бы проскочить мимо лимита.
    """
    normalized = normalize_email_code(code)
    if not normalized:
        return False

    try:
        stored = redis_client.get(_code_key(user_id, purpose))
        if stored is None:
            return False

        attempts = redis_client.incr(_attempts_key(user_id, purpose))
        if attempts == 1:
            # Счётчик не должен жить дольше самого кода.
            redis_client.expire(_attempts_key(user_id, purpose), EMAIL_CODE_TTL_SEC)
        if attempts > EMAIL_CODE_MAX_ATTEMPTS:
            redis_client.delete(_code_key(user_id, purpose))
            logger.warning("email 2FA code burned after %s attempts (user %s)", attempts, user_id)
            return False

        if not verify_password(normalized, stored):
            return False

        # Совпал — гасим, чтобы тем же кодом нельзя было войти второй раз.
        redis_client.delete(_code_key(user_id, purpose))
        redis_client.delete(_attempts_key(user_id, purpose))
    except Exception as exc:  # noqa: BLE001
        raise EmailCodeUnavailable(str(exc)) from exc
    return True


def clear_email_code(user_id: int, purpose: str = PURPOSE_LOGIN) -> None:
    """Снимает код и cooldown. Вызывается при выключении почтовой 2FA, чтобы
    не оставлять действующий код от отключённого фактора."""
    try:
        redis_client.delete(
            _code_key(user_id, purpose),
            _attempts_key(user_id, purpose),
            _cooldown_key(user_id, purpose),
        )
    except Exception:  # noqa: BLE001 — ключи всё равно протухнут по TTL
        logger.warning("failed to clear email 2FA code for user %s", user_id)


def send_email_code(to_email: str, username: str, code: str, purpose: str = PURPOSE_LOGIN) -> bool:
    """Доставляет код. True — юзер может его получить, False — нечем доставить.

    Код в лог попадает только при DEBUG (см. LOG_CODE_WITHOUT_SMTP): в отличие
    от ссылки подтверждения это второй фактор к живому паролю. В таком режиме
    считаем код доставленным — иначе локальная разработка без SMTP не может
    пройти обязательное подтверждение нового устройства.
    """
    minutes = max(EMAIL_CODE_TTL_SEC // 60, 1)
    if purpose == PURPOSE_ENABLE:
        subject = "Код подтверждения — Music Streaming"
        intro = "Код для включения двухфакторной аутентификации по почте:"
    else:
        subject = "Код для входа — Music Streaming"
        intro = "Код для входа в аккаунт:"
    sent = send_mail(
        to_email,
        subject,
        f"Здравствуйте, {username}!\n\n"
        f"{intro}\n\n    {code}\n\n"
        f"Код действует {minutes} минут и работает один раз.\n"
        f"Если вы не запрашивали код, смените пароль — кто-то знает его.\n",
        log_fallback=(
            f"2FA code for {to_email} ({purpose}): {code}" if LOG_CODE_WITHOUT_SMTP else ""
        ),
    )
    return sent or LOG_CODE_WITHOUT_SMTP
