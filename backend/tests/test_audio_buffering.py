"""Аудио-ответы помечаются X-Accel-Buffering: yes.

Без заголовка потолок скорости отдачи аудио в nginx (limit_rate) молча не
действует: в location /api/ стоит proxy_buffering off.
"""

from fastapi import FastAPI
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.testclient import TestClient

from app.main import AudioBufferingMiddleware


def _client():
    app = FastAPI()
    app.add_middleware(AudioBufferingMiddleware)

    @app.get("/audio")
    def audio():
        return StreamingResponse(iter([b"abc"]), media_type="audio/mp4")

    @app.get("/json")
    def json():
        return JSONResponse({"ok": True})

    return TestClient(app)


def test_audio_response_enables_nginx_buffering():
    response = _client().get("/audio")
    assert response.headers["x-accel-buffering"] == "yes"
    assert response.content == b"abc"


def test_other_responses_stay_unbuffered():
    assert "x-accel-buffering" not in _client().get("/json").headers
