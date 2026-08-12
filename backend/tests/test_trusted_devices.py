"""Доверенные устройства: вход с нового устройства требует второй фактор."""
import pytest
from sqlalchemy import select, update

from app import trusted_devices
from app.email_2fa import PURPOSE_LOGIN
from app.models import User, user_trusted_devices
from app.trusted_devices import DEVICE_TOKEN_HEADER, device_label_from_user_agent
from app.two_factor import generate_totp_secret, hash_recovery_codes
from tests.conftest import create_user


def _sent_codes(monkeypatch):
    """Перехват отправки: код в Redis лежит bcrypt-хэшем, обратно не достать."""
    box = []

    def fake_send(to_email, username, code, purpose=PURPOSE_LOGIN):
        box.append({"to": to_email, "code": code, "purpose": purpose})
        return True

    monkeypatch.setattr("app.routers.auth.send_email_code", fake_send)
    return box


def _login(client, username="bob", password="password123", device_token=None):
    headers = {DEVICE_TOKEN_HEADER: device_token} if device_token else {}
    resp = client.post(
        "/api/auth/login",
        data={"username": username, "password": password},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _pass_email_step(client, body, box):
    """Закрывает шаг подтверждения почтовым кодом и возвращает ответ."""
    return client.post(
        "/api/auth/mfa/verify",
        json={"mfa_token": body["mfa_token"], "code": box[-1]["code"]},
    )


def _login_new_device(client, db, user_id, box, username="bob"):
    """Логин с чистого устройства + закрытие шага кодом, возвращает Token-ответ.

    Между входами снимаем cooldown: реальный юзер ждёт минуту, а тест не может
    себе позволить sleep. Без этого второй логин не высылает новый код, и в
    box остаётся уже погашенный старый.
    """
    from app.email_2fa import clear_email_code

    clear_email_code(user_id, PURPOSE_LOGIN)
    resp = _pass_email_step(client, _login(client, username), box)
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_first_login_from_unknown_device_requires_code(client, db, monkeypatch):
    """Юзер БЕЗ своей 2FA всё равно подтверждает новое устройство: одного
    украденного пароля недостаточно для входа."""
    create_user(db, "bob")
    box = _sent_codes(monkeypatch)

    body = _login(client)
    assert body["mfa_required"] is True
    assert body["access_token"] is None
    assert body["new_device"] is True
    assert body["mfa_methods"] == ["email"]
    # Способ один, поэтому код уходит сразу, без лишнего клика.
    assert body["email_code_sent"] is True
    assert len(box) == 1
    assert body["email_masked"]


def test_verified_device_logs_in_without_code(client, db, monkeypatch):
    """Пройденный второй фактор выдаёт device_token; с ним вход в один шаг."""
    create_user(db, "bob")
    box = _sent_codes(monkeypatch)

    resp = _pass_email_step(client, _login(client), box)
    assert resp.status_code == 200, resp.text
    device_token = resp.json()["device_token"]
    assert device_token

    second = _login(client, device_token=device_token)
    assert second["mfa_required"] is False
    assert second["access_token"]
    # Повторный вход письмо не рассылает.
    assert len(box) == 1


def test_other_device_token_does_not_help(client, db, monkeypatch):
    """Токен, выданный другому аккаунту, не делает устройство знакомым:
    привязка проверяется и по user_id, а не только по хэшу токена."""
    create_user(db, "bob")
    create_user(db, "carol")
    box = _sent_codes(monkeypatch)

    carol_token = _pass_email_step(
        client, _login(client, "carol"), box
    ).json()["device_token"]

    body = _login(client, "bob", device_token=carol_token)
    assert body["mfa_required"] is True
    assert body["new_device"] is True


def test_garbage_device_token_requires_code(client, db, monkeypatch):
    create_user(db, "bob")
    _sent_codes(monkeypatch)

    body = _login(client, device_token="not-a-real-token")
    assert body["mfa_required"] is True
    assert body["new_device"] is True


def test_device_token_issued_only_after_second_factor(client, db, monkeypatch):
    """Провал кода не должен оставлять устройство доверенным."""
    create_user(db, "bob")
    _sent_codes(monkeypatch)

    body = _login(client)
    resp = client.post(
        "/api/auth/mfa/verify",
        json={"mfa_token": body["mfa_token"], "code": "000000"},
    )
    assert resp.status_code == 401

    rows = db.execute(select(user_trusted_devices.c.id)).all()
    assert rows == []


def test_totp_user_still_needs_code_on_known_device(client, db, monkeypatch):
    """Своя 2FA не слабеет от доверия устройству: она спрашивается всегда,
    доверие лишь снимает ДОПОЛНИТЕЛЬНУЮ проверку нового устройства."""
    import pyotp

    user = create_user(db, "bob")
    secret = generate_totp_secret()
    user.totp_secret = secret
    user.totp_enabled = True
    user.totp_recovery_codes = hash_recovery_codes(["RECOVERY01"])
    db.commit()
    _sent_codes(monkeypatch)

    body = _login(client)
    assert body["mfa_methods"] == ["totp"]
    resp = client.post(
        "/api/auth/mfa/verify",
        json={"mfa_token": body["mfa_token"], "code": pyotp.TOTP(secret).now()},
    )
    assert resp.status_code == 200, resp.text
    device_token = resp.json()["device_token"]

    # Устройство знакомое — код всё равно требуется.
    second = _login(client, device_token=device_token)
    assert second["mfa_required"] is True
    assert second["new_device"] is False
    assert second["mfa_methods"] == ["totp"]


def test_known_device_is_not_duplicated_on_every_login(client, db, monkeypatch):
    """Юзер с TOTP подтверждает код на каждом входе, но устройство одно и то
    же: каждый вход не должен добавлять строку в список и вытеснять из лимита
    настоящие другие устройства."""
    import pyotp

    user = create_user(db, "bob")
    secret = generate_totp_secret()
    user.totp_secret = secret
    user.totp_enabled = True
    db.commit()
    _sent_codes(monkeypatch)

    def _verify(device_token=None):
        # Один и тот же TOTP-код в пределах окна не проходит второй раз
        # (защита от реплея), а тест не может ждать следующего окна.
        from app.cache import clear_pattern

        clear_pattern("2fa:used:*")
        body = _login(client, device_token=device_token)
        headers = {DEVICE_TOKEN_HEADER: device_token} if device_token else {}
        resp = client.post(
            "/api/auth/mfa/verify",
            json={"mfa_token": body["mfa_token"], "code": pyotp.TOTP(secret).now()},
            headers=headers,
        )
        assert resp.status_code == 200, resp.text
        return resp.json()["device_token"]

    first = _verify()
    second = _verify(first)

    # Токен тот же, строка одна: знакомое устройство переиспользуется.
    assert second == first
    assert len(db.execute(select(user_trusted_devices.c.id)).all()) == 1


def test_email_send_works_for_new_device_without_own_2fa(client, db, monkeypatch):
    """Кнопка «прислать код» должна работать и у юзера, не включавшего 2FA:
    иначе шаг подтверждения нового устройства нечем закрыть после cooldown."""
    create_user(db, "bob")
    box = _sent_codes(monkeypatch)
    body = _login(client)

    # Первое письмо ушло на логине, второе упирается в cooldown — но эндпоинт
    # обязан отвечать 200, а не «2FA не включена».
    resp = client.post("/api/auth/mfa/email/send", json={"mfa_token": body["mfa_token"]})
    assert resp.status_code == 200, resp.text
    assert resp.json()["email_masked"]
    assert len(box) == 1


def test_expired_trust_requires_code_again(client, db, monkeypatch):
    """Доверие не вечное: просроченное устройство снова считается новым."""
    create_user(db, "bob")
    box = _sent_codes(monkeypatch)
    device_token = _pass_email_step(client, _login(client), box).json()["device_token"]

    from datetime import datetime, timedelta, timezone

    stale = datetime.now(timezone.utc) - timedelta(
        days=trusted_devices.DEVICE_TRUST_DAYS + 1
    )
    db.execute(update(user_trusted_devices).values(last_seen_at=stale))
    db.commit()

    body = _login(client, device_token=device_token)
    assert body["mfa_required"] is True
    assert body["new_device"] is True


def test_device_list_marks_current_and_revoke_works(client, db, monkeypatch):
    create_user(db, "bob")
    box = _sent_codes(monkeypatch)

    first = _pass_email_step(client, _login(client), box).json()
    headers = {
        "Authorization": f"Bearer {first['access_token']}",
        DEVICE_TOKEN_HEADER: first["device_token"],
    }

    resp = client.get("/api/auth/devices", headers=headers)
    assert resp.status_code == 200, resp.text
    devices = resp.json()
    assert len(devices) == 1
    assert devices[0]["current"] is True
    assert devices[0]["label"]

    # Отзыв возвращает устройство в статус нового.
    assert client.delete(
        f"/api/auth/devices/{devices[0]['id']}", headers=headers
    ).status_code == 204
    body = _login(client, device_token=first["device_token"])
    assert body["new_device"] is True


def test_revoke_rejects_other_users_device(client, db, monkeypatch):
    """id чужого устройства не должен отзываться — иначе любой юзер вышибал
    бы чужие сессии перебором id."""
    create_user(db, "bob")
    create_user(db, "carol")
    box = _sent_codes(monkeypatch)

    carol = _pass_email_step(client, _login(client, "carol"), box).json()
    carol_device_id = client.get(
        "/api/auth/devices",
        headers={
            "Authorization": f"Bearer {carol['access_token']}",
            DEVICE_TOKEN_HEADER: carol["device_token"],
        },
    ).json()[0]["id"]

    bob = _pass_email_step(client, _login(client, "bob"), box).json()
    resp = client.delete(
        f"/api/auth/devices/{carol_device_id}",
        headers={"Authorization": f"Bearer {bob['access_token']}"},
    )
    assert resp.status_code == 404

    # Устройство carol на месте.
    rows = db.execute(
        select(user_trusted_devices.c.id).where(
            user_trusted_devices.c.id == carol_device_id
        )
    ).all()
    assert len(rows) == 1


def test_revoke_all_keeps_current_device(client, db, monkeypatch):
    user = create_user(db, "bob")
    box = _sent_codes(monkeypatch)

    old = _login_new_device(client, db, user.id, box)["device_token"]
    current = _login_new_device(client, db, user.id, box)

    headers = {
        "Authorization": f"Bearer {current['access_token']}",
        DEVICE_TOKEN_HEADER: current["device_token"],
    }
    resp = client.post("/api/auth/devices/revoke-all", headers=headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["revoked"] == 1

    # Текущее устройство осталось доверенным, старое — нет.
    assert _login(client, device_token=current["device_token"])["mfa_required"] is False
    assert _login(client, device_token=old)["new_device"] is True


def test_device_limit_evicts_least_recently_used(client, db, monkeypatch):
    """Без лимита каждый браузер копил бы строки без конца."""
    user = create_user(db, "bob")
    box = _sent_codes(monkeypatch)
    monkeypatch.setattr(trusted_devices, "MAX_DEVICES_PER_USER", 2)

    tokens = [_login_new_device(client, db, user.id, box)["device_token"] for _ in range(3)]

    rows = db.execute(select(user_trusted_devices.c.id)).all()
    assert len(rows) == 2
    # Вытесняется самое давнее — первый токен больше не знакомый.
    assert _login(client, device_token=tokens[0])["new_device"] is True
    assert _login(client, device_token=tokens[-1])["mfa_required"] is False


@pytest.mark.parametrize(
    "user_agent,expected",
    [
        (
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"
            " (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
            "iPhone · Safari",
        ),
        (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like"
            " Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Windows · Chrome",
        ),
        (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML,"
            " like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
            "Mac · Edge",
        ),
        ("", "Неизвестное устройство"),
    ],
)
def test_device_label_from_user_agent(user_agent, expected):
    assert device_label_from_user_agent(user_agent) == expected
