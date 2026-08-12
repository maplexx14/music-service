"""Каптча на регистрации (Cloudflare Turnstile).

Две группы: сам модуль app.captcha (что считаем пройденным, что — сбоем) и
поведение /auth/register вокруг него. Сеть в тестах не трогаем: httpx.post
подменяется, поэтому проверяется наша логика, а не доступность Cloudflare.
"""
import httpx
import pytest

from app import captcha
from app.models import User
from tests.conftest import create_user


class _FakeResponse:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("boom", request=None, response=None)

    def json(self):
        return self._payload


@pytest.fixture()
def turnstile_keys(monkeypatch):
    """Каптча настроена — в тестовом окружении ключей нет, ставим свои."""
    monkeypatch.setattr(captcha, "TURNSTILE_SITE_KEY", "site-key")
    monkeypatch.setattr(captcha, "TURNSTILE_SECRET_KEY", "secret-key")
    yield


def _fake_post(monkeypatch, payload=None, exc=None, seen=None):
    def fake_post(url, data=None, timeout=None):
        if seen is not None:
            seen.append({"url": url, "data": data, "timeout": timeout})
        if exc is not None:
            raise exc
        return _FakeResponse(payload)

    monkeypatch.setattr(captcha.httpx, "post", fake_post)


# ─────────────────────────── app.captcha ───────────────────────────


def test_configured_requires_both_keys(monkeypatch):
    monkeypatch.setattr(captcha, "TURNSTILE_SITE_KEY", "site")
    monkeypatch.setattr(captcha, "TURNSTILE_SECRET_KEY", "")
    assert captcha.captcha_configured() is False
    # Половина конфигурации — сломанная настройка, а не «выключено».
    assert captcha.half_configured() is True

    monkeypatch.setattr(captcha, "TURNSTILE_SECRET_KEY", "secret")
    assert captcha.captcha_configured() is True
    assert captcha.half_configured() is False


def test_verify_passes(monkeypatch, turnstile_keys):
    seen = []
    _fake_post(monkeypatch, payload={"success": True}, seen=seen)

    assert captcha.verify_captcha("token-from-widget", "203.0.113.7") is True
    assert seen[0]["data"] == {
        "secret": "secret-key",
        "response": "token-from-widget",
        "remoteip": "203.0.113.7",
    }


def test_verify_rejects_bad_token(monkeypatch, turnstile_keys):
    _fake_post(
        monkeypatch,
        payload={"success": False, "error-codes": ["timeout-or-duplicate"]},
    )
    assert captcha.verify_captcha("stale-token") is False


def test_verify_empty_token_makes_no_request(monkeypatch, turnstile_keys):
    def explode(*args, **kwargs):
        raise AssertionError("siteverify must not be called for an empty token")

    monkeypatch.setattr(captcha.httpx, "post", explode)
    assert captcha.verify_captcha("") is False


def test_verify_network_error_is_unavailable(monkeypatch, turnstile_keys):
    """Сетевой сбой — НЕ «пройдено»: иначе каптча снимается обрывом связи."""
    _fake_post(monkeypatch, exc=httpx.ConnectTimeout("no route"))
    with pytest.raises(captcha.CaptchaUnavailable):
        captcha.verify_captcha("token")


def test_verify_bad_secret_is_unavailable(monkeypatch, turnstile_keys):
    """Отвергнутый секрет — наша поломка, а не неудача юзера."""
    _fake_post(
        monkeypatch,
        payload={"success": False, "error-codes": ["invalid-input-secret"]},
    )
    with pytest.raises(captcha.CaptchaUnavailable):
        captcha.verify_captcha("token")


# ─────────────────────────── /auth/register ───────────────────────────


def test_captcha_config_off_by_default(client):
    body = client.get("/api/auth/captcha-config").json()
    assert body["required"] is False
    assert body["site_key"] is None


