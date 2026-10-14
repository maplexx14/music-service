"""ADTS для iOS из дискового кэша S3: первый байт — по moov, не по всему файлу.

Раньше ?fmt=adts качал MP4 из bucket.ru целиком и гнал через ffmpeg, а MP3
под тем же параметром шёл мимо дискового кэша прямо в S3 на каждый Range.
"""

import asyncio
import os
import shutil
import subprocess
from collections import OrderedDict
from types import SimpleNamespace

import pytest
from starlette.requests import Request

from app import storage
from app.routers import ytdlp

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="нужен ffmpeg")

_KEY = bytes(range(32))


@pytest.fixture
def disk(monkeypatch, tmp_path):
    monkeypatch.setattr(storage, "S3_BUCKET", "bms")
    monkeypatch.setattr(storage, "_SSE_C_KEY", _KEY)
    monkeypatch.setattr(storage, "S3_ENDPOINT", "https://s3.example")
    monkeypatch.setattr(storage, "_DISK_CACHE_DIR", str(tmp_path / "s3"))
    monkeypatch.setattr(storage, "_download_sem", None)
    monkeypatch.setattr(storage, "_downloads", {})
    monkeypatch.setattr(storage, "_ADTS_INDEXES", OrderedDict())
    monkeypatch.setattr(storage, "_HEAD_BYTES", 16 * 1024)
    # Отметки закачек для соседних воркеров живут в Redis — здесь в памяти.
    marks = {}

    async def fake_get(key):
        return marks.get(key)

    async def fake_set(key, value, expire=3600):
        marks[key] = value

    monkeypatch.setattr("app.cache.get_cache_async", fake_get)
    monkeypatch.setattr("app.cache.set_cache_async", fake_set)
    return SimpleNamespace(dir=tmp_path / "s3", marks=marks, tmp=tmp_path)


class _Body:
    def __init__(self, data, chunk=4000, delay=0.0):
        self.data, self.chunk, self.delay = data, chunk, delay

    async def iter_chunks(self, size):
        for i in range(0, len(self.data), self.chunk):
            if self.delay:
                await asyncio.sleep(self.delay)
            yield self.data[i:i + self.chunk]

    def close(self):
        pass


def _fake_s3(monkeypatch, data, content_type="audio/mp4", **body_kw):
    calls = []

    class _Client:
        async def get_object(self, **kw):
            calls.append(kw["Range"])
            start, _, end = kw["Range"][len("bytes="):].partition("-")
            start = int(start)
            end = min(int(end), len(data) - 1) if end else len(data) - 1
            return {
                "Body": _Body(data[start:end + 1], **body_kw),
                "ContentRange": f"bytes {start}-{end}/{len(data)}",
                "ContentType": content_type,
            }

    monkeypatch.setattr(storage, "_get_async_client", lambda: _Client())
    return calls


def _request(range_header=None, query=b"fmt=adts"):
    headers = [(b"range", range_header.encode())] if range_header else []
    return Request({
        "type": "http", "method": "GET", "path": "/api/ytdlp/stream/X", "query_string": query,
        "headers": headers, "server": ("test", 80), "scheme": "http", "root_path": "",
    })


def _encode(path, args, seconds=4):
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
         "-ac", "2", *args, str(path)],
        check=True,
    )
    return path.read_bytes()


def _ffmpeg_adts(path):
    return subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-vn", "-c:a", "copy", "-f", "adts", "-"],
        check=True, capture_output=True,
    ).stdout


async def _collect(response):
    return b"".join([chunk async for chunk in response.body_iterator])


def test_first_adts_bytes_do_not_wait_for_the_tail(disk, monkeypatch):
    src = disk.tmp / "a.m4a"
    data = _encode(src, ["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"])
    expected = _ffmpeg_adts(src)
    assert len(data) > storage._HEAD_BYTES  # хвост — отдельный запрос в S3
    calls = _fake_s3(monkeypatch, data)
    path = "minio://music/external/ytmusic/fs1.m4a"

    async def scenario():
        storage._download_sem = asyncio.Semaphore(1)
        await storage._download_sem.acquire()  # хвост стоит в очереди закачек
        probe = await asyncio.wait_for(
            storage.minio_range_response_async(path, _request("bytes=0-1")), timeout=2
        )
        probe_body = await asyncio.wait_for(_collect(probe), timeout=2)
        early = await asyncio.wait_for(
            storage.minio_range_response_async(path, _request("bytes=0-999")), timeout=2
        )
        early_body = await asyncio.wait_for(_collect(early), timeout=2)
        storage._download_sem.release()
        full = await storage.minio_range_response_async(path, _request("bytes=0-"))
        return probe, probe_body, early_body, full, await _collect(full)

    probe, probe_body, early_body, full, full_body = asyncio.run(scenario())

    assert probe.status_code == 206 and probe.media_type == "audio/aac"
    assert probe.headers["content-range"] == f"bytes 0-1/{len(expected)}"
    assert probe_body == expected[:2]
    assert early_body == expected[:1000]
    assert full_body == expected
    assert full.headers["etag"] == probe.headers["etag"] == storage.adts_etag(
        "external/ytmusic/fs1.m4a", len(data)
    )
    # Один объект — одна закачка: голова мимо очереди и хвост.
    assert calls == [f"bytes=0-{storage._HEAD_BYTES - 1}", f"bytes={storage._HEAD_BYTES}-{len(data) - 1}"]


