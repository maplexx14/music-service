"""Скачивание аудио для архивации: сегментные range-запросы и докачка.

googlevideo троттлит и обрывает длинные потоки, поэтому файл тянется короткими
сегментами: обрыв стоит один сегмент, а не весь файл, и повтор продолжает с
достигнутой позиции. Неполный файл наверх не отдаётся — иначе обрезанный трек
уехал бы в MinIO навсегда.
"""

import asyncio
import os
import threading
from unittest.mock import AsyncMock

import httpx
import pytest

from app import external_archive
from app.models import Track
from tests.conftest import TestingSessionLocal


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _range_start(request: httpx.Request) -> int:
    header = request.headers.get("range", "bytes=0-")
    return int(header.split("=", 1)[1].split("-", 1)[0])


def _download(client: httpx.AsyncClient, **kwargs) -> tuple[str, int]:
    async def run():
        async with client:
            return await external_archive._download_to_temp(
                "https://cdn.example/audio", ".m4a", client, **kwargs
            )

    return asyncio.run(run())


def _cleanup(path: str) -> None:
    for candidate in (path, path + ".state"):
        if os.path.exists(candidate):
            os.remove(candidate)


def test_segmented_download_assembles_whole_file(monkeypatch):
    """Файл больше сегмента собирается из нескольких range-запросов."""
    monkeypatch.setattr(external_archive, "_SEGMENT", 1024)
    body = bytes(range(256)) * 12  # 3072 байта — три сегмента
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        start = _range_start(request)
        seen.append(start)
        chunk = body[start:start + 1024]
        return httpx.Response(
            206,
            content=chunk,
            headers={
                "content-range": f"bytes {start}-{start + len(chunk) - 1}/{len(body)}"
            },
        )

    path, size = _download(_client(handler))
    try:
        assert seen == [0, 1024, 2048]
        assert size == len(body)
        with open(path, "rb") as fh:
            assert fh.read() == body
    finally:
        _cleanup(path)


def test_download_resumes_after_midsegment_disconnect(monkeypatch):
    """Обрыв внутри сегмента не теряет прогресс: докачка идёт с той же позиции."""
    monkeypatch.setattr(external_archive, "_SEGMENT", 1024)
    body = bytes(range(256)) * 8  # 2048 байт
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        start = _range_start(request)
        calls["n"] += 1
        # Первый сегмент рвётся на середине: заявлен 1024, отдано 512.
        if calls["n"] == 1:
            return httpx.Response(
                206,
                content=body[0:512],
                headers={
                    "content-range": f"bytes 0-1023/{len(body)}",
                    "content-length": "1024",
                },
            )
        chunk = body[start:start + 1024]
        return httpx.Response(
            206,
            content=chunk,
            headers={
                "content-range": f"bytes {start}-{start + len(chunk) - 1}/{len(body)}"
            },
        )

    path, size = _download(_client(handler))
    try:
        assert size == len(body)
        with open(path, "rb") as fh:
            assert fh.read() == body
    finally:
        _cleanup(path)


def test_incomplete_download_raises_and_keeps_progress(monkeypatch):
    """Если докачать не удалось, наверх идёт ошибка, а не обрезанный файл."""
    monkeypatch.setattr(external_archive, "_SEGMENT", 1024)
    monkeypatch.setattr(external_archive, "_SEGMENT_RETRIES", 1)
    body = b"x" * 4096
    served = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        start = _range_start(request)
        served["n"] += 1
        # Первый сегмент проходит, дальше CDN отдаёт пустые ответы.
        if served["n"] == 1:
            return httpx.Response(
                206,
                content=body[:1024],
                headers={"content-range": f"bytes 0-1023/{len(body)}"},
            )
        return httpx.Response(
            206,
            content=b"",
            headers={"content-range": f"bytes {start}-{start}/{len(body)}"},
        )

    with pytest.raises(httpx.HTTPError):
        _download(_client(handler))

    # Прогресс сохранён в state-файле, чтобы следующая попытка продолжила с него.
    leftovers = [
        f for f in os.listdir("/tmp")
        if f.endswith(".state") and os.path.getsize(os.path.join("/tmp", f)) > 0
    ]
    for name in leftovers:
        with open(os.path.join("/tmp", name)) as fh:
            if fh.read().strip() == "1024":
                os.remove(os.path.join("/tmp", name))
                break


def test_server_ignoring_range_serves_file_once(monkeypatch):
    """Сервер без поддержки Range отдаёт файл целиком — цикл не повторяется."""
    monkeypatch.setattr(external_archive, "_SEGMENT", 1024)
    body = b"y" * 3000
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, content=body)

    path, size = _download(_client(handler))
    try:
        assert calls["n"] == 1
        assert size == len(body)
        with open(path, "rb") as fh:
            assert fh.read() == body
    finally:
        _cleanup(path)


