"""Низкобитрейтный вариант стрима (?quality=low).

Клиент на медленном канале просит вдвое меньше байтов на тот же трек: HE-AAC
64 kbps вместо 128 kbps. Вариант собирается по первому запросу и кэшируется в
MinIO, поэтому тесты фиксируют вещи, которые легко сломать незаметно:
сборка идёт ровно один раз на ключ (iOS шлёт десятки Range-запросов на трек),
стрим её не ждёт, её провал отдаёт оригинал, а не 5xx, и путь Range/ETag после
подмены объекта работает как раньше.
"""

import asyncio
import os

from fastapi import Request

from app import storage


def _request(query="", headers=None):
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/",
        "query_string": query.encode(),
        "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()],
    }
    return Request(scope)


def _headers(resp):
    return {k.lower(): v for k, v in resp.headers.items()}


class _MinioStub:
    """Минимальный MinIO: набор объектов + запись заливок."""

    def __init__(self, objects):
        self.objects = dict(objects)  # (bucket, key) -> bytes
        self.uploads = []

    def fget_object(self, bucket, key, path):
        with open(path, "wb") as fh:
            fh.write(self.objects[(bucket, key)])

    def upload(self, path, key, content_type):
        bucket = storage.MUSIC_BUCKET
        with open(path, "rb") as fh:
            self.objects[(bucket, key)] = fh.read()
        self.uploads.append((key, content_type))
        return storage.make_object_path(bucket, key), os.path.getsize(path)


def _wire(monkeypatch, stub, transcode_ok=True, transcode_calls=None, built_at=0.0):
    """built_at — LastModified уже лежащих в stub объектов (0 — давно собраны)."""
    monkeypatch.setattr(storage, "is_minio_backend", lambda: True)
    monkeypatch.setattr(storage, "_get_internal_client", lambda: stub)
    monkeypatch.setattr(storage, "upload_music_file", stub.upload)

    async def fake_stat(file_path, db_size=None, db_content_type=None):
        bucket, key = storage.parse_object_path(file_path)
        if (bucket, key) not in stub.objects:
            raise FileNotFoundError(file_path)
        return (len(stub.objects[(bucket, key)]), "audio/mp4", f'"{key}"')

    monkeypatch.setattr(storage, "stat_music_object_async", fake_stat)

    async def fake_built_at(low_path):
        bucket, key = storage.parse_object_path(low_path)
        return built_at if (bucket, key) in stub.objects else None

    monkeypatch.setattr(storage, "_low_variant_built_at", fake_built_at)
    storage._low_ready_at.clear()
    storage._low_build_pending.clear()
    storage._low_build_tasks.clear()

    calls = transcode_calls if transcode_calls is not None else []

    def fake_transcode(src, out):
        calls.append(src)
        if not transcode_ok:
            return None
        with open(out, "wb") as fh:
            fh.write(b"HEAAC" * 400)
        return out

    import app.transcode as transcode_module

    monkeypatch.setattr(transcode_module, "transcode_to_low_aac", fake_transcode)
    storage._low_locks.clear()
    storage._low_failed.clear()
    return calls


ORIGINAL = "minio://music/external/ytmusic/abc.m4a"
LOW = "minio://music/external/ytmusic/abc.low.m4a"


def test_existing_low_variant_is_reused(monkeypatch):
    stub = _MinioStub({("music", "external/ytmusic/abc.m4a"): b"x" * 100})
    stub.objects[("music", "external/ytmusic/abc.low.m4a")] = b"y" * 50
    calls = _wire(monkeypatch, stub)

    assert asyncio.run(storage.ensure_low_variant_async(ORIGINAL)) == LOW
    assert calls == []  # объект уже есть, кодировать нечего


