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
import ssl
import smtplib
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

logger = logging.getLogger("mailer")

SMTP_HOST = os.getenv("SMTP_HOST", "")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
SMTP_FROM = os.getenv("SMTP_FROM", "noreply@localhost")
SMTP_FROM_NAME = os.getenv("SMTP_FROM_NAME", "bolt")
SMTP_REPLY_TO = os.getenv("SMTP_REPLY_TO", "")
SMTP_SECURITY = os.getenv("SMTP_SECURITY", "").strip().lower()
if not SMTP_SECURITY:
    # Backwards-compatible mapping for existing deployments.
    SMTP_SECURITY = (
        "starttls"
        if os.getenv("SMTP_STARTTLS", "true").lower() in ("1", "true", "yes")
        else "plain"
    )
SMTP_TIMEOUT = float(os.getenv("SMTP_TIMEOUT", "10"))
SMTP_REQUIRED = os.getenv("SMTP_REQUIRED", "false").lower() in ("1", "true", "yes")

VALID_SMTP_SECURITY = {"starttls", "ssl", "plain"}


def smtp_configuration_errors() -> list[str]:
    errors = []
    if not SMTP_HOST:
        errors.append("SMTP_HOST is empty")
    if not SMTP_FROM or "@" not in SMTP_FROM:
        errors.append("SMTP_FROM must be a valid email address")
    if SMTP_SECURITY not in VALID_SMTP_SECURITY:
        errors.append("SMTP_SECURITY must be one of: starttls, ssl, plain")
    if bool(SMTP_USER) != bool(SMTP_PASSWORD):
        errors.append("SMTP_USER and SMTP_PASSWORD must be set together")
    if not 1 <= SMTP_PORT <= 65535:
        errors.append("SMTP_PORT must be between 1 and 65535")
    if SMTP_TIMEOUT <= 0:
        errors.append("SMTP_TIMEOUT must be greater than zero")
    return errors


def smtp_configured() -> bool:
    return not smtp_configuration_errors()


def send_mail(
    to_email: str,
    subject: str,
    body: str,
    *,
    html: str | None = None,
    log_fallback: str = "",
) -> bool:
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
        message["From"] = f"{SMTP_FROM_NAME} <{SMTP_FROM}>" if SMTP_FROM_NAME else SMTP_FROM
        message["To"] = to_email
        message["Date"] = formatdate(localtime=False)
        message["Message-ID"] = make_msgid(domain=SMTP_FROM.rpartition("@")[2] or None)
        if SMTP_REPLY_TO:
            message["Reply-To"] = SMTP_REPLY_TO
        message.set_content(body)
        if html:
            message.add_alternative(html, subtype="html")

        context = ssl.create_default_context()
        smtp_class = smtplib.SMTP_SSL if SMTP_SECURITY == "ssl" else smtplib.SMTP
        smtp_kwargs = {"host": SMTP_HOST, "port": SMTP_PORT, "timeout": SMTP_TIMEOUT}
        if SMTP_SECURITY == "ssl":
            smtp_kwargs["context"] = context
        with smtp_class(**smtp_kwargs) as smtp:
            if SMTP_SECURITY == "starttls":
                smtp.ehlo()
                smtp.starttls(context=context)
                smtp.ehlo()
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
