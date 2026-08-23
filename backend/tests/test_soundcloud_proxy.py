"""Прокси для метаданных SoundCloud: выбор выхода и его границы.

Смысл этих тестов — зафиксировать два инварианта, из-за которых поиск по
SoundCloud отдавал пустой список, потратив 15 секунд:

1. api-v2 и скрейп client_id ходят ЧЕРЕЗ прокси — провайдер режет SoundCloud
   целиком, и прямой выход получает ConnectTimeout на soundcloud.com и 403 от
   api-v2 даже с валидным client_id;
2. аудио SoundCloud при этом остаётся ПРЯМЫМ — к IP выхода оно не привязано, и
   гнать его через платный прокси незачем. Этот знак отдельный от
   STREAM_PROXY именно поэтому: включение одного не должно включать другой.
"""

import asyncio

import httpx
import pytest

from app.routers import soundcloud, ytdlp

_PROXY = "http://user:s3cret@89.46.235.76:16876"
_SC_MEDIA = "https://playback.media-streaming.soundcloud.cloud/abc.128.mp3"
_GV = "https://rr5---sn-4g5ednsy.googlevideo.com/videoplayback?expire=1"


@pytest.fixture
def sc_proxy_file(tmp_path, monkeypatch):
    """Файл с активным выходом для SoundCloud + сброшенный кэш перечитки."""
    path = tmp_path / "soundcloud.url"
    path.write_text(f"# активный выход\n{_PROXY}\n", encoding="utf-8")
    monkeypatch.setattr(soundcloud, "_SC_PROXY_FILE", str(path))
    monkeypatch.setattr(soundcloud, "_SC_PROXY_STATIC", "")
    monkeypatch.setattr(soundcloud, "_sc_proxy_cache", (-1.0, None))
    return path


def test_reads_file_skipping_comments(sc_proxy_file):
    assert soundcloud.soundcloud_proxy() == _PROXY


def test_rereads_after_mtime_change(sc_proxy_file):
    import os

    assert soundcloud.soundcloud_proxy() == _PROXY
    new = "http://user:s3cret@89.46.235.76:11455"
    sc_proxy_file.write_text(f"{new}\n", encoding="utf-8")
    # mtime выставляем явно: две записи подряд могут попасть в одну секунду, и
    # тест на перечитку стал бы флаки на файловых системах с грубым mtime.
    stat = os.stat(sc_proxy_file)
    os.utime(sc_proxy_file, (stat.st_atime, stat.st_mtime + 10))
    assert soundcloud.soundcloud_proxy() == new


def test_falls_back_to_static_when_file_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(soundcloud, "_SC_PROXY_FILE", str(tmp_path / "нет.url"))
    monkeypatch.setattr(soundcloud, "_SC_PROXY_STATIC", _PROXY)
    monkeypatch.setattr(soundcloud, "_sc_proxy_cache", (-1.0, None))
    assert soundcloud.soundcloud_proxy() == _PROXY


def test_none_when_nothing_configured(monkeypatch):
    monkeypatch.setattr(soundcloud, "_SC_PROXY_FILE", "")
    monkeypatch.setattr(soundcloud, "_SC_PROXY_STATIC", "")
    assert soundcloud.soundcloud_proxy() is None


def test_ydl_opts_get_proxy_when_configured(sc_proxy_file):
    assert soundcloud._sc_ydl_opts({"quiet": True})["proxy"] == _PROXY


def test_ydl_opts_untouched_when_unconfigured(monkeypatch):
    monkeypatch.setattr(soundcloud, "_SC_PROXY_FILE", "")
    monkeypatch.setattr(soundcloud, "_SC_PROXY_STATIC", "")
    # Ключа быть не должно вовсе: с ``proxy`` в опциях yt-dlp перестаёт смотреть
    # на переменные окружения, и ненастроенный стенд менял бы поведение молча.
    assert "proxy" not in soundcloud._sc_ydl_opts({"quiet": True})


class _FakeResponse:
    status_code = 200

    def json(self):
        return {"collection": []}


class _FakeClient:
    """Записывает kwargs конструктора и отдаёт готовый 200."""

    captured: dict = {}

    def __init__(self, **kwargs):
        type(self).captured = kwargs

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, params=None):
        return _FakeResponse()


def test_api_get_goes_through_proxy(sc_proxy_file, monkeypatch):
    monkeypatch.setattr(httpx, "AsyncClient", _FakeClient)
    # client_id уже в кэше: скрейп в этом тесте не нужен, проверяем сам выход.
    async def fake_get_cache_async(key):
        return "c" * 32

    monkeypatch.setattr(soundcloud, "get_cache_async", fake_get_cache_async)
    result = asyncio.run(soundcloud._api_get("/search/tracks", {"q": "phonk"}))
    assert result == {"collection": []}
    assert _FakeClient.captured["proxy"] == _PROXY


def test_api_get_direct_when_unconfigured(monkeypatch):
    monkeypatch.setattr(soundcloud, "_SC_PROXY_FILE", "")
    monkeypatch.setattr(soundcloud, "_SC_PROXY_STATIC", "")
    monkeypatch.setattr(httpx, "AsyncClient", _FakeClient)

    async def fake_get_cache_async(key):
        return "c" * 32

    monkeypatch.setattr(soundcloud, "get_cache_async", fake_get_cache_async)
    asyncio.run(soundcloud._api_get("/search/tracks", {"q": "phonk"}))
    assert _FakeClient.captured["proxy"] is None


def test_soundcloud_audio_stays_direct(sc_proxy_file, monkeypatch):
    """Главный инвариант: настроенный прокси метаданных не трогает аудио.

    ytdlp.proxy_for_url отвечает за скачивание, и SoundCloud там должен
    остаться на прямом выходе, даже когда SOUNDCLOUD_PROXY задан.
    """
    monkeypatch.setattr(ytdlp, "_STREAM_PROXY_FILE", "")
    monkeypatch.setattr(ytdlp, "_STREAM_PROXY_STATIC", "")
    assert soundcloud.soundcloud_proxy() == _PROXY
    assert ytdlp.proxy_for_url(_SC_MEDIA) is None
    # И наоборот: знак SoundCloud не включает платный выход для googlevideo.
    assert ytdlp.proxy_for_url(_GV) is None
