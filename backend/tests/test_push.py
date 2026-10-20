import asyncio
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from pywebpush import WebPushException
from sqlalchemy import select

from app import push
from app.cache import redis_client
from app.models import app_secrets, push_subscriptions
from tests.conftest import auth_headers, create_user

FCM = "https://fcm.googleapis.com/fcm/send/abc"
KEYS = {"p256dh": "B" + "x" * 86, "auth": "a" * 22}


@pytest.fixture(autouse=True)
def _fresh_vapid(monkeypatch):
    monkeypatch.delenv("VAPID_PRIVATE_KEY", raising=False)
    monkeypatch.setattr(push, "_vapid", None)


@pytest.fixture()
def _clean_push_keys():
    def clean():
        for pattern in ("push:notified:*", "push:reengage:*", "push:stats:*"):
            for key in redis_client.scan_iter(pattern):
                redis_client.delete(key)

    clean()
    yield
    clean()


def test_endpoint_allowed_only_for_browser_push_services():
    assert push.endpoint_allowed(FCM)
    assert push.endpoint_allowed("https://web.push.apple.com/QGx")
    assert push.endpoint_allowed("https://wns2-db5p.notify.windows.com/w/?token=1")
    assert push.endpoint_allowed("https://updates.push.services.mozilla.com/wpush/v2/x")
    assert not push.endpoint_allowed("http://fcm.googleapis.com/fcm/send/abc")
    assert not push.endpoint_allowed("https://fcm.googleapis.com:8443/x")
    assert not push.endpoint_allowed("https://evil.example.com/fcm.googleapis.com")
    assert not push.endpoint_allowed("https://fcm.googleapis.com.evil.example/x")
    assert not push.endpoint_allowed("https://127.0.0.1/x")


def test_config_creates_vapid_key_once(client, db):
    create_user(db)
    first = client.get("/api/push/config", headers=auth_headers(client)).json()["public_key"]
    push._vapid = None
    second = client.get("/api/push/config", headers=auth_headers(client)).json()["public_key"]
    assert first == second
    assert len(first) == 87  # несжатая точка P-256 в base64url
    assert db.execute(select(app_secrets.c.name)).scalars().all() == ["vapid_private_key"]


def test_subscribe_moves_endpoint_to_new_owner_and_unsubscribes(client, db):
    alice = create_user(db)
    bob = create_user(db, username="bob")
    body = {"endpoint": FCM, "keys": KEYS}

    assert client.post("/api/push/subscribe", json=body, headers=auth_headers(client)).status_code == 204
    assert client.post("/api/push/subscribe", json=body, headers=auth_headers(client, "bob")).status_code == 204
    rows = db.execute(select(push_subscriptions.c.user_id)).scalars().all()
    assert rows == [bob.id]

    # Чужую подписку не снять.
    client.post("/api/push/unsubscribe", json={"endpoint": FCM}, headers=auth_headers(client))
    assert db.execute(select(push_subscriptions.c.user_id)).scalars().all() == [bob.id]
    client.post("/api/push/unsubscribe", json={"endpoint": FCM}, headers=auth_headers(client, "bob"))
    assert db.execute(select(push_subscriptions.c.user_id)).scalars().all() == []
    assert alice.id != bob.id


def test_subscribe_rejects_unknown_push_host(client, db):
    create_user(db)
    body = {"endpoint": "https://internal.local/hook", "keys": KEYS}
    assert client.post("/api/push/subscribe", json=body, headers=auth_headers(client)).status_code == 400


def test_send_drops_gone_subscription(db, monkeypatch):
    user = create_user(db)
    push.save_subscription(db, user.id, FCM, KEYS["p256dh"], KEYS["auth"], "test")
    push.save_subscription(db, user.id, FCM + "2", KEYS["p256dh"], KEYS["auth"], "test")

    def fake_webpush(info, **kwargs):
        if info["endpoint"] == FCM:
            raise WebPushException("gone", response=SimpleNamespace(status_code=410))

    monkeypatch.setattr(push, "webpush", fake_webpush)
    assert push.send_to_user(db, user.id, {"title": "t"}) == 1
    assert db.execute(select(push_subscriptions.c.endpoint)).scalars().all() == [FCM + "2"]


def _release(id_, day, artist="Linkin Park", type_="single"):
    return {"id": id_, "title": f"Song {id_}", "type": type_, "date": day, "artist": artist}


def test_fresh_releases_window_future_and_notified():
    today = date(2026, 10, 21)
    releases = [
        _release(1, "2026-10-20"),
        _release(2, "2026-10-14"),  # ровно 7 дней — ещё в окне
        _release(3, "2026-10-13"),  # старше окна
        _release(4, "2026-10-25"),  # предзаказ
        _release(5, "2026-10-21"),
        _release(1, "2026-10-20", artist="Другое написание"),  # дубль id
    ]
    fresh = push.fresh_releases(releases, today, notified={"5"})
    assert [item["id"] for item in fresh] == [1, 2]


