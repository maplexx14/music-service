import time
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

# Маркер онлайна (users:online:<id>) живёт в Redis ONLINE_MARKER_TTL секунд,
# а обновлять его достаточно раз в ONLINE_MARKER_INTERVAL: ключ не успевает
# истечь. Раньше SETEX шёл на каждый авторизованный запрос — под нагрузкой это
# ~20% времени треда на сетевой round-trip ради записи, которая ничего не
# меняет. Память процесса, не Redis: у каждого gunicorn-воркера своя, так что
# на юзера выходит до GUNICORN_WORKERS записей в минуту вместо одной — всё
# равно на порядки меньше, чем по записи на запрос. Гонка тредов безвредна:
# худшее — лишний SETEX.
ONLINE_MARKER_TTL = 120
ONLINE_MARKER_INTERVAL = 60.0
_online_marked_at: dict[int, float] = {}


def _mark_online(user_id: int) -> None:
    now = time.monotonic()
    if now - _online_marked_at.get(user_id, float("-inf")) < ONLINE_MARKER_INTERVAL:
        return
    _online_marked_at[user_id] = now
    set_cache(f"users:online:{user_id}", True, expire=ONLINE_MARKER_TTL)


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


# Именно def, а не async def: внутри блокирующие SELECT, UPDATE last_seen и
# запись в Redis. В async-версии они шли прямо в event loop и останавливали
# воркер целиком, а когда пул соединений кончался, loop висел в
# QueuePool.get и сам же не давал вернуть соединения — после ~50 параллельных
# запросов RPS падал вместо того, чтобы выйти на плато. Как def FastAPI
# выполняет зависимость в threadpool, и ожидание пула блокирует только тред.
def get_current_user(
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
    _mark_online(user.id)
    _touch_last_seen(db, user)
    return user


def get_current_user_optional(
    token: str | None = Depends(oauth2_scheme_optional),
    db: Session = Depends(get_db)
) -> User | None:
    # Как get_current_user, но без 401 — для эндпоинтов, доступных и анонимно.
    # def по той же причине: SELECT блокирующий.
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
