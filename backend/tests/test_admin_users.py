"""Онлайн-статусы и ленивая загрузка профилей в админ-панели.

Маркер онлайна живёт в Redis (users:online:<id>, TTL 120 с), «последний
онлайн» — колонка users.last_seen, которую get_current_user обновляет не
чаще раза в минуту (см. dependencies.LAST_SEEN_WRITE_INTERVAL). Сортировка
профилей идёт по last_seen: у онлайн-юзеров он свежий, поэтому они
собираются наверху без отдельного прохода.
"""

from datetime import datetime, timedelta

from app.models import Track, User, user_track_plays

from tests.conftest import auth_headers, create_user


def _set_last_seen(db, user, when):
    # Наивный UTC: sqlite-диалект SQLAlchemy всё равно роняет tz при записи.
    user.last_seen = when
    db.commit()


def test_admin_users_sorted_by_last_seen(client, db):
    create_user(db, "admin", is_admin=True)
    never = create_user(db, "never")
    old = create_user(db, "old")
    recent = create_user(db, "recent")
    _set_last_seen(db, old, datetime.utcnow() - timedelta(hours=1))
    _set_last_seen(db, recent, datetime.utcnow() - timedelta(minutes=1))

    resp = client.get("/api/users/admin/dashboard", headers=auth_headers(client, "admin"))
    assert resp.status_code == 200, resp.text
    usernames = [u["username"] for u in resp.json()["users"]]

    # admin сам только что сходил в защищённый эндпоинт — его last_seen
    # свежее всех, поэтому он первый. Дальше — по убыванию last_seen,
    # никогда не заходившие (NULL) — в конце.
    assert usernames.index("recent") < usernames.index("old")
    assert usernames.index("old") < usernames.index("never")
    assert usernames[0] == "admin"


def test_online_flag_and_last_seen_are_reported(client, db):
    create_user(db, "admin", is_admin=True)
    visitor = create_user(db, "visitor")
    assert visitor.last_seen is None

    # Любой аутентифицированный запрос отмечает юзера онлайн и пишет
    # last_seen (первый заход после создания колонки — всегда запись).
    resp = client.get("/api/users/me", headers=auth_headers(client, "visitor"))
    assert resp.status_code == 200, resp.text

    resp = client.get("/api/users/admin/dashboard", headers=auth_headers(client, "admin"))
    assert resp.status_code == 200, resp.text
    profiles = {u["username"]: u for u in resp.json()["users"]}
    assert profiles["visitor"]["is_online"] is True
    assert profiles["visitor"]["last_seen"] is not None
    # Сам админ запросом дашборда тоже онлайн.
    assert profiles["admin"]["is_online"] is True
    assert resp.json()["online_users_count"] >= 2


def test_last_seen_write_is_throttled(client, db):
    create_user(db, "admin", is_admin=True)

    first = client.get("/api/users/me", headers=auth_headers(client, "admin"))
    assert first.status_code == 200, first.text
    db.expire_all()
    after_first = db.query(User).filter_by(username="admin").one().last_seen
    assert after_first is not None

    # Второй запрос в пределах интервала не должен двигать last_seen.
    second = client.get("/api/users/me", headers=auth_headers(client, "admin"))
    assert second.status_code == 200, second.text
    db.expire_all()
    after_second = db.query(User).filter_by(username="admin").one().last_seen
    assert after_second == after_first


def test_last_device_and_last_track_reported(client, db):
    create_user(db, "admin", is_admin=True)
    listener = create_user(db, "listener")
    create_user(db, "silent")
    older = Track(title="Old Song", artist="A", duration=100)
    newer = Track(title="New Song", artist="B", duration=100)
    db.add_all([older, newer])
    db.commit()
    db.execute(user_track_plays.insert(), [
        {"user_id": listener.id, "track_id": older.id, "last_played": datetime.utcnow() - timedelta(days=1)},
        {"user_id": listener.id, "track_id": newer.id, "last_played": datetime.utcnow()},
    ])
    db.commit()

    iphone_ua = (
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 "
        "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
    )
    headers = {**auth_headers(client, "listener"), "User-Agent": iphone_ua}
    resp = client.get("/api/users/me", headers=headers)
    assert resp.status_code == 200, resp.text

    resp = client.get("/api/users/admin/dashboard", headers=auth_headers(client, "admin"))
    assert resp.status_code == 200, resp.text
    profiles = {u["username"]: u for u in resp.json()["users"]}
    assert profiles["listener"]["last_device"] == "iPhone · Safari"
    assert profiles["listener"]["last_user_agent"] == iphone_ua
    assert profiles["listener"]["last_track"]["title"] == "New Song"
    assert profiles["silent"]["last_device"] is None
    assert profiles["silent"]["last_track"] is None