def test_missing_low_variant_is_built_once_for_parallel_requests(monkeypatch):
    """Range-запросы одного трека идут пачкой — ffmpeg должен запуститься один раз."""
    stub = _MinioStub({("music", "external/ytmusic/abc.m4a"): b"x" * 100})
    calls = _wire(monkeypatch, stub)

    async def hammer():
        return await asyncio.gather(
            *(storage.ensure_low_variant_async(ORIGINAL) for _ in range(5))
        )

    results = asyncio.run(hammer())
    assert results == [LOW] * 5
    assert len(calls) == 1
    assert stub.uploads == [("external/ytmusic/abc.low.m4a", "audio/mp4")]


def test_failed_transcode_returns_none_and_is_remembered(monkeypatch):
    stub = _MinioStub({("music", "external/ytmusic/abc.m4a"): b"x" * 100})
    calls = _wire(monkeypatch, stub, transcode_ok=False)

    assert asyncio.run(storage.ensure_low_variant_async(ORIGINAL)) is None
    assert asyncio.run(storage.ensure_low_variant_async(ORIGINAL)) is None
    # Второй запрос не запускает кодирование заново — помним неудачу (TTL).
    assert len(calls) == 1
    assert stub.uploads == []


def test_stream_with_quality_low_serves_low_object(monkeypatch):
    stub = _MinioStub({("music", "external/ytmusic/abc.m4a"): b"x" * 400})
    stub.objects[("music", "external/ytmusic/abc.low.m4a")] = b"y" * 200
    _wire(monkeypatch, stub)

    async def fake_iter(file_path, offset=None, length=None, chunk_size=None):
        yield b"z"

    monkeypatch.setattr(storage, "iter_music_object_async", fake_iter)

    resp = asyncio.run(
        storage.minio_range_response_async(
            ORIGINAL, _request("quality=low", {"range": "bytes=0-9"}), quality="low"
        )
    )
    assert resp.status_code == 206
    # Размер и ETag — от низкого объекта, не от оригинала.
    assert _headers(resp)["content-range"] == "bytes 0-9/200"
    assert _headers(resp)["etag"] == '"external/ytmusic/abc.low.m4a"'


def test_stream_without_quality_serves_original(monkeypatch):
    stub = _MinioStub({("music", "external/ytmusic/abc.m4a"): b"x" * 400})
    stub.objects[("music", "external/ytmusic/abc.low.m4a")] = b"y" * 200
    _wire(monkeypatch, stub)

    async def fake_iter(file_path, offset=None, length=None, chunk_size=None):
        yield b"z"

    monkeypatch.setattr(storage, "iter_music_object_async", fake_iter)

    resp = asyncio.run(
        storage.minio_range_response_async(
            ORIGINAL, _request("", {"range": "bytes=0-9"}), quality="high"
        )
    )
    assert _headers(resp)["content-range"] == "bytes 0-9/400"


def test_quality_low_falls_back_to_original_when_transcode_fails(monkeypatch):
    """Провал кодирования не должен превращаться в ошибку: отдаём оригинал."""
    stub = _MinioStub({("music", "external/ytmusic/abc.m4a"): b"x" * 400})
    _wire(monkeypatch, stub, transcode_ok=False)

    async def fake_iter(file_path, offset=None, length=None, chunk_size=None):
        yield b"z"

    monkeypatch.setattr(storage, "iter_music_object_async", fake_iter)

    resp = asyncio.run(
        storage.minio_range_response_async(
            ORIGINAL, _request("quality=low"), quality="low"
        )
    )
    assert resp.status_code == 200
    assert _headers(resp)["content-length"] == "400"


async def _fake_iter(file_path, offset=None, length=None, chunk_size=None):
    yield b"z"


