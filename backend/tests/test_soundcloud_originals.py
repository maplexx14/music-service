"""После новой полной загрузки SC архив выигрывает без доверия старым копиям."""

import asyncio
from pathlib import Path

import pytest
from starlette.requests import Request

from app import censorship, external_archive, soundcloud_originals as originals, storage
from app.models import Track
from app.routers import soundcloud, tracks, ytdlp


@pytest.fixture
def archive_env(monkeypatch):
    cache, objects = {}, {}

    async def get_cache(key):
        return cache.get(key)

    async def set_cache(key, value, expire=None):
        cache[key] = value

    def find_object(prefix):
        return objects.get(prefix)

    async def no_override(_vid):
        return None

    for module in (originals, external_archive, ytdlp, soundcloud):
        monkeypatch.setattr(module, "get_cache_async", get_cache)
        monkeypatch.setattr(module, "set_cache_async", set_cache)
    monkeypatch.setattr(storage, "is_minio_backend", lambda: True)
    monkeypatch.setattr(storage, "find_music_object", find_object)
    monkeypatch.setattr(censorship, "override_for_video", no_override)
    monkeypatch.setattr(censorship, "schedule_suggestion", lambda _vid: None)
    monkeypatch.setattr(ytdlp, "_ytmusic", object())
    monkeypatch.setattr(originals, "_inflight", set())
    monkeypatch.setattr(external_archive, "_lazy_sem", asyncio.Semaphore(1))
    monkeypatch.setattr(external_archive, "_MAX_RETRIES", 0)
    return cache, objects


def _request(query=b""):
    return Request({"type": "http", "method": "GET", "path": "/", "headers": [],
                    "query_string": query})


def _match(cache):
    cache["ytmusic:scmatch:VIDEOID1"] = {
        "track_id": "42", "permalink": "https://soundcloud.com/artist/song",
        "preferred": True, "full": True,
    }


def test_first_sc_stream_bypasses_old_soundcloud_and_catalog_archives(monkeypatch, archive_env):
    cache, objects = archive_env
    _match(cache)
    objects.update({"external/ytmusic/VIDEOID1": "old-youtube",
                    "external/soundcloud/42": "old-soundcloud"})
    seen = []

    async def stream(request, cache_id, resolver, archive_key=None):
        seen.append((cache_id, archive_key))
        return "fresh-soundcloud"

    async def no_archive(*_a):
        pass

    monkeypatch.setattr(soundcloud, "stream_cached_audio", stream)
    monkeypatch.setattr(originals, "archive", no_archive)
    token = soundcloud._encode_token("42", "https://soundcloud.com/artist/song")

    assert asyncio.run(soundcloud.stream_soundcloud(token, _request(), vid="VIDEOID1", original=True)) == "fresh-soundcloud"
    assert seen == [(originals.cache_id("VIDEOID1", "42"), originals.archive_key("VIDEOID1"))]


def test_arbitrary_sc_track_cannot_publish_catalog_archive(monkeypatch, archive_env):
    cache, _objects = archive_env
    _match(cache)
    seen = []

    async def stream(_request, cache_id, _resolver, archive_key=None):
        seen.append(archive_key)
        return "ordinary-sc"

    async def must_not_archive(*_a):
        raise AssertionError("чужой SC-трек не может стать архивом VIDEOID1")

    async def no_archive(*_a):
        pass

    monkeypatch.setattr(soundcloud, "stream_cached_audio", stream)
    monkeypatch.setattr(originals, "archive", must_not_archive)
    monkeypatch.setattr(external_archive, "schedule_archive_external", no_archive)
    token = soundcloud._encode_token("99", "https://soundcloud.com/other/song")

    assert asyncio.run(soundcloud.stream_soundcloud(token, _request(), vid="VIDEOID1", original=True)) == "ordinary-sc"
    assert seen == ["soundcloud/99"]


