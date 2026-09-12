"""MinIO-стрим: stat-кэш + условные запросы (ETag/304/If-Range) + Range.

iOS Safari тянет один трек десятками мелких Range-запросов и агрессивно
ревалидирует кэш — эти тесты фиксируют, что путь не деградирует обратно:
HEAD в MinIO кэшируется, совпавший If-None-Match даёт 304 без тела,
несовпавший If-Range отдаёт 200 целиком, а не срезанный чужой кусок.
"""

import asyncio
from unittest.mock import AsyncMock

from fastapi import Request

from app import storage


def _request(headers=None):
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/",
        "query_string": b"",
        "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()],
    }
    return Request(scope)


def _headers(resp):
    return {k.lower(): v for k, v in resp.headers.items()}


def test_range_request_206_with_headers(monkeypatch):
    monkeypatch.setattr(
        storage, "stat_music_object_async",
        AsyncMock(return_value=(1000, "audio/mpeg", '"etag1"')),
    )
    async def fake_iter(file_path, offset=None, length=None, chunk_size=None):
        yield b"x" * 10
    monkeypatch.setattr(storage, "iter_music_object_async", fake_iter)

    resp = asyncio.run(storage.minio_range_response_async(
        "minio://music/external/x.m4a", _request({"range": "bytes=0-99"})
    ))
    assert resp.status_code == 206
    headers = _headers(resp)
    assert headers["content-range"] == "bytes 0-99/1000"
    assert headers["content-length"] == "100"
    assert headers["etag"] == '"etag1"'
    assert "max-age=604800" in headers["cache-control"]
    assert headers["accept-ranges"] == "bytes"


def test_if_none_match_304_no_body(monkeypatch):
    monkeypatch.setattr(
        storage, "stat_music_object_async",
        AsyncMock(return_value=(1000, "audio/mpeg", '"etag1"')),
    )
    get_object = AsyncMock()
    monkeypatch.setattr(storage, "iter_music_object_async", get_object)

    resp = asyncio.run(storage.minio_range_response_async(
        "minio://music/external/x.m4a",
        _request({"if-none-match": '"etag1"', "range": "bytes=0-99"}),
    ))
    assert resp.status_code == 304
    assert _headers(resp)["etag"] == '"etag1"'


def test_if_range_mismatch_serves_full(monkeypatch):
    """Кэш браузера от старой версии объекта — Range не срезаем, отдаём 200."""
    monkeypatch.setattr(
        storage, "stat_music_object_async",
        AsyncMock(return_value=(1000, "audio/mpeg", '"new"')),
    )
    async def fake_iter(file_path, offset=None, length=None, chunk_size=None):
        yield b"x"
    monkeypatch.setattr(storage, "iter_music_object_async", fake_iter)

    resp = asyncio.run(storage.minio_range_response_async(
        "minio://music/external/x.m4a",
        _request({"range": "bytes=0-99", "if-range": '"old"'}),
    ))
    assert resp.status_code == 200
    assert _headers(resp)["content-length"] == "1000"


def test_suffix_range_and_invalid(monkeypatch):
    monkeypatch.setattr(
        storage, "stat_music_object_async",
        AsyncMock(return_value=(1000, "audio/mpeg", '"etag1"')),
    )
    async def fake_iter(file_path, offset=None, length=None, chunk_size=None):
        yield b"x"
    monkeypatch.setattr(storage, "iter_music_object_async", fake_iter)

    resp = asyncio.run(storage.minio_range_response_async(
        "minio://music/x", _request({"range": "bytes=-100"})
    ))
    assert resp.status_code == 206
    assert _headers(resp)["content-range"] == "bytes 900-999/1000"

    resp = asyncio.run(storage.minio_range_response_async(
        "minio://music/x", _request({"range": "bytes=9999-"})
    ))
    assert resp.status_code == 416
    assert _headers(resp)["content-range"] == "bytes */1000"


def test_stat_cache_roundtrip_and_invalidation(monkeypatch):
    calls = {"head": 0}

    class _FakeClient:
        async def head_object(self, **kwargs):
            calls["head"] += 1
            return {"ContentLength": 100, "ContentType": "audio/mpeg", "ETag": '"e"'}

    monkeypatch.setattr(storage, "_get_async_client", lambda: _FakeClient())
    storage._stat_cache.clear()

    asyncio.run(storage.stat_music_object_async("minio://music/a"))
    asyncio.run(storage.stat_music_object_async("minio://music/a"))
    assert calls["head"] == 1  # второй вызов из кэша, без HEAD в MinIO

    storage._stat_cache_invalidate("music", "a")
    asyncio.run(storage.stat_music_object_async("minio://music/a"))
    assert calls["head"] == 2
    storage._stat_cache.clear()


def test_if_none_match_list_and_star():
    req = _request({"if-none-match": '"other", "etag1"'})
    assert storage.if_none_match_matches(req, '"etag1"')
    assert not storage.if_none_match_matches(req, '"etag2"')
    req = _request({"if-none-match": "*"})
    assert storage.if_none_match_matches(req, '"anything"')
    assert not storage.if_none_match_matches(_request(), '"etag1"')


def test_parse_range_header():
    assert storage.parse_range_header("bytes=0-99", 1000) == (0, 99)
    assert storage.parse_range_header("bytes=500-", 1000) == (500, 999)
    assert storage.parse_range_header("bytes=-100", 1000) == (900, 999)
    # границы end за пределами файла срезаются
    assert storage.parse_range_header("bytes=990-5000", 1000) == (990, 999)
    assert storage.parse_range_header("bytes=999-999", 1000) == (999, 999)
    # некорректные → None → 416
    assert storage.parse_range_header("bytes=1000-", 1000) is None
    assert storage.parse_range_header("bytes=5-2", 1000) is None
    assert storage.parse_range_header("bytes=0-1,5-9", 1000) is None
    assert storage.parse_range_header("items=0-1", 1000) is None
    assert storage.parse_range_header("bytes=-0", 1000) is None