def test_missing_low_variant_does_not_block_first_request(monkeypatch):
    """Первый запрос получает оригинал сразу, вариант собирается фоном.

    Раньше запрос ждал ffmpeg+fdkaac, и каждый новый трек на медленном канале
    молчал секунды до первого байта.
    """
    stub = _MinioStub({("music", "external/ytmusic/abc.m4a"): b"x" * 400})
    calls = _wire(monkeypatch, stub)
    monkeypatch.setattr(storage, "iter_music_object_async", _fake_iter)

    async def scenario():
        resp = await storage.minio_range_response_async(
            ORIGINAL, _request("quality=low", {"range": "bytes=0-9"}), quality="low"
        )
        # Ответ собран до того, как фоновая сборка вообще начала кодировать.
        assert calls == []
        await asyncio.gather(*list(storage._low_build_tasks))
        return resp

    resp = asyncio.run(scenario())
    assert _headers(resp)["content-range"] == "bytes 0-9/400"
    # Кэш оригинала под URL варианта — не дольше выдержки.
    assert _headers(resp)["cache-control"] == f"private, max-age={int(storage._LOW_SETTLE_SECONDS)}"
    assert len(calls) == 1
    assert stub.uploads == [("external/ytmusic/abc.low.m4a", "audio/mp4")]
    assert not storage._low_build_pending


def test_fresh_low_variant_waits_settle_before_serving(monkeypatch):
    """Свежий вариант не отдаётся сразу: иначе <audio>, начавший трек на
    оригинале, следующим Range-запросом получил бы байты другого файла."""
    stub = _MinioStub({("music", "external/ytmusic/abc.m4a"): b"x" * 400})
    stub.objects[("music", "external/ytmusic/abc.low.m4a")] = b"y" * 200
    import time

    _wire(monkeypatch, stub, built_at=time.time() - 60)
    monkeypatch.setattr(storage, "iter_music_object_async", _fake_iter)

    resp = asyncio.run(
        storage.minio_range_response_async(
            ORIGINAL, _request("quality=low", {"range": "bytes=0-9"}), quality="low"
        )
    )
    assert _headers(resp)["content-range"] == "bytes 0-9/400"
    max_age = int(_headers(resp)["cache-control"].split("max-age=")[1])
    assert 0 < max_age <= storage._LOW_SETTLE_SECONDS - 60


def test_parallel_requests_start_one_background_build(monkeypatch):
    stub = _MinioStub({("music", "external/ytmusic/abc.m4a"): b"x" * 400})
    calls = _wire(monkeypatch, stub)
    monkeypatch.setattr(storage, "iter_music_object_async", _fake_iter)

    async def scenario():
        await asyncio.gather(
            *(
                storage.minio_range_response_async(
                    ORIGINAL, _request("quality=low"), quality="low"
                )
                for _ in range(5)
            )
        )
        await asyncio.gather(*list(storage._low_build_tasks))
        # Только что собранный вариант ещё выдерживается — снова оригинал.
        return await storage.minio_range_response_async(
            ORIGINAL, _request("quality=low"), quality="low"
        )

    resp = asyncio.run(scenario())
    assert len(calls) == 1
    assert _headers(resp)["content-length"] == "400"


def test_db_size_path_gives_same_etag_as_head_path(monkeypatch):
    """ETag не пустой и не зависит от того, знал ли вызывающий размер из БД:
    пустой ETag ломал кэш 206 и If-Range на медленных каналах."""

    class _FakeClient:
        async def head_object(self, **kwargs):
            return {"ContentLength": 100, "ContentType": "audio/mp4", "ETag": '"md5"'}

    monkeypatch.setattr(storage, "_get_async_client", lambda: _FakeClient())
    storage._stat_cache.clear()
    try:
        _, _, from_head = asyncio.run(storage.stat_music_object_async("minio://music/a.m4a"))
        storage._stat_cache.clear()
        _, _, from_db = asyncio.run(
            storage.stat_music_object_async("minio://music/a.m4a", db_size=100)
        )
    finally:
        storage._stat_cache.clear()
    assert from_head == from_db
    assert from_head.startswith('"') and len(from_head) > 2


def test_low_variant_key_keeps_directory_and_swaps_extension():
    from app.transcode import low_variant_key

    assert low_variant_key("external/ytmusic/abc.m4a") == "external/ytmusic/abc.low.m4a"
    assert low_variant_key("external/sc/42.webm") == "external/sc/42.low.m4a"
    assert low_variant_key("noext") == "noext.low.m4a"
