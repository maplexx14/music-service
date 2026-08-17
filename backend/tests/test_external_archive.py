"""Скачивание аудио для архивации: сегментные range-запросы и докачка.

googlevideo троттлит и обрывает длинные потоки, поэтому файл тянется короткими
сегментами: обрыв стоит один сегмент, а не весь файл, и повтор продолжает с
достигнутой позиции. Неполный файл наверх не отдаётся — иначе обрезанный трек
уехал бы в MinIO навсегда.
"""

import asyncio
import os

import httpx
import pytest

from app import external_archive


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
