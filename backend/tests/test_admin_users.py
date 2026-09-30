"""Онлайн-статусы и ленивая загрузка профилей в админ-панели.

Маркер онлайна живёт в Redis (users:online:<id>, TTL 120 с), «последний
онлайн» — колонка users.last_seen, которую get_current_user обновляет не
чаще раза в минуту (см. dependencies.LAST_SEEN_WRITE_INTERVAL). Сортировка
профилей идёт по last_seen: у онлайн-юзеров он свежий, поэтому они
собираются наверху без отдельного прохода.
"""

from datetime import datetime, timedelta

from app.models import User

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
