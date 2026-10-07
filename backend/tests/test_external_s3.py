"""Внешнее S3 (bucket.ru): один физический бакет с префиксами, SSE-C на каждом
запросе и пропавший у провайдера объект, который не должен ломать трек."""

import asyncio
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
    db.refresh(t)
    assert t.file_path is None


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
    db.refresh(t)
    assert t.file_path == "minio://music/uploads/u.m4a"
