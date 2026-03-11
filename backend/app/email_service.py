import aiosmtplib
import random
import string
import os
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from app.cache import redis_client

# SMTP Configuration from environment variables
SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
SMTP_FROM = os.getenv("SMTP_FROM", SMTP_USER)
SMTP_USE_TLS = os.getenv("SMTP_USE_TLS", "true").lower() == "true"

VERIFICATION_CODE_TTL = 600  # 10 minutes


def generate_code(length: int = 6) -> str:
    """Generate a numeric verification code"""
    return ''.join(random.choices(string.digits, k=length))


async def store_verification_code(email: str, code: str):
    """Store verification code in Redis with TTL"""
    key = f"email_verify:{email}"
    await redis_client.setex(key, VERIFICATION_CODE_TTL, code)


async def get_verification_code(email: str) -> str | None:
    """Get stored verification code from Redis"""
    key = f"email_verify:{email}"
    return await redis_client.get(key)


async def delete_verification_code(email: str):
    """Delete verification code after successful verification"""
    key = f"email_verify:{email}"
    await redis_client.delete(key)


async def send_verification_email(email: str, code: str):
    """Send verification code to user's email"""
    if not SMTP_USER or not SMTP_PASSWORD:
        # If SMTP is not configured, just log the code (dev mode)
        print(f"[DEV MODE] Verification code for {email}: {code}")
        return True

    msg = MIMEMultipart("alternative")
    msg["From"] = SMTP_FROM
    msg["To"] = email
    msg["Subject"] = "BoltMusic — Код подтверждения"

    html_body = f"""
    <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 480px; margin: 0 auto; background: #121212; border-radius: 16px; padding: 40px 32px; color: #ffffff;">
        <div style="text-align: center; margin-bottom: 32px;">
            <span style="font-size: 32px;">♪</span>
            <h1 style="font-size: 24px; font-weight: 700; margin: 8px 0 0; color: #ffffff;">BoltMusic</h1>
        </div>
        <p style="font-size: 16px; color: #b3b3b3; text-align: center; margin-bottom: 24px;">
            Ваш код подтверждения:
        </p>
        <div style="background: #1db954; border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 24px;">
            <span style="font-size: 36px; font-weight: 700; letter-spacing: 8px; color: #000000;">{code}</span>
        </div>
        <p style="font-size: 14px; color: #666; text-align: center;">
            Код действителен в течение 10 минут.<br>
            Если вы не запрашивали этот код, просто проигнорируйте это письмо.
        </p>
    </div>
    """

    text_body = f"Ваш код подтверждения BoltMusic: {code}\nКод действителен 10 минут."

    msg.attach(MIMEText(text_body, "plain"))
    msg.attach(MIMEText(html_body, "html"))

    try:
        await aiosmtplib.send(
            msg,
            hostname=SMTP_HOST,
            port=SMTP_PORT,
            username=SMTP_USER,
            password=SMTP_PASSWORD,
            start_tls=SMTP_USE_TLS,
        )
        return True
    except Exception as e:
        print(f"Failed to send email to {email}: {e}")
        return False
