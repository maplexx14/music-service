"""Внешнее S3 (bucket.ru): один физический бакет с префиксами, SSE-C на каждом
запросе и пропавший у провайдера объект, который не должен ломать трек."""

import asyncio
import time
import base64
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import Request

from app import storage
from app.models import Track

from tests.conftest import create_user, auth_headers

_KEY = bytes(range(32))


class ClientError(Exception):
    """Как botocore.exceptions.ClientError: код ошибки S3 в .response."""

    def __init__(self, error, operation):
        super().__init__(operation)
        self.response = error


@pytest.fixture
def external_s3(monkeypatch):
    monkeypatch.setattr(storage, "S3_BUCKET", "bms")
    monkeypatch.setattr(storage, "_SSE_C_KEY", _KEY)


def _request(headers=None):
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/",
        "query_string": b"",
        "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()],
    }
    return Request(scope)


def test_locate_without_external_bucket_is_identity():
    assert storage.locate("music", "external/ytmusic/a.m4a") == ("music", "external/ytmusic/a.m4a")


def test_locate_maps_logical_bucket_to_prefix(external_s3):
    assert storage.locate("music", "external/ytmusic/a.m4a") == ("bms", "music/external/ytmusic/a.m4a")
    assert storage.locate("covers", "x.jpg") == ("bms", "covers/x.jpg")


def test_find_music_object_strips_physical_prefix(external_s3, monkeypatch):
    calls = []

    class _Client:
        def list_objects(self, bucket, prefix, recursive):
            calls.append((bucket, prefix))
            # Низкий вариант сортируется раньше оригинала.
            return iter([
                SimpleNamespace(object_name="music/external/ytmusic/vid.low.m4a"),
                SimpleNamespace(object_name="music/external/ytmusic/vid.m4a"),
            ])

    monkeypatch.setattr(storage, "is_minio_backend", lambda: True)
    monkeypatch.setattr(storage, "_get_internal_client", lambda: _Client())

    assert storage.find_music_object("external/ytmusic/vid") == "minio://music/external/ytmusic/vid.m4a"
    assert calls == [("bms", "music/external/ytmusic/vid.")]


def test_archive_original_excludes_low_variant_and_longer_ids():
    stem = "external/soundcloud/123"
    assert storage.is_archive_original(f"{stem}.m4a", stem)
    assert not storage.is_archive_original(f"{stem}.low.m4a", stem)
    assert not storage.is_archive_original("external/soundcloud/1234.m4a", stem)


def test_index_archive_paths_fills_redis(external_s3, monkeypatch):
    from app import external_archive
    from app.cache import get_cache

    names = [
        "music/external/soundcloud/123.low.m4a",
        "music/external/soundcloud/123.m4a",
        "music/external/soundcloud/1234.mp3",
        "music/external/ytmusic/idx_test01.m4a",
        "music/external/ytmusic/idx_test01.mp3",
    ]

    class _Client:
        def list_objects(self, bucket, prefix, recursive):
            assert (bucket, prefix) == ("bms", "music/external/")
            return iter(SimpleNamespace(object_name=n) for n in names)

    monkeypatch.setattr(storage, "_get_internal_client", lambda: _Client())

    assert external_archive.index_archive_paths() == 3
    assert get_cache("archive:path:soundcloud/123") == "minio://music/external/soundcloud/123.m4a"
    assert get_cache("archive:path:soundcloud/1234") == "minio://music/external/soundcloud/1234.mp3"
    assert get_cache("archive:path:ytmusic/idx_test01") == "minio://music/external/ytmusic/idx_test01.m4a"


class _Body:
    def __init__(self, data):
        self.data, self.closed = data, False

    async def iter_chunks(self, size):
        yield self.data

    def close(self):
        self.closed = True


