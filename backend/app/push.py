"""Web Push: подписки, ключ VAPID и ежедневная рассылка.

Зачем: новички почти не возвращаются сами — повода открыть сервис второй раз
у них нет (замер 2026-10-21: из 15 новичков с 10-09 большинство ушло за
1–4 дня, писем и уведомлений сервис не слал вовсе). Поэтому раз в день, в
``PUSH_HOUR_UTC`` (по умолчанию 16 UTC = 19 МСК), подписанным юзерам уходит
не больше одного уведомления:

* ``release`` — у любимого артиста (явный выбор + профиль вкуса) за последние
  ``RELEASE_WINDOW_DAYS`` дней вышел релиз, о котором мы ещё не сообщали
  (дата релиза — по публичному api.deezer.com, тот же источник, что у
  карточек артистов);
* ``reengage`` — релизов нет, а юзер не заходил ``REENGAGE_AFTER_DAYS`` дней:
  напоминание про волну, не чаще раза в ``REENGAGE_EVERY_DAYS`` и не больше
  ``REENGAGE_MAX`` подряд без захода — дальше молчим, пока не вернётся.

Каждый вид юзер выключает отдельно (users.push_releases / push_reminders).

Ссылка уведомления несёт ``?push=<kind>``: фронт отмечает открытие
(POST /api/push/opened), и в ``push:stats:<дата>`` видно sent/opened по видам.

Ключ VAPID: из ``VAPID_PRIVATE_KEY`` (base64url, 32 байта), иначе создаётся
сам и хранится в ``app_secrets`` — менять его нельзя, подписки привязаны к
публичной половине.
"""

import asyncio
import json
import logging
import os
from datetime import date, datetime, timedelta, timezone
from typing import Iterable, List, Optional
from urllib.parse import quote, urlparse

from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid02, b64urlencode
from pywebpush import WebPushException, webpush
from sqlalchemy import delete, insert, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.artist_utils import artist_key
from app.cache import get_cache_async, redis_client, set_cache_async
from app.email_verification import PUBLIC_URL
from app.models import User, app_secrets, push_subscriptions

logger = logging.getLogger(__name__)

PUSH_HOUR_UTC = int(os.getenv("PUSH_HOUR_UTC", "16"))
# Push-сервис держит недоставленное (телефон выключен) сутки, дальше релиз
# уже не новость.
PUSH_TTL = 24 * 3600
RELEASE_WINDOW_DAYS = 7
MAX_ARTISTS = 15
REENGAGE_AFTER_DAYS = 2
REENGAGE_EVERY_DAYS = 3
REENGAGE_MAX = 3

_VAPID_SECRET = "vapid_private_key"
_ALBUMS_TTL = 12 * 3600
_STATS_TTL = 120 * 24 * 3600
_NOTIFIED_TTL = 60 * 24 * 3600

# Сервер сам шлёт POST на endpoint подписки — это URL от клиента. Без списка
# push-сервисов браузеров подписка стала бы способом заставить бэкенд ходить
# во внутреннюю сеть.
_PUSH_HOSTS = (
    "fcm.googleapis.com",
    "android.googleapis.com",
    "updates.push.services.mozilla.com",
    "web.push.apple.com",
)
_PUSH_HOST_SUFFIXES = (".push.apple.com", ".notify.windows.com", ".push.services.mozilla.com")

_TYPE_WORD = {"single": "сингл", "album": "альбом", "ep": "EP"}

_vapid: Optional[Vapid02] = None


def endpoint_allowed(endpoint: str) -> bool:
    try:
        url = urlparse(endpoint)
    except ValueError:
        return False
    host = (url.hostname or "").lower()
    if url.scheme != "https" or not host or url.port not in (None, 443):
        return False
    return host in _PUSH_HOSTS or host.endswith(_PUSH_HOST_SUFFIXES)


# ─────────────────────────────── ключ VAPID ───────────────────────────────


def _generate_private_key() -> str:
    key = Vapid02()
    key.generate_keys()
    return b64urlencode(key.private_key.private_numbers().private_value.to_bytes(32, "big"))


