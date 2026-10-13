"""Хедж запросов к YouTube Music (ytdlp._hedged_request).

Прод 2026-10-13: примерно каждый десятый запрос к каталогу висел 8–9 с и
кончался 403, а повтор того же запроса проходил за 0.3 с. Хедж должен
отдавать удачный дубль, не дожидаясь зависшего оригинала.
"""

import threading
import time

from app.routers import ytdlp


class _Resp:
    def __init__(self, status=200, content=b'{"ok": 1}'):
        self.status_code = status
        self.content = content


def _scripted(*steps):
    """send(), отвечающий по порядку вызовов: (задержка, ответ или исключение)."""
    calls = []
    lock = threading.Lock()

    def send():
        with lock:
            index = len(calls)
            calls.append(index)
        delay, result = steps[index]
        time.sleep(delay)
        if isinstance(result, Exception):
            raise result
        return result

    return send, calls


def test_fast_ok_is_single_request(monkeypatch):
    monkeypatch.setattr(ytdlp, "_YTMUSIC_HEDGE_DELAY", 0.2)
    ok = _Resp()
    send, calls = _scripted((0.0, ok))
    assert ytdlp._hedged_request(send) is ok
    assert len(calls) == 1


def test_stalled_request_is_hedged(monkeypatch):
    monkeypatch.setattr(ytdlp, "_YTMUSIC_HEDGE_DELAY", 0.1)
    ok = _Resp()
    send, calls = _scripted((1.5, _Resp(403, b"<html>")), (0.0, ok))
    started = time.monotonic()
    assert ytdlp._hedged_request(send) is ok
    assert time.monotonic() - started < 1.0
    assert len(calls) == 2


def test_fast_failure_is_retried_once(monkeypatch):
    monkeypatch.setattr(ytdlp, "_YTMUSIC_HEDGE_DELAY", 0.5)
    ok = _Resp()
    send, calls = _scripted((0.0, _Resp(403, b"<html>")), (0.0, ok))
    assert ytdlp._hedged_request(send) is ok
    assert len(calls) == 2


def test_fast_network_error_is_retried(monkeypatch):
    monkeypatch.setattr(ytdlp, "_YTMUSIC_HEDGE_DELAY", 0.5)
    ok = _Resp()
    send, calls = _scripted((0.0, ConnectionError("reset")), (0.0, ok))
    assert ytdlp._hedged_request(send) is ok
    assert len(calls) == 2


def test_both_failed_returns_last_failure(monkeypatch):
    monkeypatch.setattr(ytdlp, "_YTMUSIC_HEDGE_DELAY", 0.05)
    slow_bad = _Resp(403, b"<html>")
    send, calls = _scripted((0.3, slow_bad), (0.0, _Resp(500, b"")))
    assert ytdlp._hedged_request(send) is slow_bad
    assert len(calls) == 2


def test_session_routes_requests_through_hedge(monkeypatch):
    """ytmusicapi зовёт session.post/get — они должны идти через хедж с таймаутом."""
    import requests

    seen = {}

    def fake_request(self, method, url, **kwargs):
        seen.update(method=method, url=url, timeout=kwargs.get("timeout"))
        return _Resp()

    monkeypatch.setattr(requests.Session, "request", fake_request)
    hedged = []
    real = ytdlp._hedged_request
    monkeypatch.setattr(ytdlp, "_hedged_request", lambda send: hedged.append(1) or real(send))

    session = ytdlp._ytmusic_session()
    session.post("https://music.youtube.com/youtubei/v1/search", json={})
    assert hedged == [1]
    assert seen["method"] == "POST"
    assert seen["timeout"] == ytdlp._YTMUSIC_TIMEOUT
