"""Отправка писем по SMTP.

Транспорт и настройки живут здесь, а не в модулях-потребителях: адрес
почтового сервера нужен и подтверждению почты, и кодам входа, а два места
конфигурации гарантированно разъедутся.

Если SMTP не настроен (типичная локальная разработка), письмо не уходит, а
его содержимое пишется в лог — потоки регистрации и входа остаются
проходимыми без почтового сервера.
"""
import logging
import os
import smtplib
from email.message import EmailMessage

logger = logging.getLogger("mailer")

SMTP_HOST = os.getenv("SMTP_HOST", "")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
SMTP_FROM = os.getenv("SMTP_FROM", "noreply@localhost")
SMTP_STARTTLS = os.getenv("SMTP_STARTTLS", "true").lower() in ("1", "true", "yes")
SMTP_TIMEOUT = float(os.getenv("SMTP_TIMEOUT", "10"))


def smtp_configured() -> bool:
    return bool(SMTP_HOST)


def send_mail(to_email: str, subject: str, body: str, *, log_fallback: str = "") -> bool:
    """Отправляет письмо. True — ушло по SMTP, False — SMTP не настроен либо
    отправка не удалась.

    Исключение наружу НЕ поднимается: почтовый сервер, лежащий в неподходящий
    момент, не должен превращать регистрацию или вход в 500. Вызывающий код
    решает сам, что показать юзеру.

    log_fallback — что писать в лог вместо письма, когда SMTP не настроен
    (ссылка подтверждения, код входа). Пустая строка — не логировать ничего,
    для секретов, которые в логе нежелательны даже в разработке.
    """
    if not smtp_configured():
        if log_fallback:
            logger.warning("SMTP is not configured; %s", log_fallback)
        else:
            logger.warning("SMTP is not configured; mail to %s dropped", to_email)
        return False

    try:
        message = EmailMessage()
        message["Subject"] = subject
        message["From"] = SMTP_FROM
        message["To"] = to_email
        message.set_content(body)
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=SMTP_TIMEOUT) as smtp:
            if SMTP_STARTTLS:
                smtp.starttls()
            if SMTP_USER:
                smtp.login(SMTP_USER, SMTP_PASSWORD)
            smtp.send_message(message)
        logger.info("mail sent to %s", to_email)
        return True
    except Exception:  # noqa: BLE001 — почта не должна ронять поток входа
        logger.exception("failed to send mail to %s", to_email)
        if log_fallback:
            logger.warning("undelivered mail; %s", log_fallback)
        return False