@pytest.mark.parametrize("upload_succeeds", [True, False])
def test_download_publishes_new_archive_only_after_successful_upload(monkeypatch, archive_env, tmp_path, upload_succeeds):
    cache, objects = archive_env
    old = "minio://music/external/ytmusic/VIDEOID1.m4a"
    objects["external/ytmusic/VIDEOID1"] = old
    downloads = []
    new_cache_key = f"archive:path:{originals.archive_key('VIDEOID1')}"

    async def resolve(track_id, permalink, force=False):
        assert track_id == "42"
        return "https://sc-cdn.example/audio", ".mp3", 4, True

    async def download(url, suffix, client, resume_path=None):
        assert not cache.get(new_cache_key)
        downloads.append(url)
        path = tmp_path / f"fresh{suffix}"
        path.write_bytes(b"full fresh SoundCloud audio")
        return str(path), path.stat().st_size

    def upload(path, key, content_type):
        assert not cache.get(new_cache_key)
        assert key == f"external/{originals.archive_key('VIDEOID1')}.mp3"
        assert Path(path).read_bytes() == b"full fresh SoundCloud audio"
        if not upload_succeeds:
            raise RuntimeError("upload refused")
        return f"minio://music/{key}", 4

    monkeypatch.setattr(soundcloud, "_resolve_cached", resolve)
    monkeypatch.setattr(external_archive, "_download_to_temp", download)
    monkeypatch.setattr(external_archive, "transcode_to_aac", lambda path: path)
    monkeypatch.setattr(external_archive, "analyze_file", lambda _path: None)
    monkeypatch.setattr(storage, "ensure_buckets", lambda: None)
    monkeypatch.setattr(storage, "upload_music_file", upload)
    monkeypatch.setattr(ytdlp, "_cached_file", lambda _id: None)

    asyncio.run(originals.archive("VIDEOID1", "42", "https://soundcloud.com/artist/song"))

    assert downloads == ["https://sc-cdn.example/audio"]
    assert bool(cache.get(new_cache_key)) is upload_succeeds
    assert objects["external/ytmusic/VIDEOID1"] == old


def test_old_disk_copy_cannot_be_promoted(monkeypatch, archive_env):
    _cache, _objects = archive_env
    checked = []

    def local(cache_id):
        checked.append(cache_id)
        return "/cache/old-sc42.mp3" if cache_id == "sc42" else None

    async def fresh_download(*_a, **kwargs):
        assert kwargs["archive_key"] == originals.archive_key("VIDEOID1")
        return external_archive.ArchiveResult.UNAVAILABLE, None

    async def must_not_adopt(*_a, **_kw):
        raise AssertionError("старый кэш не получает отметку нового архива")

    monkeypatch.setattr(ytdlp, "_cached_file", local)
    monkeypatch.setattr(external_archive, "_archive_external_core", fresh_download)
    monkeypatch.setattr(external_archive, "adopt_local_file", must_not_adopt)

    asyncio.run(originals.archive("VIDEOID1", "42", "p"))
    assert checked == [originals.cache_id("VIDEOID1", "42")]


def test_replay_uses_durable_new_archive_without_search_cache(monkeypatch, archive_env):
    cache, objects = archive_env
    path = "minio://music/external/soundcloud-originals-v1/VIDEOID1.mp3"
    objects[f"external/{originals.archive_key('VIDEOID1')}"] = path
    seen = []

    async def archive_response(file_path, request, **_kw):
        seen.append(file_path)
        return "archive"

    async def must_not_search(*_a):
        raise AssertionError("новая копия играет без SC-матча и старого архива")

    monkeypatch.setattr(storage, "minio_range_response_async", archive_response)
    monkeypatch.setattr(soundcloud, "preferred_soundcloud_match_for", must_not_search)
    monkeypatch.setattr(ytdlp, "_local_copy_path", must_not_search)

    assert asyncio.run(ytdlp.stream_ytmusic("VIDEOID1", _request())) == "archive"
    cache.clear()  # Перезапуск Redis не заставляет снова искать SoundCloud.
    assert asyncio.run(ytdlp.stream_ytmusic("VIDEOID1", _request())) == "archive"
    assert seen == [path, path]


def test_library_replay_uses_new_archive_over_old_file(monkeypatch, archive_env):
    _cache, objects = archive_env
    path = "minio://music/external/soundcloud-originals-v1/VIDEOID1.m4a"
    objects[f"external/{originals.archive_key('VIDEOID1')}"] = path
    track = Track(id=1, title="Трек", artist="Артист", duration=200, source="ytmusic",
                  external_id="VIDEOID1", file_path="minio://music/external/ytmusic/VIDEOID1.m4a")
    monkeypatch.setattr(tracks, "_load_track_released", lambda _db, _id: track)

    async def archive_response(file_path, request, **_kw):
        assert file_path == path
        return "archive"

    monkeypatch.setattr(storage, "minio_range_response_async", archive_response)
    assert asyncio.run(tracks.stream_track(1, _request(), db=None)) == "archive"


