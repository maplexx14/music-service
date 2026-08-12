import pyotp

from app.models import User
from app.trusted_devices import DEVICE_TOKEN_HEADER
from app.two_factor import generate_totp_secret, hash_recovery_codes
from tests.conftest import auth_headers, create_user, trust_device


def _enable_2fa(db, user: User, codes=None):
    """Включает 2FA напрямую в БД — короче, чем гонять setup/enable там,
    где проверяется не включение, а вход."""
    secret = generate_totp_secret()
    user.totp_secret = secret
    user.totp_enabled = True
    user.totp_recovery_codes = hash_recovery_codes(codes or ["RECOVERY01"])
    db.commit()
    return secret


def test_login_without_2fa_returns_access_token(client, db):
    user = create_user(db, "bob")
    # Устройство доверенное: без своей 2FA вход в один шаг возможен только с
    # знакомого устройства, незнакомое всегда просит код (test_trusted_devices).
    resp = client.post(
        "/api/auth/login",
        data={"username": "bob", "password": "password123"},
        headers={DEVICE_TOKEN_HEADER: trust_device(db, user.id)},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["access_token"]
    assert body["mfa_required"] is False
    assert body["mfa_token"] is None


def test_login_with_2fa_returns_mfa_token_not_access(client, db):
    user = create_user(db, "bob")
    _enable_2fa(db, user)
    resp = client.post("/api/auth/login", data={"username": "bob", "password": "password123"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["mfa_required"] is True
    assert body["mfa_token"]
    assert body["access_token"] is None


def test_mfa_token_is_not_accepted_as_access_token(client, db):
    """Ключевое свойство: промежуточный токен не должен открывать API —
    иначе второй фактор обходится подстановкой mfa_token в Authorization."""
    user = create_user(db, "bob")
    _enable_2fa(db, user)
    resp = client.post("/api/auth/login", data={"username": "bob", "password": "password123"})
    mfa_token = resp.json()["mfa_token"]

    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {mfa_token}"}).status_code == 401


def test_mfa_verify_with_totp_code(client, db):
    user = create_user(db, "bob")
    secret = _enable_2fa(db, user)
    mfa_token = client.post(
        "/api/auth/login", data={"username": "bob", "password": "password123"}
    ).json()["mfa_token"]

    resp = client.post(
        "/api/auth/mfa/verify",
        json={"mfa_token": mfa_token, "code": pyotp.TOTP(secret).now()},
    )
    assert resp.status_code == 200
    token = resp.json()["access_token"]
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"}).status_code == 200


def test_mfa_verify_wrong_code(client, db):
    user = create_user(db, "bob")
    _enable_2fa(db, user)
    mfa_token = client.post(
        "/api/auth/login", data={"username": "bob", "password": "password123"}
    ).json()["mfa_token"]

    resp = client.post("/api/auth/mfa/verify", json={"mfa_token": mfa_token, "code": "000000"})
    assert resp.status_code == 401


def _totp_code_for(secret):
    return pyotp.TOTP(secret).now()


def _login_mfa_token(client, username="bob", password="password123"):
    resp = client.post(
        "/api/auth/login", data={"username": username, "password": password}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["mfa_token"]


def test_totp_code_replay_blocked_within_window(client, db):
    """Один и тот же TOTP-код нельзя предъявить дважды в пределах его окна."""
    user = create_user(db, "bob")
    secret = _enable_2fa(db, user)
    code = _totp_code_for(secret)

    # Первый вход кодом — успех.
    resp = client.post(
        "/api/auth/mfa/verify",
        json={"mfa_token": _login_mfa_token(client), "code": code},
    )
    assert resp.status_code == 200, resp.text

    # Второй вход ТЕМ ЖЕ кодом (новый mfa_token, но код ещё в окне) — отказ.
    resp = client.post(
        "/api/auth/mfa/verify",
        json={"mfa_token": _login_mfa_token(client), "code": code},
    )
    assert resp.status_code == 401
    assert resp.json()["detail"] == "This code was already used, wait for a new one"


def test_totp_second_code_still_works_after_replay_block(client, db):
    """Блок реплея касается только предъявленного кода, а не юзера в целом."""
    user = create_user(db, "bob")
    secret = _enable_2fa(db, user)
    first = _totp_code_for(secret)

    resp = client.post(
        "/api/auth/mfa/verify",
        json={"mfa_token": _login_mfa_token(client), "code": first},
    )
    assert resp.status_code == 200

    # Следующий код (другой временной слот) должен пройти нормально.
    second = _totp_code_for(secret)
    while second == first:
        second = _totp_code_for(secret)
    resp = client.post(
        "/api/auth/mfa/verify",
        json={"mfa_token": _login_mfa_token(client), "code": second},
    )
    assert resp.status_code == 200


def test_enable_consumes_code(client, db):
    """Код, использованный при включении 2FA, не должен сработать при входе."""
    create_user(db, "bob")
    headers = auth_headers(client, "bob")
    secret = client.post("/api/auth/2fa/setup", headers=headers).json()["totp_secret"]
    code = _totp_code_for(secret)

    resp = client.post(
        "/api/auth/2fa/enable",
        headers=headers,
        json={"code": code, "password": "password123"},
    )
    assert resp.status_code == 200, resp.text

    # Тот же код на входе — уже использован.
    resp = client.post(
        "/api/auth/mfa/verify",
        json={"mfa_token": _login_mfa_token(client), "code": code},
    )
    assert resp.status_code == 401


def test_mfa_verify_rejects_access_token_as_mfa_token(client, db):
    """Обратная сторона разделения токенов: настоящий access_token чужого
    (или своего) входа не должен работать как mfa_token."""
    alice = create_user(db, "alice")
    access = client.post(
        "/api/auth/login",
        data={"username": "alice", "password": "password123"},
        headers={DEVICE_TOKEN_HEADER: trust_device(db, alice.id)},
    ).json()["access_token"]

    user = create_user(db, "bob")
    _enable_2fa(db, user)
    resp = client.post("/api/auth/mfa/verify", json={"mfa_token": access, "code": "000000"})
    assert resp.status_code == 401


def test_recovery_code_works_once(client, db):
    user = create_user(db, "bob")
    _enable_2fa(db, user, codes=["RECOVERY01", "RECOVERY02"])

    def login_mfa_token():
        return client.post(
            "/api/auth/login", data={"username": "bob", "password": "password123"}
        ).json()["mfa_token"]

    resp = client.post(
        "/api/auth/mfa/verify", json={"mfa_token": login_mfa_token(), "code": "recovery01"}
    )
    assert resp.status_code == 200, resp.text

    # Повторное использование того же кода — уже нет.
    resp = client.post(
        "/api/auth/mfa/verify", json={"mfa_token": login_mfa_token(), "code": "RECOVERY01"}
    )
    assert resp.status_code == 401

    # Второй код всё ещё валиден.
    resp = client.post(
        "/api/auth/mfa/verify", json={"mfa_token": login_mfa_token(), "code": "RECOVERY02"}
    )
    assert resp.status_code == 200


def test_setup_and_enable_flow(client, db):
    create_user(db, "bob")
    headers = auth_headers(client, "bob")

    resp = client.post("/api/auth/2fa/setup", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    secret = body["totp_secret"]
    assert body["otpauth_url"].startswith("otpauth://totp/")
    assert body["qr_png"].startswith("data:image/png;base64,")

    # Статус до подтверждения: не включена, но секрет доступен для повторного QR.
    status_body = client.get("/api/auth/2fa/status", headers=headers).json()
    assert status_body["totp_enabled"] is False
    assert status_body["totp_secret"] == secret

    resp = client.post(
        "/api/auth/2fa/enable",
        headers=headers,
        json={"code": pyotp.TOTP(secret).now(), "password": "password123"},
    )
    assert resp.status_code == 200, resp.text
    codes = resp.json()["recovery_codes"]
    assert len(codes) == 10

    status_body = client.get("/api/auth/2fa/status", headers=headers).json()
    assert status_body["totp_enabled"] is True
    # Секрет после включения наружу не отдаём.
    assert status_body["totp_secret"] is None
    assert client.get("/api/auth/me", headers=headers).json()["totp_enabled"] is True


def test_enable_requires_correct_password_and_code(client, db):
    create_user(db, "bob")
    headers = auth_headers(client, "bob")
    secret = client.post("/api/auth/2fa/setup", headers=headers).json()["totp_secret"]

    resp = client.post(
        "/api/auth/2fa/enable",
        headers=headers,
        json={"code": pyotp.TOTP(secret).now(), "password": "wrong-password"},
    )
    assert resp.status_code == 400

    resp = client.post(
        "/api/auth/2fa/enable",
        headers=headers,
        json={"code": "000000", "password": "password123"},
    )
    assert resp.status_code == 400

    assert client.get("/api/auth/2fa/status", headers=headers).json()["totp_enabled"] is False


def test_enable_without_setup(client, db):
    create_user(db, "bob")
    headers = auth_headers(client, "bob")
    resp = client.post(
        "/api/auth/2fa/enable", headers=headers, json={"code": "000000", "password": "password123"}
    )
    assert resp.status_code == 400


def test_setup_conflicts_when_already_enabled(client, db):
    user = create_user(db, "bob")
    secret = _enable_2fa(db, user)
    mfa_token = client.post(
        "/api/auth/login", data={"username": "bob", "password": "password123"}
    ).json()["mfa_token"]
    access = client.post(
        "/api/auth/mfa/verify", json={"mfa_token": mfa_token, "code": pyotp.TOTP(secret).now()}
    ).json()["access_token"]
    headers = {"Authorization": f"Bearer {access}"}

    assert client.post("/api/auth/2fa/setup", headers=headers).status_code == 409


def test_disable_requires_password_and_clears_state(client, db):
    user = create_user(db, "bob")
    headers = auth_headers(client, "bob")
    secret = client.post("/api/auth/2fa/setup", headers=headers).json()["totp_secret"]
    client.post(
        "/api/auth/2fa/enable",
        headers=headers,
        json={"code": pyotp.TOTP(secret).now(), "password": "password123"},
    )

    assert client.post(
        "/api/auth/2fa/disable", headers=headers, json={"password": "wrong"}
    ).status_code == 400

    resp = client.post("/api/auth/2fa/disable", headers=headers, json={"password": "password123"})
    assert resp.status_code == 200
    assert resp.json()["totp_enabled"] is False

    # Вход снова одношаговый (на знакомом устройстве: новое просит код и без
    # 2FA), а старые резервные коды больше ни к чему не ведут.
    body = client.post(
        "/api/auth/login",
        data={"username": "bob", "password": "password123"},
        headers={DEVICE_TOKEN_HEADER: trust_device(db, user.id)},
    ).json()
    assert body["access_token"]
    assert body["mfa_required"] is False

    user = db.query(User).filter(User.username == "bob").first()
    assert user.totp_secret is None
    assert user.totp_recovery_codes == []


def test_login_refused_when_replay_cache_is_down(client, db, monkeypatch):
    """Redis лежит — вход с TOTP отклоняется, а не пропускается.

    Без кеша гарантию одноразовости кода дать нельзя, поэтому путь
    fail-closed: 503 вместо тихого входа по потенциально повторному коду.
    """
    from app import two_factor

    user = create_user(db, "bob")
    secret = _enable_2fa(db, user)

    def boom(*args, **kwargs):
        raise two_factor.ReplayCacheUnavailable("redis is down")

    monkeypatch.setattr(two_factor, "consume_totp_code", boom)
    # Роутер импортировал функцию по имени, поэтому подменяем и там.
    monkeypatch.setattr("app.routers.auth.consume_totp_code", boom)

    resp = client.post(
        "/api/auth/mfa/verify",
        json={"mfa_token": _login_mfa_token(client), "code": _totp_code_for(secret)},
    )
    assert resp.status_code == 503


def test_recovery_code_still_works_when_replay_cache_is_down(client, db, monkeypatch):
    """Резервные коды гасятся в БД, а не в Redis, — они остаются рабочим
    путём входа, пока кеш недоступен."""
    user = create_user(db, "bob")
    _enable_2fa(db, user, codes=["RECOVERY01"])

    def boom(*args, **kwargs):
        from app import two_factor

        raise two_factor.ReplayCacheUnavailable("redis is down")

    monkeypatch.setattr("app.routers.auth.consume_totp_code", boom)

    resp = client.post(
        "/api/auth/mfa/verify",
        json={"mfa_token": _login_mfa_token(client), "code": "RECOVERY01"},
    )
    assert resp.status_code == 200