def vapid_key(db: Session) -> Vapid02:
    global _vapid
    if _vapid is not None:
        return _vapid
    raw = os.getenv("VAPID_PRIVATE_KEY", "").strip()
    if not raw:
        raw = db.execute(select(app_secrets.c.value).where(app_secrets.c.name == _VAPID_SECRET)).scalar()
    if not raw:
        try:
            db.execute(insert(app_secrets).values(name=_VAPID_SECRET, value=_generate_private_key()))
            db.commit()
        except IntegrityError:
            # Соседний воркер создал ключ первым — берём его.
            db.rollback()
        raw = db.execute(select(app_secrets.c.value).where(app_secrets.c.name == _VAPID_SECRET)).scalar()
    _vapid = Vapid02.from_raw(raw.encode())
    return _vapid


def public_key(db: Session) -> str:
    point = vapid_key(db).public_key.public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    return b64urlencode(point)


def _claims() -> dict:
    # Apple отвергает sub не вида mailto:/https:.
    subject = os.getenv("VAPID_SUBJECT", "").strip()
    if not subject:
        subject = PUBLIC_URL if PUBLIC_URL.startswith("https://") else "mailto:noreply@localhost"
    return {"sub": subject}


# ─────────────────────────────── подписки ───────────────────────────────


def save_subscription(
    db: Session, user_id: int, endpoint: str, p256dh: str, auth: str, user_agent: Optional[str]
) -> None:
    """Подписка устройства. Endpoint уже чей-то (вышел один, вошёл другой на
    том же браузере) — переходит новому владельцу."""
    values = {"user_id": user_id, "p256dh": p256dh, "auth": auth, "user_agent": (user_agent or "")[:512]}
    found = db.execute(
        update(push_subscriptions).where(push_subscriptions.c.endpoint == endpoint).values(**values)
    ).rowcount
    if not found:
        db.execute(insert(push_subscriptions).values(endpoint=endpoint, **values))
    db.commit()


def remove_subscription(db: Session, user_id: int, endpoint: str) -> None:
    db.execute(
        delete(push_subscriptions).where(
            push_subscriptions.c.user_id == user_id, push_subscriptions.c.endpoint == endpoint
        )
    )
    db.commit()


def send_to_user(db: Session, user_id: int, payload: dict) -> int:
    """Шлёт уведомление на все устройства юзера (блокирующая). → сколько
    дошло до push-сервиса. Протухшие подписки (404/410) удаляет."""
    rows = db.execute(select(push_subscriptions).where(push_subscriptions.c.user_id == user_id)).fetchall()
    if not rows:
        return 0
    key = vapid_key(db)
    data = json.dumps(payload, ensure_ascii=False)
    sent = 0
    for row in rows:
        info = {"endpoint": row.endpoint, "keys": {"p256dh": row.p256dh, "auth": row.auth}}
        try:
            webpush(info, data=data, vapid_private_key=key, vapid_claims=_claims(), ttl=PUSH_TTL, timeout=10)
        except WebPushException as exc:
            status = getattr(exc.response, "status_code", None)
            if status in (404, 410):
                db.execute(delete(push_subscriptions).where(push_subscriptions.c.id == row.id))
                db.commit()
            else:
                logger.warning("push to user %s failed: %s %s", user_id, status, str(exc)[:200])
            continue
        except Exception as exc:  # noqa: BLE001 — сеть до push-сервиса, остальные устройства не страдают
            logger.warning("push to user %s failed: %r", user_id, exc)
            continue
        sent += 1
        db.execute(
            update(push_subscriptions)
            .where(push_subscriptions.c.id == row.id)
            .values(last_success_at=datetime.now(timezone.utc))
        )
        db.commit()
    return sent


# ─────────────────────────────── статистика ───────────────────────────────


def _stats_key(day: date) -> str:
    return f"push:stats:{day.isoformat()}"