def test_oversized_download_is_rejected(monkeypatch):
    """Трек сверх лимита размера прерывается _TooLarge."""
    monkeypatch.setattr(external_archive, "_SEGMENT", 1024)
    monkeypatch.setattr(external_archive, "MAX_AUDIO_BYTES", 2048)
    body = b"z" * 8192

    def handler(request: httpx.Request) -> httpx.Response:
        start = _range_start(request)
        chunk = body[start:start + 1024]
        return httpx.Response(
            206,
            content=chunk,
            headers={
                "content-range": f"bytes {start}-{start + len(chunk) - 1}/{len(body)}"
            },
        )

    with pytest.raises(external_archive._TooLarge):
        _download(_client(handler))


def test_bot_check_during_archive_is_blocked_not_retried(monkeypatch):
    """Bot-check YouTube в архивации — терминальный статус, а НЕ transient.

    Раньше он проваливался в TransientResolveError (BotCheckError — его
    подкласс) и ретраился 4 раза по 2с из каждого стрима, то есть фоновая
    архивация сама доливала запросов в уже сработавший rate-limit и продлевала
    блокировку. Ретрай-циклы (schedule_archive*) повторяют только TRANSIENT и
    FAILED, поэтому проверяем и то, что BLOCKED в этот набор не попал.
    """
    from app.routers import ytdlp

    async def bot_check(_video_id, force=False):
        raise ytdlp.BotCheckError(_video_id)

    monkeypatch.setattr(ytdlp, "_resolve_cached", bot_check)

    status, tmp_path = asyncio.run(
        external_archive._archive_external_core(
            db=None, source="ytmusic", external_id="vid", permalink=None, track=None
        )
    )

    assert status == external_archive.ArchiveResult.BLOCKED
    assert tmp_path is None
    assert status not in (
        external_archive.ArchiveResult.TRANSIENT,
        external_archive.ArchiveResult.FAILED,
    )


def test_transient_resolve_during_archive_still_retries(monkeypatch):
    """Обычный временный сбой резолва остаётся TRANSIENT — его ретраить надо."""
    from app.routers import ytdlp

    async def transient(_video_id, force=False):
        raise ytdlp.TransientResolveError(_video_id)

    monkeypatch.setattr(ytdlp, "_resolve_cached", transient)

    status, _tmp = asyncio.run(
        external_archive._archive_external_core(
            db=None, source="ytmusic", external_id="vid", permalink=None, track=None
        )
    )

    assert status == external_archive.ArchiveResult.TRANSIENT


def test_archive_transcodes_and_uploads_off_event_loop(monkeypatch, tmp_path):
    """ffmpeg и заливка в хранилище идут в треде, а не в event loop воркера.

    Синхронный вызов в корутине останавливал весь воркер на время транскода и
    заливки: на проде 2026-10-14 при простаивающем сервере API p95 3.7 с,
    p99 12.6 с, /api/health до 20 с.
    """
    from app.routers import ytdlp

    threads = {}

    async def resolved(_video_id, force=False):
        return "https://cdn.example/audio", ".webm", 3, True

    async def download(url, suffix, client, resume_path=None):
        path = tmp_path / f"dl{suffix}"
        path.write_bytes(b"abc")
        return str(path), 3

    def transcode(path):
        threads["transcode"] = threading.current_thread()
        return path

    def upload(path, key, content_type):
        threads["upload"] = threading.current_thread()
        return f"minio://music/{key}", 3

    monkeypatch.setattr(ytdlp, "_resolve_cached", resolved)
    monkeypatch.setattr(external_archive, "_download_to_temp", download)
    monkeypatch.setattr(external_archive, "transcode_to_aac", transcode)
    monkeypatch.setattr(external_archive, "analyze_file", lambda _path: None)
    monkeypatch.setattr(external_archive.storage, "ensure_buckets", lambda: None)
    monkeypatch.setattr(external_archive.storage, "upload_music_file", upload)
    monkeypatch.setattr(external_archive, "_note_archived", AsyncMock())
    monkeypatch.setattr(external_archive, "_note_acoustic_features", AsyncMock())

    async def run():
        threads["loop"] = threading.current_thread()
        return await external_archive._archive_external_core(
            db=None, source="ytmusic", external_id="vid", permalink=None, track=None
        )

    status, _tmp = asyncio.run(run())

    assert status == external_archive.ArchiveResult.ARCHIVED
    assert threads["transcode"] is not threads["loop"]
    assert threads["upload"] is not threads["loop"]