def test_external_s3_range_skips_head(external_s3, monkeypatch):
    monkeypatch.setattr(storage, "_DISK_CACHE_MAX", 0)  # прямой путь из S3
    """До внешнего S3 HEAD перед GET — лишний круг на старте трека: размер
    берётся из Content-Range ответа на сам GET."""
    monkeypatch.setattr(storage, "S3_ENDPOINT", "https://s3.example")
    seen = []

    class _Client:
        async def head_object(self, **kw):
            raise AssertionError("HEAD не нужен")

        async def get_object(self, **kw):
            seen.append(kw)
            return {"Body": _Body(b"y" * 100), "ContentRange": "bytes 0-99/5000", "ContentType": "audio/mp4"}

    monkeypatch.setattr(storage, "_get_async_client", lambda: _Client())

    resp = asyncio.run(storage.minio_range_response_async(
        "minio://music/external/ytmusic/fast1.m4a", _request({"range": "bytes=0-99"})
    ))
    assert resp.status_code == 206
    assert resp.headers["content-range"] == "bytes 0-99/5000"
    assert resp.headers["content-length"] == "100"
    assert resp.headers["etag"] == storage.music_etag("external/ytmusic/fast1.m4a", 5000)
    assert seen[0]["Range"] == "bytes=0-99" and seen[0]["Key"] == "music/external/ytmusic/fast1.m4a"
    assert seen[0]["SSECustomerKey"] == _KEY
    # stat попал в кэш — следующий запрос знает размер без сети
    assert storage._stat_cache_get("music", "external/ytmusic/fast1.m4a")[0] == 5000


def test_external_s3_open_range_clamps_to_size(external_s3, monkeypatch):
    monkeypatch.setattr(storage, "_DISK_CACHE_MAX", 0)  # прямой путь из S3
    monkeypatch.setattr(storage, "S3_ENDPOINT", "https://s3.example")

    class _Client:
        async def get_object(self, **kw):
            assert kw["Range"] == "bytes=4900-"
            return {"Body": _Body(b"z" * 100), "ContentRange": "bytes 4900-4999/5000"}

    monkeypatch.setattr(storage, "_get_async_client", lambda: _Client())

    resp = asyncio.run(storage.minio_range_response_async(
        "minio://music/external/ytmusic/fast2.m4a", _request({"range": "bytes=4900-"})
    ))
    assert resp.headers["content-range"] == "bytes 4900-4999/5000"
    assert resp.headers["content-length"] == "100"


def test_external_s3_fast_path_304_closes_body(external_s3, monkeypatch):
    monkeypatch.setattr(storage, "_DISK_CACHE_MAX", 0)  # прямой путь из S3
    monkeypatch.setattr(storage, "S3_ENDPOINT", "https://s3.example")
    body = _Body(b"q" * 10)

    class _Client:
        async def get_object(self, **kw):
            return {"Body": body, "ContentRange": "bytes 0-9/700"}

    monkeypatch.setattr(storage, "_get_async_client", lambda: _Client())
    etag = storage.music_etag("external/ytmusic/fast3.m4a", 700)

    resp = asyncio.run(storage.minio_range_response_async(
        "minio://music/external/ytmusic/fast3.m4a",
        _request({"range": "bytes=0-9", "if-none-match": etag}),
    ))
    assert resp.status_code == 304
    assert body.closed


def test_sync_reads_and_writes_carry_sse_c(external_s3, monkeypatch, tmp_path):
    seen = {}

    class _Client:
        def fget_object(self, bucket, key, path, **kw):
            seen["get"] = (bucket, key, kw["ssec"])

        def fput_object(self, bucket, key, path, content_type, **kw):
            seen["put"] = (bucket, key, kw["sse"])

    monkeypatch.setattr(storage, "_get_internal_client", lambda: _Client())
    src = tmp_path / "a.m4a"
    src.write_bytes(b"abc")

    storage.download_object("music", "k.m4a", str(src))
    storage.upload_object("covers", "c.jpg", str(src), "image/jpeg")

    assert seen["get"][:2] == ("bms", "music/k.m4a")
    assert seen["put"][:2] == ("bms", "covers/c.jpg")
    for sse in (seen["get"][2], seen["put"][2]):
        assert sse.headers()["X-Amz-Server-Side-Encryption-Customer-Key"] == base64.b64encode(_KEY).decode()


def test_async_head_carries_sse_c_and_maps_missing(external_s3, monkeypatch):
    seen = {}

    class _Client:
        async def head_object(self, **kw):
            seen.update(kw)
            raise ClientError({"Error": {"Code": "404"}}, "HeadObject")

    monkeypatch.setattr(storage, "_get_async_client", lambda: _Client())

    with pytest.raises(storage.ObjectMissing):
        asyncio.run(storage.stat_music_object_async("minio://music/gone-head.m4a"))
    assert seen["Bucket"] == "bms" and seen["Key"] == "music/gone-head.m4a"
    assert seen["SSECustomerAlgorithm"] == "AES256" and seen["SSECustomerKey"] == _KEY


