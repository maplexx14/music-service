"""Доверенные устройства: вход с нового устройства требует второй фактор.

Устройство помнится токеном, который клиент хранит в localStorage и присылает
заголовком X-Device-Token. В БД лежит только sha256 от него — дамп базы не
должен давать готовый ключ, которым чужой браузер притворится знакомым.

Токен выдаётся ТОЛЬКО после успешного второго фактора: до этого устройство
ничем не подтверждено, и доверять ему нечего.
"""
import hashlib
import logging
import os
import secrets

from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session
from sqlalchemy.sql import func

from app.models import user_trusted_devices

logger = logging.getLogger("trusted_devices")

# Заголовок, которым клиент предъявляет токен устройства. Не cookie: фронт
# ходит на API с Bearer-токеном и без credentials (см. CORS в main.py).
DEVICE_TOKEN_HEADER = "X-Device-Token"

# Сколько живёт доверие. Полгода — компромисс: заново подтверждать телефон
# каждый месяц юзеры не будут, а вечное доверие превращает украденный
# localStorage в бессрочный пропуск.
DEVICE_TRUST_DAYS = int(os.getenv("DEVICE_TRUST_DAYS", "180"))

# Потолок на юзера: список в настройках должен оставаться обозримым, а без
# лимита каждый новый браузер копит строки без конца. При превышении вытесняем
# самое давно не использованное устройство.
MAX_DEVICES_PER_USER = int(os.getenv("MAX_TRUSTED_DEVICES", "10"))


def generate_device_token() -> str:
    return secrets.token_urlsafe(32)


def hash_device_token(token: str) -> str:
    return hashlib.sha256((token or "").encode()).hexdigest()


def device_label_from_user_agent(user_agent: str | None) -> str:
    """Короткая подпись для списка устройств.

    Полный User-Agent в интерфейсе бесполезен, поэтому вытаскиваем платформу и
    браузер. Порядок проверок важен: Edge/Chrome/Safari врут друг про друга в
    UA, поэтому более специфичные идут первыми.
    """
    ua = (user_agent or "").strip()
    if not ua:
        return "Неизвестное устройство"

    if "iPhone" in ua:
        platform = "iPhone"
    elif "iPad" in ua:
        platform = "iPad"
    elif "Android" in ua:
        platform = "Android"
    elif "Mac OS X" in ua or "Macintosh" in ua:
        platform = "Mac"
    elif "Windows" in ua:
        platform = "Windows"
    elif "Linux" in ua:
        platform = "Linux"
    else:
        platform = "Устройство"

    if "Edg/" in ua:
        browser = "Edge"
    elif "OPR/" in ua or "Opera" in ua:
        browser = "Opera"
    elif "Firefox/" in ua:
        browser = "Firefox"
    elif "Chrome/" in ua:
        browser = "Chrome"
    elif "Safari/" in ua:
        browser = "Safari"
    else:
        browser = None

    return f"{platform} · {browser}" if browser else platform


def is_trusted_device(db: Session, user_id: int, token: str | None) -> bool:
    """Знакомо ли устройство. Заодно продлевает last_seen_at.

    Просроченные записи не удаляем здесь: чистка на пути логина — лишняя
    запись в БД на каждый вход. Просто не считаем устройство доверенным, а
    физически строку вытеснит лимит MAX_DEVICES_PER_USER (см. remember_device).
    """
    if not token:
        return False

    row = db.execute(
        select(user_trusted_devices.c.id, user_trusted_devices.c.last_seen_at).where(
            user_trusted_devices.c.token_hash == hash_device_token(token),
            user_trusted_devices.c.user_id == user_id,
        )
    ).first()
    if row is None:
        return False
    if _is_expired(row.last_seen_at):
        return False

    db.execute(
        update(user_trusted_devices)
        .where(user_trusted_devices.c.id == row.id)
        .values(last_seen_at=func.now())
    )
    db.commit()
    return True


def _is_expired(last_seen) -> bool:
    """Просрочено ли доверие.

    Считаем в Python, а не в SQL: интервалы у Postgres и SQLite пишутся
    по-разному, и один диалект-специфичный SQL сломал бы тесты на sqlite.
    SQLite отдаёт naive datetime, Postgres — aware, поэтому приводим к UTC.
    """
    from datetime import datetime, timedelta, timezone

    if last_seen is None:
        return True
    if last_seen.tzinfo is None:
        last_seen = last_seen.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) - last_seen > timedelta(days=DEVICE_TRUST_DAYS)


