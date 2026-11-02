"""Русскоязычный поток предпочитает полный SoundCloud каталогу и архиву."""

import asyncio

import pytest
from starlette.requests import Request

from app import censorship, storage
from app.models import Track
from app.routers import deezer, soundcloud, tracks, ytdlp

# conftest отключает реальный фоновый поиск; здесь проверяем сам матчер.
_find_equivalent = soundcloud.find_soundcloud_equivalent


@pytest.fixture
def cache(monkeypatch):
    store = {}
    expirations = {}

    async def get_cache(key):
        return store.get(key)

    async def set_cache(key, value, expire=None):
        store[key] = value
        expirations[key] = expire

    monkeypatch.setattr(soundcloud, "get_cache_async", get_cache)
    monkeypatch.setattr(soundcloud, "set_cache_async", set_cache)
    monkeypatch.setattr(soundcloud, "_sc_match_inflight", {})
    store["expirations"] = expirations
    return store


def _item(track_id, *, title="Трек", artist="Артист", uploader=None, policy="ALLOW"):
    return {
        "id": track_id,
        "title": title,
        "duration": 200000,
        "permalink_url": f"https://soundcloud.com/artist/{track_id}",
        "user": {"username": uploader if uploader is not None else artist},
        "publisher_metadata": {"artist": artist},
        "policy": policy,
        "media": {"transcodings": [{"format": {"protocol": "hls"}}]},
    }


def _search(monkeypatch, items):
    async def api_get(_path, _params):
        return {"collection": items}

    monkeypatch.setattr(soundcloud, "_api_get", api_get)


def _preferred(cache):
    cache["ytmusic:scmatch:VIDEOID1"] = {
        "track_id": "42", "permalink": "https://soundcloud.com/artist/42",
        "full": True, "preferred": True,
    }


def test_match_prefers_full_artist_upload_over_preview_and_reupload(monkeypatch, cache):
    _search(monkeypatch, [
        _item(1, policy="SNIP"),
        _item(2, uploader="Reuploads"),
        _item(3),
    ])

    assert asyncio.run(_find_equivalent("VIDEOID1", "Трек", "Артист", 200))[0] == "3"
    assert asyncio.run(soundcloud.soundcloud_match_for("VIDEOID1", preferred_only=True))[0] == "3"


def test_match_rejects_clean_and_derivative_versions(monkeypatch, cache):
    _search(monkeypatch, [
        _item(1, title="Трек (Clean)"),
        _item(2, title="Трек (Remix)"),
        _item(3, title="Трек (Sped Up)"),
        _item(4, artist="Другой артист"),
        _item(6, title="Трек два"),
        _item(5, uploader="Reuploads"),
    ])

    assert asyncio.run(_find_equivalent("VIDEOID1", "Трек", "Артист", 200))[0] == "5"


def test_approximate_title_does_not_override_catalog_or_archive(monkeypatch, cache):
    _search(monkeypatch, [_item(42, title="Трек два")])

    assert asyncio.run(_find_equivalent("VIDEOID1", "Трек", "Артист", 200))[0] == "42"
    assert asyncio.run(soundcloud.preferred_soundcloud_match_for("VIDEOID1")) is None


@pytest.mark.parametrize("russian", [True, False, None])
def test_latin_names_use_lyrics_for_language(monkeypatch, cache, russian):
    _search(monkeypatch, [_item(42, title="skyline ryodan", artist="shadowraze")])
    seen = []

    async def lyrics(title, artist, duration):
        seen.append((title, artist, duration))
        return russian

    monkeypatch.setattr(censorship, "russian_lyrics", lyrics)

    assert asyncio.run(_find_equivalent("VIDEOID1", "skyline ryodan", "shadowraze", 200))[0] == "42"
    assert seen == [("skyline ryodan", "shadowraze", 200)]
    assert bool(asyncio.run(soundcloud.soundcloud_match_for("VIDEOID1", preferred_only=True))) == (russian is True)
    if russian is None:
        assert cache["expirations"]["ytmusic:scmatch:VIDEOID1"] == soundcloud._MATCH_MISS_TTL


def test_legacy_match_is_reselected(monkeypatch, cache):
    cache["ytmusic:scmatch:VIDEOID1"] = {"track_id": "1", "permalink": "old", "full": False}
    _search(monkeypatch, [_item(42)])

    assert asyncio.run(_find_equivalent("VIDEOID1", "Трек", "Артист", 200))[0] == "42"


@pytest.mark.parametrize("full", [False, True])
def test_waited_match_respects_full_only(monkeypatch, cache, full):
    async def scenario():
        async def match():
            await asyncio.sleep(0)
            cache["ytmusic:scmatch:VIDEOID1"] = {
                "track_id": "42", "permalink": "p", "full": full,
            }
            return "42", "p"

        task = asyncio.create_task(match())
        soundcloud._sc_match_inflight["VIDEOID1"] = task
        return await soundcloud.await_soundcloud_match("VIDEOID1", full_only=True)

    assert asyncio.run(scenario()) == (("42", "p") if full else None)


