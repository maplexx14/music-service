"""Прокси для скачивания аудио: выбор выхода и горячая перечитка файла.

Смысл этих тестов — зафиксировать инвариант, из-за нарушения которого
воспроизведение отдавало 403: ссылка googlevideo привязана к IP выхода, через
который её выдал Invidious-companion, поэтому качать её надо через ТОТ ЖЕ
прокси, а всё остальное (SoundCloud, обложки) — напрямую.
"""

import httpx
import pytest

from app import external_archive
from app.routers import ytdlp

_PROXY = "http://user:s3cret@89.46.235.76:16119"
_GV = "https://rr5---sn-4g5ednsy.googlevideo.com/videoplayback?expire=1&ip=2a03:f80::1"
_SC = "https://cf-media.sndcdn.com/abc.128.mp3"


@pytest.fixture
def proxy_file(tmp_path, monkeypatch):
    """Файл с активным прокси + сброшенный кэш перечитки."""
    path = tmp_path / "active.url"
    path.write_text(f"# активный выход\n{_PROXY}\n", encoding="utf-8")
    monkeypatch.setattr(ytdlp, "_STREAM_PROXY_FILE", str(path))
    monkeypatch.setattr(ytdlp, "_STREAM_PROXY_STATIC", "")
    monkeypatch.setattr(ytdlp, "_stream_proxy_cache", (-1.0, None))
    return path


def test_stream_proxy_reads_file_skipping_comments(proxy_file):
    assert ytdlp.stream_proxy() == _PROXY


def test_stream_proxy_rereads_after_mtime_change(proxy_file):
    import os

    assert ytdlp.stream_proxy() == _PROXY
    new = "http://user:s3cret@89.46.235.76:11455"
    proxy_file.write_text(f"{new}\n", encoding="utf-8")
    # mtime выставляем явно: две записи подряд могут попасть в одну секунду, и
    # тест на перечитку стал бы флаки на файловых системах с грубым mtime.
    stat = os.stat(proxy_file)
    os.utime(proxy_file, (stat.st_atime, stat.st_mtime + 10))
    assert ytdlp.stream_proxy() == new


def test_stream_proxy_falls_back_to_static_when_file_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(ytdlp, "_STREAM_PROXY_FILE", str(tmp_path / "нет.url"))
    monkeypatch.setattr(ytdlp, "_STREAM_PROXY_STATIC", _PROXY)
    monkeypatch.setattr(ytdlp, "_stream_proxy_cache", (-1.0, None))
    assert ytdlp.stream_proxy() == _PROXY


def test_stream_proxy_none_when_nothing_configured(monkeypatch):
    monkeypatch.setattr(ytdlp, "_STREAM_PROXY_FILE", "")
    monkeypatch.setattr(ytdlp, "_STREAM_PROXY_STATIC", "")
    assert ytdlp.stream_proxy() is None


def test_proxy_only_for_googlevideo(proxy_file):
    assert ytdlp.proxy_for_url(_GV) == _PROXY
    # SoundCloud идёт через тот же stream_cached_audio, но к IP не привязан:
    # платный трафик на него тратить незачем.
    assert ytdlp.proxy_for_url(_SC) is None


def test_no_proxy_for_googlevideo_when_unconfigured(monkeypatch):
    monkeypatch.setattr(ytdlp, "_STREAM_PROXY_FILE", "")
    monkeypatch.setattr(ytdlp, "_STREAM_PROXY_STATIC", "")
    assert ytdlp.proxy_for_url(_GV) is None


def test_mask_proxy_hides_password():
    masked = ytdlp._mask_proxy(_PROXY)
    assert "s3cret" not in masked and "89.46.235.76:16119" in masked
    assert ytdlp._mask_proxy(None) == "нет (прямой выход)"


def test_stream_client_passes_proxy(proxy_file, monkeypatch):
    captured = {}

    class FakeClient:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)
    ytdlp._stream_client(httpx.Timeout(5.0), _GV)
    assert captured["proxy"] == _PROXY
    assert captured["follow_redirects"] is True

    captured.clear()
    ytdlp._stream_client(httpx.Timeout(5.0), _SC)
    assert captured["proxy"] is None


def test_download_client_reuses_shared_client_for_non_googlevideo(proxy_file):
    shared = object()
    client, owned = external_archive._download_client(_SC, shared)
    assert client is shared and owned is False


def test_download_client_creates_proxied_client_for_googlevideo(proxy_file):
    import asyncio

    shared = object()
    client, owned = external_archive._download_client(_GV, shared)
    try:
        assert client is not shared and owned is True
        assert isinstance(client, httpx.AsyncClient)
    finally:
        # aclose корутинный, а pytest-asyncio в проекте не подключён (остальные
        # тесты тоже гоняют корутины через asyncio.run).
        asyncio.run(client.aclose())