def test_missing_object_raises_before_response_headers(monkeypatch):
    """Размер из БД минует HEAD, поэтому пропажа видна только на GET — он
    должен случиться до того, как ответ ушёл клиенту."""

    class _Client:
        async def get_object(self, **kw):
            raise ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")

    monkeypatch.setattr(storage, "_get_async_client", lambda: _Client())

    with pytest.raises(storage.ObjectMissing):
        asyncio.run(storage.minio_range_response_async(
            "minio://music/gone-get.m4a", _request({"range": "bytes=0-9"}), db_size=1000,
        ))


def test_missing_object_falls_back_to_provider_and_unlinks(client, db, monkeypatch):
    from app.routers import tracks as tracks_router
    from tests.conftest import TestingSessionLocal

    monkeypatch.setattr(tracks_router, "SessionLocal", TestingSessionLocal)
    create_user(db)
    headers = auth_headers(client)
    t = Track(
        duration=100, title="yt", artist="A", source="ytmusic", external_id="vidgone",
        file_path="minio://music/external/ytmusic/vidgone.m4a", file_size=1000,
    )
    db.add(t)
    db.commit()
    db.refresh(t)

    monkeypatch.setattr(
        storage, "minio_range_response_async",
        AsyncMock(side_effect=storage.ObjectMissing(t.file_path)),
    )
    resp = client.get(f"/api/tracks/{t.id}/stream", headers=headers, follow_redirects=False)

    assert resp.status_code == 307
    assert resp.headers["location"] == "/api/ytdlp/stream/vidgone"
    # Сессию запроса стрим закрыл сразу после чтения трека — перечитываем.
    assert db.get(Track, t.id).file_path is None


def test_missing_uploaded_track_is_404(client, db, monkeypatch):
    create_user(db)
    headers = auth_headers(client)
    t = Track(duration=100, title="up", artist="A", source="local",
              file_path="minio://music/uploads/u.m4a", file_size=1000)
    db.add(t)
    db.commit()
    db.refresh(t)

    monkeypatch.setattr(
        storage, "minio_range_response_async",
        AsyncMock(side_effect=storage.ObjectMissing(t.file_path)),
    )
    resp = client.get(f"/api/tracks/{t.id}/stream", headers=headers, follow_redirects=False)
    assert resp.status_code == 404
    assert db.get(Track, t.id).file_path == "minio://music/uploads/u.m4a"


def test_stream_releases_db_connection_before_body(client, db, monkeypatch):
    """Стрим длится минуты — соединение БД не должно висеть всё это время."""
    create_user(db)
    headers = auth_headers(client)
    t = Track(duration=100, title="rel", artist="A", source="local",
              file_path="minio://music/uploads/rel.m4a", file_size=1000)
    db.add(t)
    db.commit()
    db.refresh(t)
    seen = {}

    async def fake_response(*args, **kwargs):
        seen["in_transaction"] = db.in_transaction()
        from fastapi import Response
        return Response(status_code=206)

    monkeypatch.setattr(storage, "minio_range_response_async", fake_response)
    resp = client.get(f"/api/tracks/{t.id}/stream", headers=headers)
    assert resp.status_code == 206
    assert seen["in_transaction"] is False


# ─────────────── дисковый кэш объектов внешнего S3 ───────────────


class _SlowBody:
    """Тело S3-ответа, которое отдаёт данные кусками с паузой."""

    def __init__(self, data, chunk=1000, delay=0.0, fail_after=None):
        self.data, self.chunk, self.delay, self.fail_after = data, chunk, delay, fail_after
        self.closed = False

    async def iter_chunks(self, size):
        for i in range(0, len(self.data), self.chunk):
            if self.fail_after is not None and i >= self.fail_after:
                raise ConnectionError("обрыв")
            if self.delay:
                await asyncio.sleep(self.delay)
            yield self.data[i:i + self.chunk]

    def close(self):
        self.closed = True


@pytest.fixture
def disk_cache(external_s3, monkeypatch, tmp_path):
    monkeypatch.setattr(storage, "S3_ENDPOINT", "https://s3.example")
    monkeypatch.setattr(storage, "_DISK_CACHE_DIR", str(tmp_path / "s3"))
    monkeypatch.setattr(storage, "_download_sem", None)
    monkeypatch.setattr(storage, "_downloads", {})
    monkeypatch.setattr(storage, "_HEAD_BYTES", 3000)  # голова и хвост — два запроса
    return tmp_path / "s3"