def test_upload_rejection_is_not_retried(monkeypatch, tmp_path):
    """Отказ хранилища — UPLOAD_FAILED, которого нет в наборе ретраев.

    Раньше он шёл как FAILED, и цикл повторял скачивание, транскод и заливку
    ещё четыре раза, упираясь в тот же отказ (InvalidPart от bucket.ru).
    """
    from app.routers import ytdlp

    async def resolved(_video_id, force=False):
        return "https://cdn.example/audio", ".m4a", 3, True

    async def download(url, suffix, client, resume_path=None):
        path = tmp_path / f"dl{suffix}"
        path.write_bytes(b"abc")
        return str(path), 3

    def rejected(path, key, content_type):
        raise RuntimeError("S3 operation failed; code: InvalidPart")

    monkeypatch.setattr(ytdlp, "_resolve_cached", resolved)
    monkeypatch.setattr(external_archive, "_download_to_temp", download)
    monkeypatch.setattr(external_archive, "transcode_to_aac", lambda path: path)
    monkeypatch.setattr(external_archive, "analyze_file", lambda _path: None)
    monkeypatch.setattr(external_archive.storage, "ensure_buckets", lambda: None)
    monkeypatch.setattr(external_archive.storage, "upload_music_file", rejected)

    status, tmp = asyncio.run(
        external_archive._archive_external_core(
            db=None, source="ytmusic", external_id="vid", permalink=None, track=None
        )
    )

    assert status == external_archive.ArchiveResult.UPLOAD_FAILED
    assert tmp is None
    assert not (tmp_path / "dl.m4a").exists()
    assert status not in (
        external_archive.ArchiveResult.TRANSIENT,
        external_archive.ArchiveResult.FAILED,
    )


class _FakeCache:
    """get/set_cache_async в памяти: метка провала без живого Redis."""

    def __init__(self):
        self.values = {}
        self.ttls = {}

    async def get(self, key):
        return self.values.get(key)

    async def set(self, key, value, expire=3600):
        self.values[key] = value
        self.ttls[key] = expire


def _patch_scheduler(monkeypatch, cache):
    monkeypatch.setattr(external_archive.storage, "is_minio_backend", lambda: True)
    monkeypatch.setattr(external_archive, "get_cache_async", cache.get)
    monkeypatch.setattr(external_archive, "set_cache_async", cache.set)
    monkeypatch.setattr(external_archive, "SessionLocal", TestingSessionLocal)
    monkeypatch.setattr(external_archive, "_RETRY_DELAY", 0)
    # Семафор создаётся в event loop теста, а не наследуется от прошлого.
    monkeypatch.setattr(external_archive, "_lazy_sem", None)


@pytest.mark.parametrize(
    "status_name, remembered",
    [("UPLOAD_FAILED", True), ("FAILED", True), ("TOO_LARGE", True), ("TRANSIENT", False)],
)
def test_archive_failure_is_remembered_across_stream_requests(monkeypatch, db, status_name, remembered):
    """Провал архивации запоминается: следующий стрим-запрос трек не трогает.

    Ленивая архивация зовётся на каждом стрим-запросе (Range тоже), и без
    метки трек, который хранилище не принимало, качался, перекодировался и
    заливался заново — на проде 2026-10-14 до 20 попыток за 20 минут на трек.
    Временный сбой резолва не запоминаем: его негатив кэширует резолвер.
    """
    from app.routers import ytdlp

    status = getattr(external_archive.ArchiveResult, status_name)
    cache = _FakeCache()
    calls = {"n": 0}

    async def no_archive(_archive_key):
        return None

    async def core(db, source, external_id, permalink, track, resume_path=None, force_resolve=False):
        calls["n"] += 1
        return status, None

    _patch_scheduler(monkeypatch, cache)
    monkeypatch.setattr(ytdlp, "archived_music_path", no_archive)
    monkeypatch.setattr(external_archive, "_archive_external_core", core)

    async def two_stream_requests():
        await external_archive.schedule_archive_external("ytmusic", "vid")
        first = calls["n"]
        await external_archive.schedule_archive_external("ytmusic", "vid")
        return first

    first = asyncio.run(two_stream_requests())

    retried = status in (
        external_archive.ArchiveResult.TRANSIENT,
        external_archive.ArchiveResult.FAILED,
    )
    assert first == (external_archive._MAX_RETRIES + 1 if retried else 1)
    key = "archive:fail:ytmusic/vid"
    if remembered:
        assert cache.values[key] == status
        assert cache.ttls[key] == external_archive.ARCHIVE_FAIL_TTL
        assert calls["n"] == first
    else:
        assert key not in cache.values
        assert calls["n"] == 2 * first


def test_track_archive_skips_recent_failure(monkeypatch, db):
    """Та же метка для архивации по track_id (/tracks/{id}/stream)."""
    track = Track(title="t", artist="a", duration=200, source="ytmusic", external_id="vid")
    db.add(track)
    db.commit()

    cache = _FakeCache()
    calls = {"n": 0}

    async def archive(db, track, client=None, resume_path=None, force_resolve=False):
        calls["n"] += 1
        return external_archive.ArchiveResult.UPLOAD_FAILED, None

    async def no_deezer(_video_id):
        return False

    _patch_scheduler(monkeypatch, cache)
    monkeypatch.setattr(external_archive, "archive_track", archive)
    monkeypatch.setattr(external_archive, "_deezer_serves", no_deezer)

    async def two_stream_requests():
        await external_archive.schedule_archive(track.id)
        await external_archive.schedule_archive(track.id)

    asyncio.run(two_stream_requests())

    assert calls["n"] == 1
    assert cache.values["archive:fail:ytmusic/vid"] == external_archive.ArchiveResult.UPLOAD_FAILED