def record_stat(field: str, day: Optional[date] = None) -> None:
    key = _stats_key(day or datetime.now(timezone.utc).date())
    try:
        redis_client.hincrby(key, field, 1)
        redis_client.expire(key, _STATS_TTL)
    except Exception:  # noqa: BLE001 — статистика не должна ронять отправку
        pass


# ─────────────────────────────── релизы ───────────────────────────────


async def artist_releases(name: str) -> List[dict]:
    """Релизы артиста из Deezer: [{id, title, type, date, artist}], кэш 12 ч."""
    from app import artist_cards

    card = await artist_cards.artist_card(name)
    deezer_id = card.get("deezer_id")
    if not deezer_id:
        return []
    cache_key = f"artist_albums:v1:{deezer_id}"
    cached = await get_cache_async(cache_key)
    if isinstance(cached, list):
        return [{**item, "artist": name} for item in cached]
    data = await artist_cards._api_get(f"/artist/{deezer_id}/albums", {"limit": 25})
    if data is None:
        return []
    items = [
        {
            "id": int(item["id"]),
            "title": (item.get("title") or "").strip(),
            "type": (item.get("record_type") or "").lower(),
            "date": item.get("release_date") or "",
        }
        for item in data.get("data") or []
        if item.get("id") and item.get("title") and item.get("release_date")
    ]
    await set_cache_async(cache_key, items, expire=_ALBUMS_TTL)
    return [{**item, "artist": name} for item in items]


def fresh_releases(releases: Iterable[dict], today: date, notified: Iterable[str]) -> List[dict]:
    """Вышедшие за окно и ещё не объявленные, свежие первыми. Дата в будущем —
    анонс предзаказа: слушать ещё нечего."""
    since = (today - timedelta(days=RELEASE_WINDOW_DAYS)).isoformat()
    until = today.isoformat()
    seen = set(notified)
    fresh = {}
    for item in releases:
        if since <= item["date"] <= until and str(item["id"]) not in seen:
            fresh.setdefault(item["id"], item)
    return sorted(fresh.values(), key=lambda item: item["date"], reverse=True)


def favorite_artists(db: Session, user: User) -> List[str]:
    """Явно выбранные артисты, затем топ профиля вкуса; без исключённых и
    забаненных скипами."""
    from app.routers.flow import _taste_profile

    try:
        profile = _taste_profile(db, user.id)
    except Exception:  # noqa: BLE001 — без профиля обойдёмся явным выбором
        logger.exception("taste profile for push failed: user %s", user.id)
        profile = {}
    blocked = {artist_key(a) for a in (user.excluded_artists or [])}
    blocked |= {artist_key(a) for a in profile.get("banned_artists") or [] if isinstance(a, str)}
    result: List[str] = []
    seen = set()
    for name in list(user.preferred_artists or []) + list(profile.get("artists") or []):
        if not isinstance(name, str) or not name.strip():
            continue
        key = artist_key(name)
        if key in seen or key in blocked:
            continue
        seen.add(key)
        result.append(name.strip())
        if len(result) >= MAX_ARTISTS:
            break
    return result


# ─────────────────────────────── сообщения ───────────────────────────────


def release_message(fresh: List[dict]) -> dict:
    first = fresh[0]
    url = f"/artists/{quote(first['artist'], safe='')}?push=release"
    if len(fresh) == 1:
        word = _TYPE_WORD.get(first["type"], "релиз")
        return {
            "title": f"{first['artist']}: новый {word}",
            "body": f"«{first['title']}» — уже можно слушать",
            "url": url,
            "tag": f"release-{first['id']}",
        }
    shown = [f"{item['artist']} — «{item['title']}»" for item in fresh[:2]]
    more = len(fresh) - len(shown)
    body = ", ".join(shown) + (f" и ещё {more}" if more else "")
    return {"title": "Новое у ваших артистов", "body": body, "url": url, "tag": "release"}