def test_release_message_one_and_many():
    one = push.release_message([_release(7, "2026-10-20")])
    assert one["title"] == "Linkin Park: новый сингл"
    assert one["url"] == "/artists/Linkin%20Park?push=release"
    many = push.release_message(
        [_release(1, "2026-10-20"), _release(2, "2026-10-19", "Земфира", "album"), _release(3, "2026-10-18")]
    )
    assert many["title"] == "Новое у ваших артистов"
    assert many["body"].endswith("и ещё 1")


def test_reengage_due_rules():
    now = datetime(2026, 10, 21, 16, tzinfo=timezone.utc)
    seen = now - timedelta(days=3)
    assert not push.reengage_due(now - timedelta(days=1), now, {})
    assert not push.reengage_due(None, now, {})
    assert push.reengage_due(seen, now, {})
    recent = {"seen": seen.isoformat(), "n": 1, "at": (now - timedelta(days=1)).timestamp()}
    assert not push.reengage_due(seen, now, recent)
    assert push.reengage_due(seen, now, {**recent, "at": (now - timedelta(days=3)).timestamp()})
    assert not push.reengage_due(seen, now, {**recent, "n": push.REENGAGE_MAX, "at": 0})
    # Заходил после прошлых напоминаний — счёт сначала.
    assert push.reengage_due(seen, now, {"seen": "old", "n": push.REENGAGE_MAX, "at": now.timestamp()})


def test_notify_user_announces_release_once(db, monkeypatch, _clean_push_keys):
    user = create_user(db)
    now = datetime(2026, 10, 21, 16, tzinfo=timezone.utc)
    sent = []

    async def releases(name):
        return [_release(42, "2026-10-20", artist=name)]

    monkeypatch.setattr(push, "favorite_artists", lambda db_, user_: ["Linkin Park"])
    monkeypatch.setattr(push, "artist_releases", releases)
    monkeypatch.setattr(push, "send_to_user", lambda db_, uid, payload: sent.append(payload) or 1)

    assert asyncio.run(push.notify_user(db, user, now)) == "release"
    assert sent[0]["tag"] == "release-42"
    # Тот же релиз второй раз не объявляется; юзер активен — напоминать незачем.
    user.last_seen = now - timedelta(hours=1)
    assert asyncio.run(push.notify_user(db, user, now)) is None
    assert len(sent) == 1


def test_notify_user_reengages_inactive_user(db, monkeypatch, _clean_push_keys):
    user = create_user(db)
    now = datetime(2026, 10, 21, 16, tzinfo=timezone.utc)
    user.last_seen = now - timedelta(days=3)
    sent = []

    async def no_releases(name):
        return []

    monkeypatch.setattr(push, "favorite_artists", lambda db_, user_: ["Кино", "Сплин"])
    monkeypatch.setattr(push, "artist_releases", no_releases)
    monkeypatch.setattr(push, "send_to_user", lambda db_, uid, payload: sent.append(payload) or 1)

    assert asyncio.run(push.notify_user(db, user, now)) == "reengage"
    assert sent[0]["body"].startswith("Кино, Сплин")
    # Через день — рано, через три — снова.
    assert asyncio.run(push.notify_user(db, user, now + timedelta(days=1))) is None
    assert asyncio.run(push.notify_user(db, user, now + timedelta(days=3))) == "reengage"


def test_prefs_turn_off_each_kind(client, db, monkeypatch, _clean_push_keys):
    user = create_user(db)
    headers = auth_headers(client)
    assert client.get("/api/push/config", headers=headers).json()["releases"] is True
    assert client.put("/api/push/prefs", json={"releases": False, "reminders": True}, headers=headers).status_code == 204
    config = client.get("/api/push/config", headers=headers).json()
    assert (config["releases"], config["reminders"]) == (False, True)

    now = datetime(2026, 10, 21, 16, tzinfo=timezone.utc)
    db.refresh(user)
    user.last_seen = now - timedelta(days=3)
    sent = []

    async def releases(name):
        return [_release(42, "2026-10-20", artist=name)]

    monkeypatch.setattr(push, "favorite_artists", lambda db_, user_: ["Linkin Park"])
    monkeypatch.setattr(push, "artist_releases", releases)
    monkeypatch.setattr(push, "send_to_user", lambda db_, uid, payload: sent.append(payload) or 1)

    # Релизы выключены — вместо них напоминание.
    assert asyncio.run(push.notify_user(db, user, now)) == "reengage"
    # Выключены оба — молчим.
    user.push_reminders = False
    assert asyncio.run(push.notify_user(db, user, now + timedelta(days=3))) is None
    assert len(sent) == 1


def test_opened_records_known_kinds_only(client, db, _clean_push_keys):
    create_user(db)
    headers = auth_headers(client)
    client.post("/api/push/opened", json={"kind": "release"}, headers=headers)
    client.post("/api/push/opened", json={"kind": "whatever"}, headers=headers)
    stats = redis_client.hgetall(push._stats_key(datetime.now(timezone.utc).date()))
    assert {str(k): int(v) for k, v in stats.items()} == {"opened_release": 1}
