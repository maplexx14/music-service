from datetime import datetime, timedelta
from typing import Optional
from jose import JWTError, jwt
from passlib.context import CryptContext
import bcrypt
import os

SECRET_KEY = os.getenv("SECRET_KEY", "your-secret-key-change-in-production")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "43800"))

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


def verify_token(token: str) -> Optional[str]:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username: str = payload.get("sub")
        if username is None:
            return None
        return username
    except JWTError:
        return None