def reengage_message(artists: List[str]) -> dict:
    if len(artists) >= 2:
        body = f"{artists[0]}, {artists[1]} и новые находки — включите, когда будет минутка"
    elif artists:
        body = f"{artists[0]} и похожие — включите, когда будет минутка"
    else:
        body = "Подобрали музыку под ваш вкус — включите, когда будет минутка"
    return {"title": "Свежая волна готова", "body": body, "url": "/?push=reengage", "tag": "reengage"}


def reengage_due(last_seen: Optional[datetime], now: datetime, state: dict) -> bool:
    """Пора ли напомнить. state — {seen, n, at}: seen — last_seen на момент
    прошлых напоминаний (зашёл с тех пор — счёт сначала)."""
    if last_seen is None or now - last_seen < timedelta(days=REENGAGE_AFTER_DAYS):
        return False
    if state.get("seen") != last_seen.isoformat():
        return True
    if int(state.get("n") or 0) >= REENGAGE_MAX:
        return False
    at = state.get("at")
    return at is None or now.timestamp() - float(at) >= REENGAGE_EVERY_DAYS * 86400


# ─────────────────────────────── рассылка ───────────────────────────────


def _subscribed_users(db: Session) -> List[User]:
    ids = select(push_subscriptions.c.user_id).distinct()
    return db.query(User).filter(User.id.in_(ids), User.is_active.is_(True)).all()


def _notified_key(user_id: int) -> str:
    return f"push:notified:{user_id}"


def _reengage_key(user_id: int) -> str:
    return f"push:reengage:{user_id}"


async def notify_user(db: Session, user: User, now: datetime) -> Optional[str]:
    """Решает и отправляет одно уведомление юзеру. → вид или None."""
    artists = await asyncio.to_thread(favorite_artists, db, user)
    try:
        notified = await asyncio.to_thread(redis_client.smembers, _notified_key(user.id))
    except Exception:  # noqa: BLE001 — без Redis не отличить объявленное: молчим
        return None

    releases: List[dict] = []
    if user.push_releases:
        for name in artists:
            releases.extend(await artist_releases(name))
    fresh = fresh_releases(releases, now.date(), notified)

    kind = None
    if fresh:
        kind, payload = "release", release_message(fresh)
    elif user.push_reminders:
        state = await get_cache_async(_reengage_key(user.id)) or {}
        last_seen = user.last_seen
        if last_seen is not None and last_seen.tzinfo is None:
            last_seen = last_seen.replace(tzinfo=timezone.utc)
        if reengage_due(last_seen, now, state):
            kind, payload = "reengage", reengage_message(artists)
    if kind is None:
        return None

    sent = await asyncio.to_thread(send_to_user, db, user.id, payload)
    if not sent:
        return None
    record_stat(f"sent_{kind}", now.date())
    if kind == "release":
        try:
            ids = [str(item["id"]) for item in fresh]
            redis_client.sadd(_notified_key(user.id), *ids)
            redis_client.expire(_notified_key(user.id), _NOTIFIED_TTL)
        except Exception:  # noqa: BLE001
            pass
    else:
        seen = last_seen.isoformat()
        n = int(state.get("n") or 0) + 1 if state.get("seen") == seen else 1
        await set_cache_async(
            _reengage_key(user.id), {"seen": seen, "n": n, "at": now.timestamp()}, expire=_NOTIFIED_TTL
        )
    return kind


async def run_round(now: Optional[datetime] = None) -> dict:
    """Один проход рассылки по всем подписанным. → {вид: сколько}."""
    from app.database import SessionLocal

    now = now or datetime.now(timezone.utc)
    db = SessionLocal()
    counts: dict = {}
    try:
        users = await asyncio.to_thread(_subscribed_users, db)
        for user in users:
            try:
                kind = await notify_user(db, user, now)
            except Exception:  # noqa: BLE001 — один юзер не срывает рассылку остальным
                logger.exception("push round failed for user %s", user.id)
                db.rollback()
                continue
            if kind:
                counts[kind] = counts.get(kind, 0) + 1
    finally:
        db.close()
    logger.info("push round: %d subscribed, sent %s", len(users), counts)
    return counts