def test_admin_users_pagination(client, db):
    create_user(db, "admin", is_admin=True)
    create_user(db, "u1")
    create_user(db, "u2")

    resp = client.get(
        "/api/users/admin/users?limit=2&offset=0", headers=auth_headers(client, "admin")
    )
    assert resp.status_code == 200, resp.text
    page_one = resp.json()
    assert page_one["total"] == 3
    assert len(page_one["users"]) == 2

    resp = client.get(
        "/api/users/admin/users?limit=2&offset=2", headers=auth_headers(client, "admin")
    )
    assert resp.status_code == 200, resp.text
    page_two = resp.json()
    assert len(page_two["users"]) == 1

    ids_one = {u["id"] for u in page_one["users"]}
    ids_two = {u["id"] for u in page_two["users"]}
    assert not ids_one & ids_two
    assert len(ids_one | ids_two) == 3


def test_admin_users_requires_admin(client, db):
    create_user(db, "alice")

    resp = client.get("/api/users/admin/users", headers=auth_headers(client, "alice"))
    assert resp.status_code == 403


def test_dashboard_without_taste_skips_detected(client, db):
    create_user(db, "admin", is_admin=True)
    create_user(db, "u1")

    resp = client.get(
        "/api/users/admin/dashboard?taste=false", headers=auth_headers(client, "admin")
    )
    assert resp.status_code == 200, resp.text
    for profile in resp.json()["users"]:
        assert "detected_artists" not in profile


def test_admin_users_taste_batch(client, db):
    create_user(db, "admin", is_admin=True)
    u1 = create_user(db, "u1")
    u2 = create_user(db, "u2")

    resp = client.get(
        f"/api/users/admin/users/taste?ids={u1.id},{u2.id},{u1.id}",
        headers=auth_headers(client, "admin"),
    )
    assert resp.status_code == 200, resp.text
    profiles = resp.json()["profiles"]
    assert set(profiles) == {str(u1.id), str(u2.id)}
    for profile in profiles.values():
        assert profile["detected_artists"] == []
        assert profile["detected_genres"] == []

    bad = client.get(
        "/api/users/admin/users/taste?ids=abc", headers=auth_headers(client, "admin")
    )
    assert bad.status_code == 422


def test_admin_users_taste_requires_admin(client, db):
    alice = create_user(db, "alice")

    resp = client.get(
        f"/api/users/admin/users/taste?ids={alice.id}", headers=auth_headers(client, "alice")
    )
    assert resp.status_code == 403


def test_now_playing_visible_to_admin(client, db):
    create_user(db, "admin", is_admin=True)
    listener = create_user(db, "listener")

    payload = {
        "track_id": "ytmusic:abc",
        "title": "Song",
        "artist": "Band",
        "source": "ytmusic",
        "position": 12.5,
        "duration": 200,
        "is_playing": True,
    }
    resp = client.put(
        "/api/users/me/now-playing", json=payload, headers=auth_headers(client, "listener")
    )
    assert resp.status_code == 200, resp.text

    admin_headers = auth_headers(client, "admin")
    states = client.get("/api/users/admin/now-playing", headers=admin_headers).json()["now_playing"]
    state = states[str(listener.id)]
    assert state["title"] == "Song"
    assert state["is_playing"] is True
    assert state["updated_at"]

    client.delete("/api/users/me/now-playing", headers=auth_headers(client, "listener"))
    states = client.get("/api/users/admin/now-playing", headers=admin_headers).json()["now_playing"]
    assert str(listener.id) not in states


def test_now_playing_admin_only(client, db):
    create_user(db, "plain")
    resp = client.get("/api/users/admin/now-playing", headers=auth_headers(client, "plain"))
    assert resp.status_code == 403


def test_last_heard_shown_without_counted_play(client, db):
    """Новичок послушал полминуты и ушёл: засчитанного play нет, но админка
    видит, что он включал трек, а пауза последний трек не затирает."""
    from app.cache import redis_client

    create_user(db, "admin", is_admin=True)
    listener = create_user(db, "listener")
    paused = create_user(db, "paused")
    for user in (listener, paused):
        redis_client.delete(f"users:last_heard:{user.id}")

    base = {"track_id": "ytmusic:abc", "title": "Song", "artist": "Band", "position": 30, "duration": 166}
    client.put("/api/users/me/now-playing", json={**base, "is_playing": True},
               headers=auth_headers(client, "listener"))
    client.put("/api/users/me/now-playing", json={**base, "title": "Other", "is_playing": False},
               headers=auth_headers(client, "listener"))
    client.put("/api/users/me/now-playing", json={**base, "is_playing": False},
               headers=auth_headers(client, "paused"))

    resp = client.get("/api/users/admin/users?taste=false", headers=auth_headers(client, "admin"))
    profiles = {p["username"]: p for p in resp.json()["users"]}
    assert profiles["listener"]["last_track"] is None
    assert profiles["listener"]["last_heard"]["title"] == "Song"
    assert profiles["listener"]["last_heard"]["played_at"]
    assert profiles["paused"]["last_heard"] is None


