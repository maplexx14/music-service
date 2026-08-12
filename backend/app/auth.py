from datetime import datetime, timedelta
from typing import Optional
from jose import JWTError, jwt
from passlib.context import CryptContext
import bcrypt
import os

SECRET_KEY = os.getenv("SECRET_KEY")
if not SECRET_KEY:
    if os.getenv("DEBUG", "").lower() in ("1", "true", "yes"):
        SECRET_KEY = "dev-only-insecure-secret"
    else:
        raise RuntimeError("SECRET_KEY environment variable must be set (or set DEBUG=true for local development)")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "43800"))
# Промежуточный токен между «пароль верный» и «код 2FA верный». Живёт минуты:
# он не даёт доступа к API, но им нельзя разбрасываться — это половина входа.
MFA_TOKEN_EXPIRE_MINUTES = int(os.getenv("MFA_TOKEN_EXPIRE_MINUTES", "5"))

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def _truncate_password(password: str) -> str:
    """
    Truncate password to 72 bytes to comply with bcrypt limit.
    Bcrypt has a hard limit of 72 bytes, so we need to ensure we don't exceed it.
    """
    # Convert to bytes to check actual byte length
    password_bytes = password.encode('utf-8')
    if len(password_bytes) <= 72:
        return password
    
    # Truncate to 72 bytes
    truncated_bytes = password_bytes[:72]
    
    # Try to decode, but if we cut in the middle of a multi-byte character,
    # we need to remove incomplete characters
    while True:
        try:
            return truncated_bytes.decode('utf-8')
        except UnicodeDecodeError:
            # Remove the last byte and try again
            truncated_bytes = truncated_bytes[:-1]
            if len(truncated_bytes) == 0:
                return ""


def verify_password(plain_password: str, hashed_password: str) -> bool:
    # Apply the same truncation as in get_password_hash for consistency
    truncated_password = _truncate_password(plain_password)
    # Use bcrypt directly to avoid passlib's length check
    password_bytes = truncated_password.encode('utf-8')
    hashed_bytes = hashed_password.encode('utf-8')
    return bcrypt.checkpw(password_bytes, hashed_bytes)


def get_password_hash(password: str) -> str:
    # Bcrypt has a 72 byte limit, so truncate if necessary
    truncated_password = _truncate_password(password)
    # Use bcrypt directly to avoid passlib's length check
    password_bytes = truncated_password.encode('utf-8')
    hashed = bcrypt.hashpw(password_bytes, bcrypt.gensalt())
    return hashed.decode('utf-8')


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None):
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt


def decode_token(token: str) -> Optional[dict]:
    """Полный payload или None. Нужен там, где важны claim'ы, а не только sub."""
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        return None


def verify_token(token: str) -> Optional[str]:
    """Username из ПОЛНОЦЕННОГО access-токена.

    Токены с mfa=True отклоняются: это промежуточный токен шага 2FA (выдан
    после пароля, до кода). Пропусти его здесь — и второй фактор обходится
    простой подстановкой mfa_token в заголовок Authorization.
    """
    payload = decode_token(token)
    if payload is None or payload.get("mfa"):
        return None
    username: str = payload.get("sub")
    if username is None:
        return None
    return username


def verify_mfa_token(token: str) -> Optional[str]:
    """Username из промежуточного токена шага 2FA. Обратная сторона:
    полноценный access_token тут тоже не принимается — шаги не смешиваем."""
    payload = decode_token(token)
    if payload is None or not payload.get("mfa"):
        return None
    return payload.get("sub")
