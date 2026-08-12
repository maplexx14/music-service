"""Двухфакторка по почте: включение, вход кодом, лимиты и одноразовость."""
import pyotp

from app import email_2fa
from app.email_2fa import (
    PURPOSE_ENABLE,
    PURPOSE_LOGIN,
    clear_email_code,
    issue_email_code,
    mask_email,
    verify_email_code,
)
from app.models import User
from app.trusted_devices import DEVICE_TOKEN_HEADER
from app.two_factor import generate_totp_secret, hash_recovery_codes
from tests.conftest import auth_headers, create_user, trust_device


def _enable_email_2fa(db, user: User):
    """Включает почтовую 2FA прямо в БД — короче, чем гонять setup/enable
    там, где проверяется вход, а не включение."""
    user.email_2fa_enabled = True
    db.commit()


def _login(client, username="bob", password="password123", device_token=None):
    resp = client.post(
        "/api/auth/login",
        data={"username": username, "password": password},
        # Без токена устройство считается новым и второй фактор спрашивается
        # даже без включённой 2FA — тестам про саму почтовую 2FA это мешает.
        headers={DEVICE_TOKEN_HEADER: device_token} if device_token else {},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _sent_codes(monkeypatch):
    """Перехват отправки: тест должен видеть код, не читая Redis (там лежит
    bcrypt-хэш, обратно код из него не достать)."""
    box = []

    def fake_send(to_email, username, code, purpose=PURPOSE_LOGIN):
        box.append({"to": to_email, "code": code, "purpose": purpose})
        return True

    monkeypatch.setattr("app.routers.auth.send_email_code", fake_send)
    return box


def test_mask_email_hides_local_part():
    assert mask_email("johnny@example.com") == "j••••y@example.com"
    # Короткий local-part нечем маскировать частично — скрываем целиком.
    assert mask_email("jo@example.com") == "••@example.com"
    assert mask_email("broken") == "•••"


def test_login_with_email_2fa_returns_challenge_and_sends_code(client, db, monkeypatch):
    user = create_user(db, "bob")
    _enable_email_2fa(db, user)
    box = _sent_codes(monkeypatch)

    body = _login(client)
    assert body["mfa_required"] is True
    assert body["access_token"] is None
    assert body["mfa_methods"] == ["email"]
    # Почта — единственный фактор, поэтому код уходит сразу, без лишнего клика.
    assert body["email_code_sent"] is True
    assert len(box) == 1
    assert box[0]["purpose"] == PURPOSE_LOGIN


def test_login_with_email_code_issues_token(client, db, monkeypatch):
    user = create_user(db, "bob")
    _enable_email_2fa(db, user)
    box = _sent_codes(monkeypatch)

    body = _login(client)
    resp = client.post(
        "/api/auth/mfa/verify",
        json={"mfa_token": body["mfa_token"], "code": box[0]["code"]},
    )
    assert resp.status_code == 200, resp.text
    token = resp.json()["access_token"]
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200


def test_email_code_works_once(client, db, monkeypatch):
    """Код гасится при использовании: перехваченный код не даёт второй вход."""
    user = create_user(db, "bob")
    _enable_email_2fa(db, user)
    box = _sent_codes(monkeypatch)

    body = _login(client)
    code = box[0]["code"]
    first = client.post(
        "/api/auth/mfa/verify", json={"mfa_token": body["mfa_token"], "code": code}
    )
    assert first.status_code == 200

    second = _login(client)
    resp = client.post(
        "/api/auth/mfa/verify", json={"mfa_token": second["mfa_token"], "code": code}
    )
    assert resp.status_code == 401


def test_email_code_accepts_spaces_from_clipboard(client, db, monkeypatch):
    user = create_user(db, "bob")
    _enable_email_2fa(db, user)
    box = _sent_codes(monkeypatch)

    body = _login(client)
    code = box[0]["code"]
    spaced = f"{code[:3]} {code[3:]}"
    resp = client.post(
        "/api/auth/mfa/verify", json={"mfa_token": body["mfa_token"], "code": spaced}
    )
    assert resp.status_code == 200, resp.text


def test_wrong_email_code_rejected(client, db, monkeypatch):
    user = create_user(db, "bob")
    _enable_email_2fa(db, user)
    _sent_codes(monkeypatch)

    body = _login(client)
    resp = client.post(
        "/api/auth/mfa/verify",
        json={"mfa_token": body["mfa_token"], "code": "000000", "method": "email"},
    )
    assert resp.status_code == 401


def test_email_code_burns_after_max_attempts(client, db, monkeypatch):
    """6 цифр перебираются, если попытки не ограничены: после лимита код
    гасится, и даже верный код больше не подходит."""
    user = create_user(db, "bob")
    _enable_email_2fa(db, user)
    box = _sent_codes(monkeypatch)

    body = _login(client)
    code = box[0]["code"]
    wrong = "000000" if code != "000000" else "111111"

    for _ in range(email_2fa.EMAIL_CODE_MAX_ATTEMPTS):
        resp = client.post(
            "/api/auth/mfa/verify",
            json={"mfa_token": body["mfa_token"], "code": wrong, "method": "email"},
        )
        assert resp.status_code == 401

    resp = client.post(
        "/api/auth/mfa/verify",
        json={"mfa_token": body["mfa_token"], "code": code, "method": "email"},
    )
    assert resp.status_code == 401


def test_resend_respects_cooldown(client, db, monkeypatch):
    user = create_user(db, "bob")
    _enable_email_2fa(db, user)
    box = _sent_codes(monkeypatch)

    body = _login(client)
    assert len(box) == 1  # код ушёл на самом логине

    resp = client.post("/api/auth/mfa/email/send", json={"mfa_token": body["mfa_token"]})
    assert resp.status_code == 200
    payload = resp.json()
    # Cooldown — не ошибка: предыдущий код ещё жив, письмо просто не дублируем.
    assert payload["sent"] is False
    assert payload["cooldown_seconds"] > 0
    assert payload["email_masked"] == mask_email(user.email)
    assert len(box) == 1


def test_resend_sends_after_cooldown_cleared(client, db, monkeypatch):
    user = create_user(db, "bob")
    _enable_email_2fa(db, user)
    box = _sent_codes(monkeypatch)

    body = _login(client)
    # Эмулируем истёкший cooldown, не ожидая минуту реального времени.
    clear_email_code(user.id, PURPOSE_LOGIN)

    resp = client.post("/api/auth/mfa/email/send", json={"mfa_token": body["mfa_token"]})
    assert resp.status_code == 200, resp.text
    assert resp.json()["sent"] is True
    assert len(box) == 2

    # Новый код вытеснил старый: войти можно только последним.
    old, new = box[0]["code"], box[1]["code"]
    if old != new:
        stale = client.post(
            "/api/auth/mfa/verify", json={"mfa_token": body["mfa_token"], "code": old}
        )
        assert stale.status_code == 401
    fresh = client.post(
        "/api/auth/mfa/verify", json={"mfa_token": body["mfa_token"], "code": new}
    )
    assert fresh.status_code == 200


def test_email_send_requires_valid_mfa_token(client, db):
    create_user(db, "bob")
    resp = client.post("/api/auth/mfa/email/send", json={"mfa_token": "garbage"})
    assert resp.status_code == 401


def test_email_send_rejects_access_token(client, db, monkeypatch):
    """Полноценный access_token не должен работать как mfa_token."""
    user = create_user(db, "bob")
    _enable_email_2fa(db, user)
    box = _sent_codes(monkeypatch)
    body = _login(client)
    access = client.post(
        "/api/auth/mfa/verify",
        json={"mfa_token": body["mfa_token"], "code": box[0]["code"]},
    ).json()["access_token"]

    resp = client.post("/api/auth/mfa/email/send", json={"mfa_token": access})
    assert resp.status_code == 401


def test_both_factors_offer_choice_and_no_auto_email(client, db, monkeypatch):
    """Когда включены оба фактора, письмо на логине не шлём: TOTP под рукой,
    а лишнее письмо — и спам, и потраченный cooldown."""
    user = create_user(db, "bob")
    secret = generate_totp_secret()
    user.totp_secret = secret
    user.totp_enabled = True
    user.totp_recovery_codes = hash_recovery_codes(["RECOVERY01"])
    user.email_2fa_enabled = True
    db.commit()
    box = _sent_codes(monkeypatch)

    body = _login(client)
    assert body["mfa_methods"] == ["totp", "email"]
    assert body["email_code_sent"] is False
    assert box == []

    # TOTP работает как раньше.
    resp = client.post(
        "/api/auth/mfa/verify",
        json={"mfa_token": body["mfa_token"], "code": pyotp.TOTP(secret).now()},
    )
    assert resp.status_code == 200, resp.text

    # Письмо приходит по кнопке, и его код тоже пускает внутрь.
    second = _login(client)
    sent = client.post(
        "/api/auth/mfa/email/send", json={"mfa_token": second["mfa_token"]}
    )
    assert sent.json()["sent"] is True
    resp = client.post(
        "/api/auth/mfa/verify",
        json={"mfa_token": second["mfa_token"], "code": box[-1]["code"]},
    )
    assert resp.status_code == 200


def test_recovery_code_works_with_email_only_2fa(client, db, monkeypatch):
    """Резервные коды — запасной вход, когда недоступна и почта."""
    user = create_user(db, "bob")
    user.email_2fa_enabled = True
    user.totp_recovery_codes = hash_recovery_codes(["RECOVERY01"])
    db.commit()
    _sent_codes(monkeypatch)

    body = _login(client)
    resp = client.post(
        "/api/auth/mfa/verify",
        json={"mfa_token": body["mfa_token"], "code": "RECOVERY01"},
    )
    assert resp.status_code == 200, resp.text


def test_setup_and_enable_email_2fa(client, db, monkeypatch):
    user = create_user(db, "bob")
    headers = auth_headers(client, "bob")
    box = _sent_codes(monkeypatch)

    resp = client.post("/api/auth/2fa/email/setup", headers=headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["sent"] is True
    assert box[0]["purpose"] == PURPOSE_ENABLE

    resp = client.post(
        "/api/auth/2fa/email/enable",
        headers=headers,
        json={"code": box[0]["code"], "password": "password123"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["email_2fa_enabled"] is True

    status = client.get("/api/auth/2fa/status", headers=headers).json()
    assert status["email_2fa_enabled"] is True
    assert status["email_masked"]

    # Вход стал двухшаговым — и на знакомом устройстве тоже, иначе проверка
    # ничего не доказывала бы: новое устройство просит код и без 2FA.
    assert _login(client, device_token=trust_device(db, user.id))["mfa_required"] is True


def test_enable_email_2fa_requires_password_and_code(client, db, monkeypatch):
    create_user(db, "bob")
    headers = auth_headers(client, "bob")
    box = _sent_codes(monkeypatch)
    client.post("/api/auth/2fa/email/setup", headers=headers)

    resp = client.post(
        "/api/auth/2fa/email/enable",
        headers=headers,
        json={"code": box[0]["code"], "password": "wrong-password"},
    )
    assert resp.status_code == 400

    resp = client.post(
        "/api/auth/2fa/email/enable",
        headers=headers,
        json={"code": "000000", "password": "password123"},
    )
    assert resp.status_code == 400

    status = client.get("/api/auth/2fa/status", headers=headers).json()
    assert status["email_2fa_enabled"] is False


def test_setup_email_2fa_requires_verified_email(client, db, monkeypatch):
    """Включать фактор на неподтверждённый адрес — способ запереть себя
    снаружи, поэтому setup требует подтверждённой почты."""
    user = create_user(db, "bob", email_verified=False)
    _sent_codes(monkeypatch)
    # Токен получаем в обход /login: он для неподтверждённых отдаёт 403.
    from app.auth import create_access_token

    headers = {"Authorization": f"Bearer {create_access_token({'sub': user.username})}"}

    resp = client.post("/api/auth/2fa/email/setup", headers=headers)
    assert resp.status_code == 400
    assert resp.json()["detail"] == "Email not verified"


def test_disable_email_2fa_requires_password(client, db, monkeypatch):
    user = create_user(db, "bob")
    _enable_email_2fa(db, user)
    user.totp_recovery_codes = hash_recovery_codes(["RECOVERY01"])
    db.commit()
    _sent_codes(monkeypatch)

    # Для настроек нужен полноценный токен — проходим второй шаг резервным кодом.
    body = _login(client)
    verified = client.post(
        "/api/auth/mfa/verify",
        json={"mfa_token": body["mfa_token"], "code": "RECOVERY01"},
    ).json()
    access = verified["access_token"]
    headers = {"Authorization": f"Bearer {access}"}

    bad = client.post(
        "/api/auth/2fa/email/disable", headers=headers, json={"password": "wrong"}
    )
    assert bad.status_code == 400

    resp = client.post(
        "/api/auth/2fa/email/disable", headers=headers, json={"password": "password123"}
    )
    assert resp.status_code == 200
    assert resp.json()["email_2fa_enabled"] is False

    # Вход снова одношаговый — устройство при прохождении второго фактора
    # стало доверенным, поэтому код больше не нужен.
    assert _login(client, device_token=verified["device_token"])["access_token"]


def test_login_refused_when_code_storage_is_down(client, db, monkeypatch):
    """Redis лёг — вход по почтовому коду отклоняется, а не пропускается."""
    user = create_user(db, "bob")
    _enable_email_2fa(db, user)
    _sent_codes(monkeypatch)
    body = _login(client)

    def boom(*args, **kwargs):
        raise email_2fa.EmailCodeUnavailable("redis is down")

    monkeypatch.setattr("app.routers.auth.verify_email_code", boom)
    resp = client.post(
        "/api/auth/mfa/verify",
        json={"mfa_token": body["mfa_token"], "code": "123456"},
    )
    assert resp.status_code == 503


def test_enable_purpose_code_does_not_work_for_login(client, db, monkeypatch):
    """Код, высланный для включения 2FA, не должен проходить как второй
    фактор входа: разные назначения — разные ключи."""
    user = create_user(db, "bob")
    code = issue_email_code(user.id, PURPOSE_ENABLE)
    _enable_email_2fa(db, user)
    _sent_codes(monkeypatch)

    body = _login(client)
    resp = client.post(
        "/api/auth/mfa/verify",
        json={"mfa_token": body["mfa_token"], "code": code, "method": "email"},
    )
    assert resp.status_code == 401


def test_verify_email_code_module_level_single_use(db):
    user = create_user(db, "bob")
    code = issue_email_code(user.id, PURPOSE_LOGIN)
    assert verify_email_code(user.id, code, PURPOSE_LOGIN) is True
    assert verify_email_code(user.id, code, PURPOSE_LOGIN) is False


def test_email_send_reports_undeliverable_code(client, db, monkeypatch):
    """Код, который некуда доставить, — тупик: вход с нового устройства без
    него не пройти. Отвечаем 503, а не «отправлено»: иначе юзер ждёт письма,
    которого не будет, и не понимает, что почта на сервере не настроена."""
    user = create_user(db, "bob")
    _enable_email_2fa(db, user)
    monkeypatch.setattr("app.routers.auth.send_email_code", lambda *a, **kw: False)

    body = _login(client)
    assert body["email_code_sent"] is False
    # Логин уже потратил попытку и поставил cooldown — снимаем, иначе эндпоинт
    # ответит «код уже отправлен» вместо проверки доставки.
    clear_email_code(user.id, PURPOSE_LOGIN)

    resp = client.post("/api/auth/mfa/email/send", json={"mfa_token": body["mfa_token"]})
    assert resp.status_code == 503, resp.text


def test_setup_email_2fa_reports_undeliverable_code(client, db, monkeypatch):
    """Включать фактор, код к которому не доставляется, нельзя — это запирает
    юзера снаружи на следующем входе."""
    create_user(db, "bob")
    headers = auth_headers(client, "bob")
    monkeypatch.setattr("app.routers.auth.send_email_code", lambda *a, **kw: False)

    resp = client.post("/api/auth/2fa/email/setup", headers=headers)
    assert resp.status_code == 503, resp.text
    status = client.get("/api/auth/2fa/status", headers=headers).json()
    assert status["email_2fa_enabled"] is False


def test_code_goes_to_log_only_in_debug(monkeypatch):
    """Без SMTP код доставим только в лог, и только в разработке: в проде это
    второй фактор, лежащий в одном файле рядом с логами входа."""
    seen = {}

    def fake_send_mail(to_email, subject, body, *, log_fallback=""):
        seen["log_fallback"] = log_fallback
        return False

    monkeypatch.setattr(email_2fa, "send_mail", fake_send_mail)

    monkeypatch.setattr(email_2fa, "LOG_CODE_WITHOUT_SMTP", True)
    # True: код доступен разработчику в логе, значит шаг проходим.
    assert email_2fa.send_email_code("bob@example.com", "bob", "123456") is True
    assert "123456" in seen["log_fallback"]

    monkeypatch.setattr(email_2fa, "LOG_CODE_WITHOUT_SMTP", False)
    assert email_2fa.send_email_code("bob@example.com", "bob", "123456") is False
    assert seen["log_fallback"] == ""


