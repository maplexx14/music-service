"""?fmt=adts: AAC из MP4 отдаётся в ADTS — с ним Safari на iOS стартует сразу.

Проверяем то, что ломается молча: перекладку без потери звука (кадры ADTS
с синхрословом), отдачу с Range и откат на оригинал, если переложить нельзя.
"""

import asyncio
import shutil
import subprocess

import pytest
from starlette.requests import Request

from app import adts
from app.routers import ytdlp

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="нужен ffmpeg")


def _request(query=b"fmt=adts", headers=()):
    return Request({
        "type": "http", "method": "GET", "path": "/api/ytdlp/stream/X", "query_string": query,
        "headers": list(headers), "server": ("test", 80), "scheme": "http", "root_path": "",
    })


def _make(path, codec_args):
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
         *codec_args, str(path)],
        check=True,
    )


@pytest.fixture
def cache(monkeypatch, tmp_path):
    monkeypatch.setattr(ytdlp, "CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(adts, "_failed", set())
    return tmp_path


async def _body(response):
    return b"".join([chunk async for chunk in response.body_iterator])


def test_mp4_is_served_as_adts(cache):
    src = cache / "VIDEOID1.m4a"
    _make(src, ["-c:a", "aac", "-b:a", "128k"])

    response = asyncio.run(ytdlp._serve_file(str(src), "audio/mp4", _request()))
    body = asyncio.run(_body(response))

    assert response.media_type == "audio/aac"
    # Синхрослово ADTS (12 единичных бит) — первый же кадр.
    assert body[0] == 0xFF and body[1] & 0xF0 == 0xF0
    assert response.headers["content-length"] == str(len(body))


def test_range_requests_hit_the_same_adts_bytes(cache):
    src = cache / "VIDEOID1.m4a"
    _make(src, ["-c:a", "aac", "-b:a", "128k"])
    full = asyncio.run(_body(asyncio.run(ytdlp._serve_file(str(src), "audio/mp4", _request()))))

    part = asyncio.run(ytdlp._serve_file(
        str(src), "audio/mp4", _request(headers=[(b"range", b"bytes=100-199")]),
    ))

    assert part.status_code == 206
    assert asyncio.run(_body(part)) == full[100:200]


def test_without_param_mp4_stays_mp4(cache):
    src = cache / "VIDEOID1.m4a"
    _make(src, ["-c:a", "aac", "-b:a", "128k"])

    response = asyncio.run(ytdlp._serve_file(str(src), "audio/mp4", _request(query=b"")))

    assert response.media_type == "audio/mp4"
    assert not (cache / "adts").exists() or not list((cache / "adts").glob("*.aac"))


def test_non_aac_mp4_falls_back_to_original(cache):
    src = cache / "VIDEOID1.m4a"
    _make(src, ["-c:a", "alac"])

    response = asyncio.run(ytdlp._serve_file(str(src), "audio/mp4", _request()))

    assert response.media_type == "audio/mp4"
    assert asyncio.run(_body(response)) == src.read_bytes()


def test_redirect_keeps_adts_format():
    from fastapi.responses import RedirectResponse

    redirect = RedirectResponse("/api/soulseek/stream/T?vid=X", status_code=307)

    assert ytdlp._keep_fmt(redirect, _request()).headers["location"] == (
        "/api/soulseek/stream/T?vid=X&fmt=adts"
    )