def test_captcha_config_exposes_site_key(client, monkeypatch):
    from app.routers import auth as auth_router

    monkeypatch.setattr(auth_router, "captcha_configured", lambda: True)
    monkeypatch.setattr(auth_router, "TURNSTILE_SITE_KEY", "site-key")

    body = client.get("/api/auth/captcha-config").json()
    assert body == {"required": True, "provider": "turnstile", "site_key": "site-key"}


def test_register_without_captcha_when_not_configured(client, db):
    """Ключей нет — регистрация проходит как раньше (локальная разработка)."""
    resp = client.post("/api/auth/register", json={
        "username": "bob",
        "email": "bob@example.com",
        "password": "secret123",
    })
    assert resp.status_code == 201


def test_register_requires_token_when_captcha_on(client, db, monkeypatch):
    from app.routers import auth as auth_router

    monkeypatch.setattr(auth_router, "captcha_configured", lambda: True)

    resp = client.post("/api/auth/register", json={
        "username": "bob",
        "email": "bob@example.com",
        "password": "secret123",
    })
    assert resp.status_code == 400
    assert resp.json()["detail"] == auth_router.CAPTCHA_REQUIRED
    assert db.query(User).filter(User.username == "bob").first() is None


def test_register_rejects_failed_captcha(client, db, monkeypatch):
    from app.routers import auth as auth_router

    monkeypatch.setattr(auth_router, "captcha_configured", lambda: True)
    monkeypatch.setattr(auth_router, "verify_captcha", lambda token, ip=None: False)

    resp = client.post("/api/auth/register", json={
        "username": "bob",
        "email": "bob@example.com",
        "password": "secret123",
        "captcha_token": "bad-token",
    })
    assert resp.status_code == 400
    assert resp.json()["detail"] == auth_router.CAPTCHA_INVALID
    assert db.query(User).filter(User.username == "bob").first() is None


def test_register_accepts_passed_captcha(client, db, monkeypatch):
    from app.routers import auth as auth_router

    seen = []

    def fake_verify(token, ip=None):
        seen.append(token)
        return True

    monkeypatch.setattr(auth_router, "captcha_configured", lambda: True)
    monkeypatch.setattr(auth_router, "verify_captcha", fake_verify)

    resp = client.post("/api/auth/register", json={
        "username": "bob",
        "email": "bob@example.com",
        "password": "secret123",
        "captcha_token": "good-token",
    })
    assert resp.status_code == 201
    assert seen == ["good-token"]
    assert db.query(User).filter(User.username == "bob").first() is not None


def test_register_503_when_captcha_unavailable(client, db, monkeypatch):
    from app.routers import auth as auth_router

    def unavailable(token, ip=None):
        raise auth_router.CaptchaUnavailable("cloudflare down")

    monkeypatch.setattr(auth_router, "captcha_configured", lambda: True)
    monkeypatch.setattr(auth_router, "verify_captcha", unavailable)

    resp = client.post("/api/auth/register", json={
        "username": "bob",
        "email": "bob@example.com",
        "password": "secret123",
        "captcha_token": "token",
    })
    assert resp.status_code == 503
    assert db.query(User).filter(User.username == "bob").first() is None


def test_captcha_checked_before_duplicate_lookup(client, db, monkeypatch):
    """Занятость username не должна вскрываться без каптчи — иначе эндпоинт
    остаётся оракулом существования аккаунтов."""
    from app.routers import auth as auth_router

    create_user(db, "bob")
    monkeypatch.setattr(auth_router, "captcha_configured", lambda: True)

    resp = client.post("/api/auth/register", json={
        "username": "bob",
        "email": "bob@example.com",
        "password": "secret123",
    })
    assert resp.status_code == 400
    assert resp.json()["detail"] == auth_router.CAPTCHA_REQUIRED


def test_register_ignores_full_name(client, db):
    """Полное имя на регистрации больше не спрашивается и не принимается:
    поле осталось только в профиле."""
    resp = client.post("/api/auth/register", json={
        "username": "bob",
        "email": "bob@example.com",
        "password": "secret123",
        "full_name": "Bob Bobson",
    })
    assert resp.status_code == 201
    assert resp.json()["full_name"] is None
    assert db.query(User).filter(User.username == "bob").first().full_name is None
