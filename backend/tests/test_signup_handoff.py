"""Первые минуты новичка: вход без повторных кодов и готовая первая волна.

Прод 2026-10-19: на iPhone ссылка из письма открывалась в браузере почтового
приложения, а PWA после «На экран Домой» жила со своим localStorage — новичок
вводил пароль и код 2–4 раза. Первая волна после онбординга считалась вживую
4.5–5.6 с: flow-warmer будился только первой выдачей.
"""
from app import trusted_devices
from app.cache import get_cache, redis_client
from app.email_2fa import PURPOSE_LOGIN
from app.email_verification import get_pending_registration, reissue_pending_token
from app.models import User
from app.routers import flow as flow_router
from app.trusted_devices import DEVICE_TOKEN_HEADER
from tests.conftest import auth_headers, create_user


def _register(client, username="bob"):
    resp = client.post(
        "/api/auth/register",
        json={"username": username, "email": f"{username}@example.com", "password": "password123"},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _verify(client, username="bob"):
    token = reissue_pending_token(get_pending_registration(username))
    resp = client.post("/api/auth/verify-email", json={"token": token})
    assert resp.status_code == 200, resp.text
    return resp.json()


def _claim(client, claim_token):
    resp = client.post("/api/auth/register/claim", json={"claim_token": claim_token})
    assert resp.status_code == 200, resp.text
    return resp.json()


def _same_ip_window(monkeypatch):
    monkeypatch.setattr(trusted_devices, "RECENT_VERIFY_WINDOW_SEC", 1800)
    # TestClient старой Starlette (0.35, в requirements) не задаёт адрес
    # клиента: request.client = None, и окно по IP молча выключалось бы.
    monkeypatch.setattr("app.routers.auth._client_ip", lambda request: "203.0.113.7")


def _login(client, device_token=None):
    headers = {DEVICE_TOKEN_HEADER: device_token} if device_token else {}
    resp = client.post(
        "/api/auth/login", data={"username": "bob", "password": "password123"}, headers=headers
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_registering_tab_logs_in_after_link_opened_elsewhere(client, db):
    claim = _register(client)["claim_token"]
    assert claim
    assert _claim(client, claim)["verified"] is False

    _verify(client)

    body = _claim(client, claim)
    assert body["verified"] is True and body["access_token"] and body["device_token"]
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {body['access_token']}"})
    assert me.status_code == 200 and me.json()["username"] == "bob"
    # Вкладка запомнена: следующий вход отсюда — без кода.
    assert _login(client, body["device_token"])["mfa_required"] is False
    # Секрет одноразовый.
    assert _claim(client, claim)["verified"] is False


def test_claim_of_other_registration_does_not_log_in(client, db):
    _register(client, "bob")
    _register(client, "eve")
    _verify(client, "bob")
    assert _claim(client, "not-a-real-claim")["verified"] is False


def test_new_browser_on_same_ip_skips_code_right_after_verification(client, db, monkeypatch):
    _same_ip_window(monkeypatch)
    _register(client)
    _verify(client)

    body = _login(client)  # PWA: своего device token ещё нет
    assert body["mfa_required"] is False
    assert body["access_token"] and body["device_token"]
    assert _login(client, body["device_token"])["mfa_required"] is False


def test_new_browser_without_recent_verification_still_needs_code(client, db, monkeypatch):
    _same_ip_window(monkeypatch)
    monkeypatch.setattr("app.routers.auth.send_email_code", lambda *a, **k: True)
    create_user(db, "bob")
    body = _login(client)
    assert body["mfa_required"] is True and body["new_device"] is True


def test_own_email_2fa_is_not_skipped_on_same_ip(client, db, monkeypatch):
    _same_ip_window(monkeypatch)
    monkeypatch.setattr("app.routers.auth.send_email_code", lambda *a, **k: True)
    _register(client)
    _verify(client)
    user = db.query(User).filter(User.username == "bob").first()
    user.email_2fa_enabled = True
    db.commit()

    from app.email_2fa import clear_email_code

    clear_email_code(user.id, PURPOSE_LOGIN)
    assert _login(client)["mfa_required"] is True


def test_onboarding_save_queues_first_wave_precompute(client, db):
    user = create_user(db, "newbie")
    headers = auth_headers(client, username="newbie")
    redis_client.delete(flow_router._PC_QUEUE, flow_router._PC_QUEUED)
    redis_client.delete(flow_router._pc_meta_key(user.id))

    resp = client.put(
        "/api/users/me/preferences?hour=21",
        json={"preferred_genres": ["rock"], "preferred_artists": ["Radiohead"]},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    assert redis_client.lrange(flow_router._PC_QUEUE, 0, -1) == [str(user.id)]
    meta = get_cache(flow_router._pc_meta_key(user.id))
    assert meta["limit"] == flow_router._PC_START_LIMIT
    assert meta["base_url"].startswith("http")
    assert isinstance(meta["hour_offset"], int)


# --- Сессия из Safari в приложение на экране «Домой» (app.session_handoff) ---


def _issue_handoff(client):
    resp = client.post("/api/auth/handoff", headers=auth_headers(client, "bob"))
    assert resp.status_code == 200, resp.text
    return resp.json()["token"]


def _claim_handoff(client, token=None, cookie=None):
    kwargs = {"cookies": {"bolt_handoff": cookie}} if cookie else {}
    resp = client.post("/api/auth/handoff/claim", json={"token": token}, **kwargs)
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_home_screen_app_signs_in_with_safari_handoff(client, db):
    create_user(db, "bob")
    token = _issue_handoff(client)

    body = _claim_handoff(client, token)
    assert body["signed_in"] is True and body["access_token"] and body["device_token"]
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {body['access_token']}"})
    assert me.status_code == 200 and me.json()["username"] == "bob"
    # Приложение запомнено: следующий вход оттуда — без кода.
    assert _login(client, body["device_token"])["mfa_required"] is False
    # Токен одноразовый.
    assert _claim_handoff(client, token)["signed_in"] is False


def test_handoff_token_from_copied_cookie(client, db):
    create_user(db, "bob")
    token = _issue_handoff(client)
    assert _claim_handoff(client, cookie=token)["signed_in"] is True


def test_handoff_without_token_does_nothing(client, db):
    create_user(db, "bob")
    assert _claim_handoff(client)["signed_in"] is False
    assert _claim_handoff(client, "not-a-token")["signed_in"] is False


def test_new_handoff_revokes_previous_one(client, db):
    create_user(db, "bob")
    first = _issue_handoff(client)
    second = _issue_handoff(client)
    assert _claim_handoff(client, first)["signed_in"] is False
    assert _claim_handoff(client, second)["signed_in"] is True


def test_handoff_needs_signed_in_session(client, db):
    assert client.post("/api/auth/handoff").status_code == 401


def test_handoff_of_deactivated_user_does_not_sign_in(client, db):
    user = create_user(db, "bob")
    token = _issue_handoff(client)
    user.is_active = False
    db.commit()
    assert _claim_handoff(client, token)["signed_in"] is False


def test_logout_revokes_handoff(client, db):
    create_user(db, "bob")
    token = _issue_handoff(client)
    resp = client.delete("/api/auth/handoff", headers=auth_headers(client, "bob"))
    assert resp.status_code == 200, resp.text
    assert _claim_handoff(client, token)["signed_in"] is False


def test_forgetting_all_devices_revokes_handoff(client, db):
    create_user(db, "bob")
    token = _issue_handoff(client)
    resp = client.post("/api/auth/devices/revoke-all", headers=auth_headers(client, "bob"))
    assert resp.status_code == 200, resp.text
    assert _claim_handoff(client, token)["signed_in"] is False