def remember_device(
    db: Session, user_id: int, user_agent: str | None, presented_token: str | None = None
) -> str:
    """Запоминает устройство и возвращает токен для клиента.

    Вызывается только после успешного второго фактора. Новый токен возвращается
    в открытом виде один раз — в БД уходит его хэш.

    Если клиент предъявил токен, который уже наш и не просрочен, возвращаем его
    же: у юзера со своей 2FA код спрашивается на каждом входе, и без этой
    проверки каждый вход плодил бы новую строку на то же устройство — список в
    настройках забивался бы дублями, а лимит MAX_DEVICES_PER_USER вытеснял бы
    из него настоящие другие устройства.
    """
    if presented_token and is_trusted_device(db, user_id, presented_token):
        return presented_token

    token = generate_device_token()
    db.execute(
        user_trusted_devices.insert().values(
            user_id=user_id,
            token_hash=hash_device_token(token),
            label=device_label_from_user_agent(user_agent),
        )
    )
    db.commit()
    _evict_extra_devices(db, user_id)
    return token


def _evict_extra_devices(db: Session, user_id: int) -> None:
    """Оставляет MAX_DEVICES_PER_USER самых свежих устройств.

    Вытесняем по last_seen_at: заброшенный браузер полугодовой давности —
    первый кандидат на удаление, активный рабочий ноутбук — последний.
    """
    ids = [
        row.id
        for row in db.execute(
            select(user_trusted_devices.c.id)
            .where(user_trusted_devices.c.user_id == user_id)
            .order_by(user_trusted_devices.c.last_seen_at.desc())
        ).all()
    ]
    extra = ids[MAX_DEVICES_PER_USER:]
    if not extra:
        return
    db.execute(delete(user_trusted_devices).where(user_trusted_devices.c.id.in_(extra)))
    db.commit()


def list_devices(db: Session, user_id: int) -> list[dict]:
    """Устройства юзера для экрана настроек, свежие сверху."""
    rows = db.execute(
        select(
            user_trusted_devices.c.id,
            user_trusted_devices.c.label,
            user_trusted_devices.c.created_at,
            user_trusted_devices.c.last_seen_at,
        )
        .where(user_trusted_devices.c.user_id == user_id)
        .order_by(user_trusted_devices.c.last_seen_at.desc())
    ).all()
    return [
        {
            "id": row.id,
            "label": row.label or "Неизвестное устройство",
            "created_at": row.created_at,
            "last_seen_at": row.last_seen_at,
        }
        for row in rows
    ]


def current_device_id(db: Session, user_id: int, token: str | None) -> int | None:
    """id устройства, с которого пришёл запрос — чтобы в списке настроек
    отметить «это устройство» и не дать отозвать его случайно."""
    if not token:
        return None
    row = db.execute(
        select(user_trusted_devices.c.id).where(
            user_trusted_devices.c.token_hash == hash_device_token(token),
            user_trusted_devices.c.user_id == user_id,
        )
    ).first()
    return row.id if row else None


def revoke_device(db: Session, user_id: int, device_id: int) -> bool:
    """Отзывает доверие. False — устройства нет или оно чужое.

    Фильтр по user_id обязателен: без него любой юзер отзывал бы устройства
    любого другого, подобрав id.
    """
    result = db.execute(
        delete(user_trusted_devices).where(
            user_trusted_devices.c.id == device_id,
            user_trusted_devices.c.user_id == user_id,
        )
    )
    db.commit()
    return result.rowcount > 0


def revoke_all_devices(db: Session, user_id: int, keep_token: str | None = None) -> int:
    """Отзывает все устройства, кроме текущего (если передан его токен).

    Кнопка «выйти со всех устройств»: юзеру нужно вышибить чужой доступ, не
    выкинув себя из текущего браузера.
    """
    query = delete(user_trusted_devices).where(user_trusted_devices.c.user_id == user_id)
    if keep_token:
        query = query.where(user_trusted_devices.c.token_hash != hash_device_token(keep_token))
    result = db.execute(query)
    db.commit()
    return result.rowcount