def _fake_s3(monkeypatch, data, **body_kw):
    calls = []

    class _Client:
        async def get_object(self, **kw):
            calls.append(kw)
            start, _, end = kw["Range"][len("bytes="):].partition("-")
            start = int(start)
            end = min(int(end), len(data) - 1) if end else len(data) - 1
            kw_body = dict(body_kw)
            if kw_body.get("fail_after") is not None:
                kw_body["fail_after"] = max(0, kw_body["fail_after"] - start)
            return {
                "Body": _SlowBody(data[start:end + 1], **kw_body),
                "ContentRange": f"bytes {start}-{end}/{len(data)}",
                "ContentType": "audio/mp4",
            }

    monkeypatch.setattr(storage, "_get_async_client", lambda: _Client())
    return calls


async def _collect(resp):
    return b"".join([chunk async for chunk in resp.body_iterator])


def test_disk_cache_streams_while_downloading_then_serves_from_disk(disk_cache, monkeypatch):
    data = bytes(range(256)) * 40  # 10240 байт
    calls = _fake_s3(monkeypatch, data, chunk=1000, delay=0.005)
    path = "minio://music/external/ytmusic/dc1.m4a"

    async def scenario():
        first = await storage.minio_range_response_async(path, _request({"range": "bytes=0-"}))
        assert first.status_code == 206
        assert first.headers["content-range"] == f"bytes 0-{len(data) - 1}/{len(data)}"
        assert await _collect(first) == data
        # Объект целиком лёг на диск — следующий запрос без S3.
        await asyncio.sleep(0.05)
        seek = await storage.minio_range_response_async(path, _request({"range": "bytes=5000-5999"}))
        assert seek.headers["content-range"] == f"bytes 5000-5999/{len(data)}"
        assert await _collect(seek) == data[5000:6000]
        return first, seek

    first, seek = asyncio.run(scenario())
    # голова мимо очереди и хвост — каждый байт объекта скачан один раз
    assert [c["Range"] for c in calls] == ["bytes=0-2999", f"bytes=3000-{len(data) - 1}"]
    assert all(c["SSECustomerKey"] == _KEY for c in calls)
    assert first.headers["etag"] == seek.headers["etag"] == storage.music_etag("external/ytmusic/dc1.m4a", len(data))
    assert storage.disk_cached_path("music", "external/ytmusic/dc1.m4a")


def test_disk_cache_parallel_requests_share_one_download(disk_cache, monkeypatch):
    data = b"a" * 5000 + b"b" * 5000
    calls = _fake_s3(monkeypatch, data, chunk=500, delay=0.005)
    path = "minio://music/external/ytmusic/dc2.m4a"

    async def scenario():
        r1, r2 = await asyncio.gather(
            storage.minio_range_response_async(path, _request({"range": "bytes=0-4999"})),
            storage.minio_range_response_async(path, _request({"range": "bytes=6000-"})),
        )
        return await _collect(r1), await _collect(r2)

    b1, b2 = asyncio.run(scenario())
    assert b1 == data[:5000] and b2 == data[6000:]
    assert len(calls) == 2  # одно скачивание (голова + хвост) на оба запроса


def test_disk_cache_missing_object_raises(disk_cache, monkeypatch):
    class _Client:
        async def get_object(self, **kw):
            raise ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")

    monkeypatch.setattr(storage, "_get_async_client", lambda: _Client())
    with pytest.raises(storage.ObjectMissing):
        asyncio.run(storage.minio_range_response_async(
            "minio://music/external/ytmusic/dc3.m4a", _request({"range": "bytes=0-"})
        ))


def test_disk_cache_resumes_after_dropped_connection(disk_cache, monkeypatch):
    data = bytes(range(250)) * 40  # 10000 байт, обрыв в хвосте один раз
    drops = {"left": 1}

    class _Client:
        async def get_object(self, **kw):
            start, _, end = kw["Range"][len("bytes="):].partition("-")
            start, end = int(start), int(end)
            fail = None
            if start >= 3000 and drops["left"]:
                drops["left"] -= 1
                fail = 2000
            return {
                "Body": _SlowBody(data[start:end + 1], chunk=1000, fail_after=fail),
                "ContentRange": f"bytes {start}-{end}/{len(data)}",
            }

    monkeypatch.setattr(storage, "_get_async_client", lambda: _Client())

    async def scenario():
        resp = await storage.minio_range_response_async(
            "minio://music/external/ytmusic/dc8.m4a", _request({"range": "bytes=0-"})
        )
        return await _collect(resp)

    assert asyncio.run(scenario()) == data
    assert storage.disk_cached_path("music", "external/ytmusic/dc8.m4a")