def test_now_playing_lives_until_track_end(client, db):
    """Пульса нет — клиент шлёт состояние только на событиях, поэтому ключ
    играющего трека живёт до конца трека с запасом, а не 90 с."""
    from app.cache import redis_client
    from app.routers import users as users_router

    listener = create_user(db, "listener")
    headers = auth_headers(client, "listener")
    key = f"users:now_playing:{listener.id}"
    base = {"track_id": "ytmusic:abc", "title": "Song", "artist": "Band"}

    def ttl_after(**state):
        resp = client.put("/api/users/me/now-playing", json={**base, **state}, headers=headers)
        assert resp.status_code == 200, resp.text
        return redis_client.ttl(key)

    assert abs(ttl_after(position=20, duration=200, is_playing=True)
               - (180 + users_router.NOW_PLAYING_GRACE)) <= 2
    # У самого конца — не меньше минимума: событие следующего трека должно
    # успеть прийти, пока ключ жив.
    assert abs(ttl_after(position=199, duration=200, is_playing=True)
               - users_router.NOW_PLAYING_MIN_TTL) <= 2
    assert abs(ttl_after(position=0, duration=0, is_playing=True)
               - users_router.NOW_PLAYING_UNKNOWN_TTL) <= 2
    assert ttl_after(position=0, duration=6 * 3600, is_playing=True) <= users_router.NOW_PLAYING_MAX_TTL
    assert abs(ttl_after(position=20, duration=200, is_playing=False)
               - users_router.NOW_PLAYING_PAUSED_TTL) <= 2


def test_background_listener_stays_online(client, db):
    """С погашенным экраном клиент ходит на сервер только на смене трека:
    маркер онлайна (120 с) истекает посреди трека, last_seen отстаёт на трек.
    Онлайн держит играющий now-playing, пауза — нет, и онлайн идёт наверх
    списка раньше тех, кто заходил позже, но уже ушёл."""
    from app.cache import redis_client

    create_user(db, "admin", is_admin=True)
    listener = create_user(db, "listener")
    paused = create_user(db, "paused")
    recent = create_user(db, "recent")

    base = {"track_id": "ytmusic:abc", "title": "Song", "position": 10, "duration": 200}
    client.put("/api/users/me/now-playing", json={**base, "is_playing": True},
               headers=auth_headers(client, "listener"))
    client.put("/api/users/me/now-playing", json={**base, "is_playing": False},
               headers=auth_headers(client, "paused"))
    for user in (listener, paused):
        redis_client.delete(f"users:online:{user.id}")
        _set_last_seen(db, user, datetime.utcnow() - timedelta(minutes=4))
    _set_last_seen(db, recent, datetime.utcnow() - timedelta(minutes=1))

    resp = client.get("/api/users/admin/dashboard?taste=false", headers=auth_headers(client, "admin"))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    profiles = {p["username"]: p for p in body["users"]}
    usernames = [p["username"] for p in body["users"]]
    assert profiles["listener"]["is_online"] is True
    assert profiles["paused"]["is_online"] is False
    assert profiles["recent"]["is_online"] is False
    assert usernames.index("listener") < usernames.index("recent")
    assert usernames.index("recent") < usernames.index("paused")
    # admin (свой запрос) и слушатель.
    assert body["online_users_count"] == 2


def test_last_heard_sent_alongside_counted_play(client, db):
    """Вернувшийся юзер включил трек и ушёл до порога: засчитанный трек старый,
    но и последний включённый приходит в профиль — карточка выберет свежий."""
    from app.cache import redis_client

    create_user(db, "admin", is_admin=True)
    listener = create_user(db, "returner")
    redis_client.delete(f"users:last_heard:{listener.id}")
    track = Track(title="Morning Song", artist="A", duration=100)
    db.add(track)
    db.commit()
    db.execute(user_track_plays.insert(), [{
        "user_id": listener.id, "track_id": track.id, "play_count": 1,
        "last_played": datetime.utcnow() - timedelta(hours=8),
    }])
    db.commit()

    client.put("/api/users/me/now-playing",
               json={"track_id": "ytmusic:x", "title": "Evening Song", "artist": "B",
                     "position": 0, "duration": 318, "is_playing": True},
               headers=auth_headers(client, "returner"))

    resp = client.get("/api/users/admin/users?taste=false", headers=auth_headers(client, "admin"))
    profile = {p["username"]: p for p in resp.json()["users"]}["returner"]
    assert profile["last_track"]["title"] == "Morning Song"
    assert profile["last_heard"]["title"] == "Evening Song"
