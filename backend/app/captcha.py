"""Каптча на регистрации: Cloudflare Turnstile.

Виджет на фронте выдаёт одноразовый токен, бэк проверяет его у Cloudflare
(siteverify). Смысл — не пустить скриптовую массовую регистрацию: rate-limit
режет темп с одного адреса, но не ботнет и не медленный перебор, а каждый
созданный аккаунт — это ещё и письмо подтверждения с нашего домена.

Ключей нет (типичная локальная разработка) — проверка отключается и
регистрация работает как раньше. Это единственный способ оставить поток
проходимым без аккаунта Cloudflare; на проде пустые ключи означают открытую
регистрацию, о чём предупреждает лог при старте (см. main.py).

Тестовые ключи Cloudflare («всегда пройдено») для локальной проверки самого
потока: site 1x00000000000000000000AA, secret 1x0000000000000000000000000000000AA.
"""
import logging
import os

import httpx

logger = logging.getLogger("captcha")

# Публичный ключ виджета. Отдаётся фронту через /auth/captcha-config, а не
# вшивается в бандл на этапе сборки: иначе смена ключа требует пересборки
# фронтенда, а разъехавшаяся пара ключей — нерабочей регистрации.
TURNSTILE_SITE_KEY = os.getenv("TURNSTILE_SITE_KEY", "")
TURNSTILE_SECRET_KEY = os.getenv("TURNSTILE_SECRET_KEY", "")

VERIFY_URL = os.getenv(
    "TURNSTILE_VERIFY_URL",
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
)
# Короткий таймаут: юзер ждёт ответа на кнопку «Зарегистрироваться», а
# siteverify — быстрый запрос. Зависший Cloudflare не должен занимать поток из
# threadpool дольше, чем нужно (тот же повод, что у таймаутов в cache.py).
VERIFY_TIMEOUT = float(os.getenv("TURNSTILE_TIMEOUT", "5"))

# Коды Cloudflare, которые означают проблему НА НАШЕЙ стороне, а не неудачу
# юзера: с ними каптчу не пройдёт никто, и лечится это только правкой конфига.
_OUR_FAULT_CODES = {
    "invalid-input-secret",
    "missing-input-secret",
}


class CaptchaUnavailable(RuntimeError):
    """Проверить токен нечем: Cloudflare недоступен или наш секрет отвергнут."""


def captcha_configured() -> bool:
    """Каптча включена.

    Нужны ОБА ключа: с одним секретом фронту нечего рисовать (регистрация
    станет непроходимой), с одним публичным ключом виджет рисуется, но токен
    никто не проверяет — видимость защиты хуже её отсутствия.
    """
    return bool(TURNSTILE_SECRET_KEY and TURNSTILE_SITE_KEY)


def half_configured() -> bool:
    """Задан ровно один ключ из пары — конфиг сломан, каптча не работает.
    Отдельный признак, чтобы сказать об этом на старте, а не молчать."""
    return bool(TURNSTILE_SECRET_KEY) != bool(TURNSTILE_SITE_KEY)


def verify_captcha(token: str, remote_ip: str | None = None) -> bool:
    """Проверяет токен виджета у Cloudflare.

    False — токен неверен, просрочен или уже использован. Одноразовость
    обеспечивает сам siteverify (повторная проверка того же токена отдаёт
    timeout-or-duplicate), поэтому своего кеша использованных токенов не надо.

    Сетевую ошибку поднимаем как CaptchaUnavailable, а НЕ возвращаем True:
    иначе любой, кто умеет уронить связь до Cloudflare, снимает каптчу.
    """
    if not token:
        return False

    payload = {"secret": TURNSTILE_SECRET_KEY, "response": token}
    if remote_ip:
        # remoteip необязателен, но с ним Cloudflare ловит переиспользование
        # токена с другого адреса.
        payload["remoteip"] = remote_ip

    try:
        response = httpx.post(VERIFY_URL, data=payload, timeout=VERIFY_TIMEOUT)
        response.raise_for_status()
        data = response.json()
    except Exception as exc:  # noqa: BLE001 — сеть/таймаут/не-JSON в ответе
        raise CaptchaUnavailable(str(exc)) from exc

    if data.get("success"):
        return True

    codes = list(data.get("error-codes") or [])
    if _OUR_FAULT_CODES & set(codes):
        # Ошибка конфигурации выглядела бы как поток жалоб «каптча не
        # проходится» — поэтому громко в лог и 503, а не 400 юзеру.
        logger.error("Turnstile rejected our secret: %s", codes)
        raise CaptchaUnavailable(f"secret rejected: {codes}")

    logger.info("captcha not passed: %s", codes)
    return False
