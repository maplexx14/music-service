from datetime import datetime, timezone

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import User
from app.auth import verify_token
from app.cache import set_cache

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="api/auth/login")
oauth2_scheme_optional = OAuth2PasswordBearer(tokenUrl="api/auth/login", auto_error=False)

# Как часто колонка users.last_seen может обновляться в БД. Живой маркер
# онлайна и так живёт в Redis 120 секунд, поэтому писать last_seen чаще
# минуты ничего не даёт — только лишний UPDATE на каждый запрос.
LAST_SEEN_WRITE_INTERVAL = 60.0


def _touch_last_seen(db: Session, user: User) -> None:
    now = datetime.now(timezone.utc)
    last = user.last_seen
    if last is not None:
        # sqlite (тестовый suite) отдаёт наивный datetime — приводим к aware,
        # иначе вычитание ниже кидает TypeError.
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        if (now - last).total_seconds() < LAST_SEEN_WRITE_INTERVAL:
            return
    user.last_seen = now
    # get_db не коммитит, а эндпоинт не обязан знать про эту запись —
    # фиксируем сразу, пока транзакция не закрылась вместе с сессией.
    db.commit()


async def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db)
) -> User:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    username = verify_token(token)
    if username is None:
        raise credentials_exception
    user = db.query(User).filter(User.username == username).first()
    if user is None:
        raise credentials_exception
    # Presence marker used by the admin dashboard. Short TTL means stale
    # browser tabs disappear automatically without a logout request.
    set_cache(f"users:online:{user.id}", True, expire=120)
    _touch_last_seen(db, user)
    return user


async def get_current_user_optional(
    token: str | None = Depends(oauth2_scheme_optional),
    db: Session = Depends(get_db)
) -> User | None:
    # Как get_current_user, но без 401 — для эндпоинтов, доступных и анонимно.
    if not token:
        return None
    username = verify_token(token)
    if username is None:
        return None
    return db.query(User).filter(User.username == username).first()


async def get_current_active_user(
    current_user: User = Depends(get_current_user)
) -> User:
    if not current_user.is_active:
        raise HTTPException(status_code=400, detail="Inactive user")
    return current_user


async def get_current_admin_user(
    current_user: User = Depends(get_current_active_user)
) -> User:
    if not current_user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin privileges required"
        )
    return current_user