def test_prefetch_and_ready_use_new_archive_without_soundcloud(monkeypatch, archive_env):
    _cache, objects = archive_env
    path = "minio://music/external/soundcloud-originals-v1/VIDEOID1.m4a"
    objects[f"external/{originals.archive_key('VIDEOID1')}"] = path
    warmed = []

    async def warm(file_path):
        warmed.append(file_path)

    async def must_not_search(*_a):
        raise AssertionError("готовый архив не требует прогрева SoundCloud")

    monkeypatch.setattr(storage, "warm_music_object", warm)
    monkeypatch.setattr(soundcloud, "preferred_soundcloud_match_for", must_not_search)

    assert asyncio.run(ytdlp.prefetch_ytmusic("VIDEOID1")) == {"status": "cached"}
    assert asyncio.run(ytdlp.prefetch_ytmusic_ready("VIDEOID1")) == {"ready": True}
    assert warmed == [path]


def test_missing_new_archive_falls_back_to_sc_and_clears_path(monkeypatch, archive_env):
    cache, objects = archive_env
    objects[f"external/{originals.archive_key('VIDEOID1')}"] = "missing-new-object"
    _match(cache)

    async def missing(*_a, **_kw):
        raise storage.ObjectMissing("gone")

    monkeypatch.setattr(storage, "minio_range_response_async", missing)
    response = asyncio.run(ytdlp.stream_ytmusic("VIDEOID1", _request()))

    assert response.headers["location"].endswith("?vid=VIDEOID1&original=1")
    assert cache[f"archive:path:{originals.archive_key('VIDEOID1')}"] == ""


def test_hls_original_build_uses_new_cache_identity(monkeypatch, archive_env):
    _cache, _objects = archive_env
    fresh_id = originals.cache_id("VIDEOID1", "42")
    checked, remuxed = [], []

    def local(cache_id):
        checked.append(cache_id)
        return "/cache/old-sc42.m4a" if cache_id == "sc42" else None

    async def hls(_track_id):
        return "https://sc-cdn.example/list.m3u8", ".m4a"

    async def remux(cache_id, url, ext):
        remuxed.append(cache_id)
        return f"/cache/{cache_id}{ext}"

    monkeypatch.setattr(soundcloud, "_cached_file", local)
    monkeypatch.setattr(soundcloud, "resolve_hls_via_api", hls)
    monkeypatch.setattr(soundcloud, "_remux_hls_to_cache", remux)
    monkeypatch.setattr(soundcloud, "_hls_tasks", {})

    assert asyncio.run(soundcloud._ensure_hls_cached("42", cache_id=fresh_id)) == f"/cache/{fresh_id}.m4a"
    assert remuxed == [fresh_id]
    assert "sc42" not in checked


def test_hls_download_is_archived_under_new_catalog_key(monkeypatch, archive_env, tmp_path):
    cache, _objects = archive_env
    fresh = tmp_path / "fresh.m4a"
    fresh.write_bytes(b"fresh HLS audio")
    seen = []

    async def no_progressive(*_a, **_kw):
        return external_archive.ArchiveResult.TRANSIENT, None

    async def hls(track_id, *, cache_id):
        assert cache_id == originals.cache_id("VIDEOID1", "42")
        return str(fresh)

    async def adopt(source, track_id, path, *, archive_key):
        seen.append((source, track_id, path, archive_key))
        cache[f"archive:path:{archive_key}"] = "minio://music/new-hls.m4a"
        return cache[f"archive:path:{archive_key}"]

    monkeypatch.setattr(ytdlp, "_cached_file", lambda _id: None)
    monkeypatch.setattr(external_archive, "_archive_external_core", no_progressive)
    monkeypatch.setattr(soundcloud, "_ensure_hls_cached", hls)
    monkeypatch.setattr(external_archive, "adopt_local_file", adopt)

    asyncio.run(originals.archive("VIDEOID1", "42", "p"))
    assert seen == [("soundcloud", "42", str(fresh), originals.archive_key("VIDEOID1"))]
    assert asyncio.run(originals.archived_path("VIDEOID1")) == "minio://music/new-hls.m4a"


def test_new_archive_skips_background_soundcloud_matching(monkeypatch, archive_env):
    _cache, objects = archive_env
    objects[f"external/{originals.archive_key('VIDEOID1')}"] = "minio://music/new.mp3"

    async def must_not_search(*_a):
        raise AssertionError("новый архив избавляет и от фонового поиска SC-матча")

    monkeypatch.setattr(soundcloud, "find_soundcloud_equivalent", must_not_search)
    assert asyncio.run(soundcloud._sc_match_job("VIDEOID1", "Трек", "Артист", 200)) is None