def test_fragmented_object_is_indexed_after_download(disk, monkeypatch):
    src = disk.tmp / "dash.m4a"
    data = _encode(src, ["-c:a", "aac", "-b:a", "128k", "-movflags", "+dash+global_sidx",
                         "-frag_duration", "1000000"])
    _fake_s3(monkeypatch, data, delay=0.001)
    path = "minio://music/external/ytmusic/frag1.m4a"

    async def scenario():
        resp = await storage.minio_range_response_async(path, _request("bytes=0-"))
        return resp, await _collect(resp)

    resp, body = asyncio.run(scenario())

    assert resp.media_type == "audio/aac"
    assert body == _ffmpeg_adts(src)


def test_unsupported_mp4_falls_back_to_ffmpeg_path(disk, monkeypatch):
    src = disk.tmp / "alac.m4a"
    data = _encode(src, ["-c:a", "alac", "-movflags", "+faststart"])
    _fake_s3(monkeypatch, data)
    fallback = []

    async def fake_adts_for_object(file_path, etag):
        fallback.append(file_path)
        return None

    async def fake_stat(file_path, db_size=None, db_content_type=None):
        return len(data), "audio/mp4", storage.music_etag("external/ytmusic/al1.m4a", len(data))

    monkeypatch.setattr("app.adts.adts_for_object", fake_adts_for_object)
    monkeypatch.setattr(storage, "stat_music_object_async", fake_stat)
    monkeypatch.setattr(storage, "iter_music_object_async", lambda *a, **kw: _gen(data))

    resp = asyncio.run(storage.minio_range_response_async(
        "minio://music/external/ytmusic/al1.m4a", _request()
    ))

    assert fallback == ["minio://music/external/ytmusic/al1.m4a"]
    assert resp.media_type == "audio/mp4"


async def _gen(data):
    yield data


def test_mp3_for_ios_is_served_from_disk_cache(disk, monkeypatch):
    data = bytes(range(256)) * 200  # 51200 байт «MP3»
    calls = _fake_s3(monkeypatch, data, content_type="audio/mpeg")
    path = "minio://music/external/ytmusic/mp1.mp3"

    async def scenario():
        first = await storage.minio_range_response_async(path, _request("bytes=0-"))
        first_body = await _collect(first)
        await asyncio.sleep(0.05)
        seek = await storage.minio_range_response_async(path, _request("bytes=1000-1999"))
        return first, first_body, await _collect(seek)

    first, first_body, seek_body = asyncio.run(scenario())

    assert first.media_type == "audio/mpeg"
    assert first_body == data and seek_body == data[1000:2000]
    assert len(calls) == 2  # голова + хвост, перемотка уже с диска
    assert storage.disk_cached_path("music", "external/ytmusic/mp1.mp3")


def test_other_worker_reads_the_growing_part_instead_of_s3(disk, monkeypatch):
    data = os.urandom(40000)

    class _NoS3:
        async def get_object(self, **kw):
            raise AssertionError("второй воркер не должен качать объект заново")

    monkeypatch.setattr(storage, "_get_async_client", lambda: _NoS3())
    bucket, key = "music", "external/ytmusic/fw1.mp3"
    final = storage._disk_cache_path(bucket, key)
    os.makedirs(os.path.dirname(final), exist_ok=True)
    part = f"{final}.999.abc.part"
    with open(part, "wb") as fh:
        fh.write(data[:10000])
    disk.marks[storage._download_mark_key(final)] = {"part": part, "size": len(data), "ct": "audio/mpeg"}

    async def writer():
        with open(part, "ab") as fh:
            for at in range(10000, len(data), 5000):
                await asyncio.sleep(0.01)
                fh.write(data[at:at + 5000])
                fh.flush()
        os.replace(part, final)

    async def scenario():
        resp = await storage.minio_range_response_async(f"minio://{bucket}/{key}", _request("bytes=0-", b""))
        body, _ = await asyncio.gather(_collect(resp), writer())
        return resp, body

    resp, body = asyncio.run(scenario())

    assert resp.headers["content-range"] == f"bytes 0-{len(data) - 1}/{len(data)}"
    assert body == data


def test_warm_downloads_object_once(disk, monkeypatch):
    data = os.urandom(30000)
    calls = _fake_s3(monkeypatch, data, content_type="audio/mpeg")
    path = "minio://music/external/ytmusic/wm1.mp3"

    async def scenario():
        await storage.warm_music_object(path)
        await storage.warm_music_object(path)  # идёт закачка — второй не нужен
        for _ in range(100):
            if storage.disk_cached_path("music", "external/ytmusic/wm1.mp3"):
                break
            await asyncio.sleep(0.01)
        await storage.warm_music_object(path)  # уже на диске

    asyncio.run(scenario())

    cached = storage.disk_cached_path("music", "external/ytmusic/wm1.mp3")
    assert cached and open(cached, "rb").read() == data
    assert len(calls) == 2


def test_prefetch_warms_the_archived_copy(disk, monkeypatch):
    warmed = []

    async def fake_warm(file_path):
        warmed.append(file_path)

    async def no_override(video_id, deezer_id=None):
        return None

    async def archived(video_id):
        return "minio://music/external/ytmusic/PREFETCH01.mp3"

    monkeypatch.setattr(ytdlp, "_ytmusic", object())
    monkeypatch.setattr("app.censorship.override_for_video", no_override)
    monkeypatch.setattr("app.censorship.schedule_suggestion", lambda video_id: None)
    monkeypatch.setattr(ytdlp, "_local_copy_path", archived)
    monkeypatch.setattr(storage, "warm_music_object", fake_warm)

    assert asyncio.run(ytdlp.prefetch_ytmusic("PREFETCH01")) == {"status": "cached"}
    assert warmed == ["minio://music/external/ytmusic/PREFETCH01.mp3"]
