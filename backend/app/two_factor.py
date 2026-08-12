"""TOTP-двухфакторка (RFC 6238).

Секреты провижининга (BASE32, как велит стандарт — его ждёт любой
приложение-аутентификатор), проверка кодов через pyotp с допуском ±1 шаг
(защита от дрейфа часов устройства), резервные коды — bcrypt-хэши, чтобы
утечка БД не давала вход (см. get_password_hash в auth.py).
"""
import hashlib
import io
import secrets
import string

import pyotp
import qrcode
from qrcode.image.pil import PilImage

from app.auth import get_password_hash, verify_password
from app.cache import redis_client

TOTP_ISSUER = "Music Streaming"

# Окно TOTP — 30 с, проверяем с допуском ±1 шаг, значит один код валиден до
# 90 с. Столько же живёт отметка «код уже использован»: раньше — останется
# щель для реплея, дольше — бессмысленно, код и так протух.
TOTP_REPLAY_TTL_SEC = 90


def generate_totp_secret() -> str:
    """Свежий секрет провижининга. Перегенерация на каждый setup: если юзер
    сканировал старый QR, но не завершил enable, повторный setup должен
    инвалидировать незавершённый секрет, а не молча заменить его."""
    return pyotp.random_base32()


def build_totp_uri(username: str, secret: str) -> str:
    """otpauth:// URI — его сканирует приложение-аутентификатор (QR-кодится
    во фронте отдельно: бэк отдаёт сам URI, а не PNG)."""
    return pyotp.totp.TOTP(secret).provisioning_uri(name=username, issuer_name=TOTP_ISSUER)


def generate_recovery_codes(count: int = 10) -> list[str]:
    """Резервные коды. Хранятся ТОЛЬКО в bcrypt-хэше (см. models.py),
    поэтому в сыром виде показываются юзеру один раз — при включении."""
    alphabet = string.ascii_uppercase + string.digits
    codes: list[str] = []
    while len(codes) < count:
        candidate = "".join(secrets.choice(alphabet) for _ in range(10))
        # 10 символов из 36 → коллизия маловероятна, но пусть будет по-честному.
        if candidate not in codes:
            codes.append(candidate)
    return codes


def hash_recovery_codes(codes: list[str]) -> list[str]:
    # Хэшируем нормализованную форму — ту же, в которую приводится ввод при
    # проверке (см. _normalize_recovery). Иначе код, набранный строчными,
    # не совпал бы с хэшем от верхнего регистра.
    return [get_password_hash(_normalize_recovery(c)) for c in codes]


def verify_totp(secret: str, code: str) -> bool:
    """Проверка 6-значного кода с допуском ±1 шаг (30 с).

    Допуск нужен из-за дрейфа часов устройства и того, что юзер начинает
    набирать код в конце окна. Пробелы/разделители из приложений и
    буфера обмена срезаем — TOTP это всегда только цифры.

    NB: это ТОЛЬКО криптопроверка. Один и тот же код валиден все ~90 с своего
    окна, поэтому на пути входа обязательна отметка об использовании —
    см. consume_totp_code.
    """
    if not code or not secret:
        return False
    digits = "".join(ch for ch in code if ch.isdigit())
    if not digits:
        return False
    return pyotp.TOTP(secret).verify(digits, valid_window=1)


class ReplayCacheUnavailable(RuntimeError):
    """Redis недоступен, значит защиту от повтора кода обеспечить нельзя."""


def _replay_key(user_id: int, code: str) -> str:
    # Хэшируем: дамп/просмотр Redis в пределах 90-секундного окна не должен
    # выдавать код, который прямо сейчас валиден для этого юзера. SECRET_KEY
    # как соль — чтобы хэш нельзя было перебрать по всем 10^6 комбинациям.
    from app.auth import SECRET_KEY

    digits = "".join(ch for ch in (code or "") if ch.isdigit())
    digest = hashlib.sha256(f"{SECRET_KEY}:{user_id}:{digits}".encode()).hexdigest()
    return f"2fa:used:{user_id}:{digest}"


def consume_totp_code(user_id: int, code: str) -> bool:
    """Отмечает код использованным. True — код свежий (вход разрешён),
    False — этим кодом уже входили в текущем окне.

    Зачем: verify_totp принимает один код все ~90 с. Перехваченный код
    (плечо через фишинг, лог, чужой взгляд на экран) до этой отметки можно
    было предъявить повторно. SET NX EX атомарен, поэтому две параллельные
    попытки входа с одним кодом не пройдут обе.

    При недоступном Redis поднимает ReplayCacheUnavailable — вход отклоняется
    (fail-closed). Это не ухудшает доступность: rate-limiter на /login тоже
    ходит в Redis, без него логин и так не обслуживается.
    """
    try:
        # nx=True: ключ ставится, только если его ещё нет. Вернул None —
        # ключ уже был, то есть код предъявляют повторно.
        fresh = redis_client.set(_replay_key(user_id, code), "1", nx=True, ex=TOTP_REPLAY_TTL_SEC)
    except Exception as exc:  # noqa: BLE001 — сеть/таймаут Redis
        raise ReplayCacheUnavailable(str(exc)) from exc
    return bool(fresh)


def _normalize_recovery(code: str) -> str:
    """Коды генерируются в верхнем регистре из [A-Z0-9]; пользователь может
    вписать их строчными или с дефисами — сверять надо в одной форме, иначе
    валидный код молча не подойдёт."""
    return "".join(ch for ch in (code or "") if ch.isalnum()).upper()


def check_recovery_code(hashed_codes: list[str], candidate: str) -> bool:
    """Сверка резервного кода с хэшами. bcrypt не сообщает, КАКОЙ хэш
    подошёл, поэтому использованный код вычищает отдельный проход —
    см. consume_recovery_code."""
    normalized = _normalize_recovery(candidate)
    if not normalized:
        return False
    return any(verify_password(normalized, h) for h in hashed_codes)


def consume_recovery_code(hashed_codes: list[str], candidate: str) -> list[str]:
    """Возвращает список хэшей без использованного кода (или без изменений,
    если код не подошёл). Вызывается только ПОСЛЕ check_recovery_code."""
    normalized = _normalize_recovery(candidate)
    kept = []
    consumed = False
    for h in hashed_codes:
        if not consumed and normalized and verify_password(normalized, h):
            consumed = True
            continue
        kept.append(h)
    return kept


def build_totp_qr_png(uri: str) -> bytes:
    """PNG QR-кода для экранов без нативного рендера QR (десктопы).

    Прямоугольный fit=False → модули квадратные, сканеры читают ровнее.
    """
    img: PilImage = qrcode.make(uri, box_size=8, border=2)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()