def test_preference_waits_for_first_flow_track(cache):
    async def scenario():
        async def match():
            await asyncio.sleep(0)
            _preferred(cache)

        soundcloud._sc_match_inflight["VIDEOID1"] = asyncio.create_task(match())
        return await soundcloud.preferred_soundcloud_match_for("VIDEOID1")

    assert asyncio.run(scenario())[0] == "42"


def test_preview_never_becomes_preferred(cache):
    _preferred(cache)
    cache["ytmusic:scmatch:VIDEOID1"]["full"] = False

    assert asyncio.run(soundcloud.preferred_soundcloud_match_for("VIDEOID1")) is None


def test_match_timeout_does_not_cancel_shared_search(cache):
    async def scenario():
        gate = asyncio.Event()

        async def match():
            await gate.wait()
            _preferred(cache)

        task = asyncio.create_task(match())
        soundcloud._sc_match_inflight["VIDEOID1"] = task
        assert await soundcloud.await_soundcloud_match("VIDEOID1", timeout=0.01) is None
        assert not task.cancelled()
        gate.set()
        await task
        return await soundcloud.preferred_soundcloud_match_for("VIDEOID1")

    assert asyncio.run(scenario())[0] == "42"


def _request(query=b""):
    return Request({
        "type": "http", "method": "GET", "path": "/", "headers": [],
        "query_string": query,
    })


@pytest.fixture
def stream_setup(monkeypatch):
    monkeypatch.setattr(ytdlp, "_ytmusic", object())
    monkeypatch.setattr(censorship, "schedule_suggestion", lambda _vid: None)

    async def no_override(_video_id):
        return None

    monkeypatch.setattr(censorship, "override_for_video", no_override)


def test_preferred_match_beats_local_and_deezer(monkeypatch, cache, stream_setup):
    _preferred(cache)

    async def must_not_run(*_a, **_kw):
        raise AssertionError("SoundCloud должен играть раньше копии и Deezer")

    monkeypatch.setattr(ytdlp, "_local_copy_path", must_not_run)
    monkeypatch.setattr(deezer, "stream_for_ytmusic", must_not_run)
    response = asyncio.run(ytdlp.stream_ytmusic("VIDEOID1", _request(b"fmt=adts")))

    assert response.status_code == 307
    assert response.headers["location"].endswith("?vid=VIDEOID1&original=1&fmt=adts")


@pytest.mark.parametrize("fallback", [False, True])
def test_local_copy_still_plays_without_preference_or_after_sc_failure(monkeypatch, cache, stream_setup, fallback):
    if fallback:
        _preferred(cache)

    async def local(_video_id):
        return "/cache/VIDEOID1.mp3"

    async def cached_audio(*_a, **_kw):
        return "local"

    monkeypatch.setattr(ytdlp, "_local_copy_path", local)
    monkeypatch.setattr(ytdlp, "stream_cached_audio", cached_audio)

    assert asyncio.run(ytdlp.stream_ytmusic("VIDEOID1", _request(b"scfallback=1" if fallback else b""))) == "local"


def test_preferred_prefetch_uses_soundcloud_even_with_local_copy(monkeypatch, cache, stream_setup):
    _preferred(cache)
    seen = []

    async def prefetch(token, original_vid=""):
        assert original_vid == "VIDEOID1"
        seen.append(soundcloud._decode_token(token))
        return {"status": "downloading"}

    async def must_not_run(*_a, **_kw):
        raise AssertionError("архив каталога не прогреваем вместо SoundCloud")

    monkeypatch.setattr(soundcloud, "prefetch_soundcloud", prefetch)
    monkeypatch.setattr(ytdlp, "_local_copy_path", must_not_run)

    assert asyncio.run(ytdlp._prepare_prefetch_ytmusic("VIDEOID1")) == {"status": "downloading"}
    assert seen == [("42", "https://soundcloud.com/artist/42")]


def test_ready_follows_preferred_soundcloud_not_catalog_copy(monkeypatch, cache, stream_setup):
    _preferred(cache)

    async def sc_ready(_token, original_vid=""):
        assert original_vid == "VIDEOID1"
        return {"ready": False}

    async def local_ready(*_a, **_kw):
        return True

    monkeypatch.setattr(soundcloud, "prefetch_soundcloud_ready", sc_ready)
    monkeypatch.setattr(ytdlp, "prefetch_is_ready", local_ready)

    assert asyncio.run(ytdlp.prefetch_ytmusic_ready("VIDEOID1")) == {"ready": False}


def test_flow_track_from_library_prefers_sc_over_minio(monkeypatch, cache, stream_setup):
    _preferred(cache)
    track = Track(id=1, title="Трек", artist="Артист", duration=200, source="ytmusic",
                  external_id="VIDEOID1", file_path="minio://music/external/ytmusic/VIDEOID1.mp3")
    monkeypatch.setattr(tracks, "_load_track_released", lambda _db, _id: track)

    async def must_not_run(*_a, **_kw):
        raise AssertionError("цензурный архив не должен перекрывать SoundCloud")

    monkeypatch.setattr(storage, "minio_range_response_async", must_not_run)

    response = asyncio.run(tracks.stream_track(1, _request(), db=None))
    assert response.status_code == 307
    assert response.headers["location"].endswith("?vid=VIDEOID1&original=1")