def test_disk_cache_failed_download_leaves_no_file(disk_cache, monkeypatch):
    monkeypatch.setattr(storage, "_RESUME_ATTEMPTS", 0)
    data = b"x" * 4000
    _fake_s3(monkeypatch, data, chunk=1000, fail_after=2000)
    path = "minio://music/external/ytmusic/dc4.m4a"

    async def scenario():
        resp = await storage.minio_range_response_async(path, _request({"range": "bytes=0-"}))
        with pytest.raises(IOError):
            await _collect(resp)

    asyncio.run(scenario())
    assert storage.disk_cached_path("music", "external/ytmusic/dc4.m4a") is None
    assert not [p for p in disk_cache.rglob("*") if p.is_file()]


def test_disk_cache_low_disk_falls_back_to_direct_s3(disk_cache, monkeypatch):
    import shutil

    monkeypatch.setattr(shutil, "disk_usage", lambda p: SimpleNamespace(free=0))
    seen = []

    class _Client:
        async def get_object(self, **kw):
            seen.append(kw.get("Range"))
            return {"Body": _Body(b"y" * 100), "ContentRange": "bytes 0-99/100", "ContentType": "audio/mp4"}

    monkeypatch.setattr(storage, "_get_async_client", lambda: _Client())
    resp = asyncio.run(storage.minio_range_response_async(
        "minio://music/external/ytmusic/dc5.m4a", _request({"range": "bytes=0-99"})
    ))
    assert resp.status_code == 206
    assert seen == ["bytes=0-99"]  # прямой ranged GET, без скачивания на диск


def test_disk_cache_eviction_keeps_newest(disk_cache, monkeypatch):
    import os

    monkeypatch.setattr(storage, "_DISK_CACHE_MAX", 2500)
    disk_cache.mkdir(parents=True, exist_ok=True)
    for i, age in enumerate([300, 200, 100]):
        p = disk_cache / f"f{i}.m4a"
        p.write_bytes(b"z" * 1000)
        os.utime(p, (time.time() - age, time.time() - age))
    stale = disk_cache / "old.m4a.1.ab.part"
    stale.write_bytes(b"p")
    os.utime(stale, (time.time() - 7200, time.time() - 7200))

    storage._evict_disk_cache()

    left = sorted(p.name for p in disk_cache.iterdir())
    assert left == ["f1.m4a", "f2.m4a"]


def test_upload_drops_disk_copy(disk_cache, monkeypatch, tmp_path):
    class _Client:
        def fput_object(self, *a, **kw):
            pass

    monkeypatch.setattr(storage, "_get_internal_client", lambda: _Client())
    cached = storage._disk_cache_path("music", "external/ytmusic/dc6.m4a")
    import os
    os.makedirs(os.path.dirname(cached), exist_ok=True)
    open(cached, "wb").write(b"old")
    src = tmp_path / "new.m4a"
    src.write_bytes(b"new")

    storage.upload_object("music", "external/ytmusic/dc6.m4a", str(src), "audio/mp4")
    assert storage.disk_cached_path("music", "external/ytmusic/dc6.m4a") is None


def test_disk_cache_head_does_not_wait_for_queue(disk_cache, monkeypatch):
    """Старт трека не ждёт, пока очередь докачает чужие файлы."""
    data = b"h" * 3000 + b"t" * 3000
    _fake_s3(monkeypatch, data, chunk=1000)

    async def scenario():
        storage._download_sem = asyncio.Semaphore(1)
        await storage._download_sem.acquire()  # очередь занята чужой закачкой
        resp = await asyncio.wait_for(storage.minio_range_response_async(
            "minio://music/external/ytmusic/dc7.m4a", _request({"range": "bytes=0-2999"})
        ), timeout=1)
        head = await asyncio.wait_for(_collect(resp), timeout=1)
        storage._download_sem.release()
        return head

    assert asyncio.run(scenario()) == data[:3000]
