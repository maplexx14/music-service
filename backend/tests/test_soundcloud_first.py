"""Полноформатный SoundCloud-матч играет раньше YouTube.

Каждый резолв в YouTube с нашего IP приближает bot-check, поэтому ytmusic-трек,
который SoundCloud отдаёт целиком, уходит 307 туда, не трогая YouTube. Превью
(Go+, policy=SNIP) и DRM вперёд не ставятся — они остаются запасом на отказ
YouTube. Отказ самого SoundCloud возвращает браузер на YouTube (vid).
"""

import asyncio

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app.routers import soundcloud, ytdlp


def _item(policy="ALLOW", access="playable", protocols=("progressive",), snipped=False):
    return {
        "policy": policy,
        "access": access,
        "media": {
            "transcodings": [
                {"format": {"protocol": p}, "snipped": snipped} for p in protocols
            ]
        },
    }


def test_full_stream_accepts_plain_progressive_and_hls():
    assert soundcloud._is_full_stream(_item())
    assert soundcloud._is_full_stream(_item(protocols=("hls",)))
    assert soundcloud._is_full_stream(_item(policy="MONETIZE", protocols=("hls", "progressive")))


@pytest.mark.parametrize(
    "item",
    [
        _item(policy="SNIP"),
        _item(access="preview"),
        _item(access="blocked"),
        _item(snipped=True),
        # DRM: зашифрованный HLS, прогрессивный пресет рядом — мёртвый.
        _item(policy="MONETIZE", protocols=("progressive", "ctr-encrypted-hls")),
        _item(protocols=()),
    ],
)
def test_preview_drm_and_blocked_are_not_full(item):
    assert not soundcloud._is_full_stream(item)


def _fake_cache(monkeypatch, value):
    async def get_cache(_key):
        return value

    monkeypatch.setattr(soundcloud, "get_cache_async", get_cache)


def test_full_only_skips_preview_and_legacy_matches(monkeypatch):
    _fake_cache(monkeypatch, {"track_id": "42", "permalink": "https://soundcloud.com/a/b"})
    # Запись старого формата (без флага full) — только запасной матч.
    assert asyncio.run(soundcloud.soundcloud_match_for("v")) == ("42", "https://soundcloud.com/a/b")
    assert asyncio.run(soundcloud.soundcloud_match_for("v", full_only=True)) is None

    _fake_cache(monkeypatch, {"track_id": "42", "permalink": "p", "full": True})
    assert asyncio.run(soundcloud.soundcloud_match_for("v", full_only=True)) == ("42", "p")


def _no_local_copy(monkeypatch, has_copy=False):
    async def has_local_copy(_video_id):
        return has_copy

    monkeypatch.setattr(ytdlp, "_has_local_copy", has_local_copy)


def test_full_match_redirects_to_soundcloud_with_way_back(monkeypatch):
    _no_local_copy(monkeypatch)
    seen = {}

    async def match(video_id, full_only=False):
        seen["full_only"] = full_only
        return "42", "https://soundcloud.com/a/b"

    monkeypatch.setattr(soundcloud, "await_soundcloud_match", match)

    redirect = asyncio.run(ytdlp._soundcloud_first_redirect("VIDEOID1"))

    assert seen["full_only"] is True
    assert redirect is not None and redirect.status_code == 307
    token = soundcloud._encode_token("42", "https://soundcloud.com/a/b")
    assert redirect.headers["location"] == f"/api/soundcloud/stream/{token}?vid=VIDEOID1"


def test_local_copy_wins_over_soundcloud(monkeypatch):
    """Своя копия (диск/MinIO) — тот самый ролик и без сети: SoundCloud не нужен."""
    _no_local_copy(monkeypatch, has_copy=True)

    async def must_not_run(*_a, **_kw):
        raise AssertionError("match lookup is pointless with a local copy")

    monkeypatch.setattr(soundcloud, "await_soundcloud_match", must_not_run)

    assert asyncio.run(ytdlp._soundcloud_first_redirect("VIDEOID1")) is None


def test_no_full_match_stays_on_youtube(monkeypatch):
    _no_local_copy(monkeypatch)

    async def no_match(video_id, full_only=False):
        return None

    monkeypatch.setattr(soundcloud, "await_soundcloud_match", no_match)

    assert asyncio.run(ytdlp._soundcloud_first_redirect("VIDEOID1")) is None


def _request(query: bytes = b"") -> Request:
    return Request({"type": "http", "method": "GET", "path": "/", "headers": [], "query_string": query})


@pytest.mark.parametrize("status", [404, 503])
def test_soundcloud_failure_returns_to_original_youtube_track(monkeypatch, status):
    """SoundCloud не смог (DRM-404, 503 без HLS) — играем исходный ytmusic-трек,
    а не ищем «похожий» в YouTube. scfallback=1 не пустит обратно на SoundCloud."""

    async def failing_stream(*_a, **_kw):
        raise HTTPException(status_code=status)

    async def no_hls(*_a, **_kw):
        return None

    async def no_archive(*_a, **_kw):
        return None

    async def must_not_search(*_a, **_kw):
        raise AssertionError("original video id is known, no search needed")

    from app import external_archive

    monkeypatch.setattr(soundcloud, "stream_cached_audio", failing_stream)
    monkeypatch.setattr(soundcloud, "_stream_via_hls", no_hls)
    monkeypatch.setattr(soundcloud, "find_ytmusic_equivalent", must_not_search)
    monkeypatch.setattr(external_archive, "schedule_archive_external", no_archive)

    token = soundcloud._encode_token("42", "https://soundcloud.com/a/b")
    response = asyncio.run(
        soundcloud.stream_soundcloud(token, _request(b"vid=VIDEOID1"), vid="VIDEOID1")
    )

    assert response.status_code == 307
    assert response.headers["location"] == "/api/ytdlp/stream/VIDEOID1?scfallback=1"


def test_search_hides_previews_and_drm(monkeypatch):
    def api_item(track_id, **kw):
        item = _item(**kw)
        item.update({
            "id": track_id,
            "permalink_url": f"https://soundcloud.com/a/{track_id}",
            "title": f"Song {track_id}",
            "user": {"username": "Artist"},
            "duration": 130000,
        })
        return item

    async def api_get(_path, _params):
        return {"collection": [
            api_item(1),
            api_item(2, policy="SNIP"),
            api_item(3, policy="MONETIZE", protocols=("ctr-encrypted-hls",)),
        ]}

    monkeypatch.setattr(soundcloud, "_api_get", api_get)
    request = Request({
        "type": "http", "method": "GET", "path": "/", "query_string": b"",
        "headers": [], "server": ("test", 80), "scheme": "http", "root_path": "",
    })

    results = asyncio.run(soundcloud._search_api(request, "q", 10))

    assert [t.external_id for t in results] == ["1"]


def test_prefetch_assembles_hls_when_no_progressive_stream(monkeypatch):
    """Прод 2026-10-22: у HLS-only трека (DJ Anemia — archangel) прогрев
    отвечал ready=false до упора попыток, хотя /stream его играл через HLS."""
    TransientResolveError = ytdlp.TransientResolveError

    async def no_progressive(track_id, permalink, force=False):
        raise TransientResolveError(track_id)

    assembled = []

    async def ensure_hls(track_id):
        assembled.append(track_id)
        return f"/cache/sc{track_id}.m4a"

    monkeypatch.setattr(soundcloud, "_resolve_cached", no_progressive)
    monkeypatch.setattr(soundcloud, "_ensure_hls_cached", ensure_hls)

    with pytest.raises(TransientResolveError):
        asyncio.run(soundcloud._resolve_for_prefetch("42", "https://soundcloud.com/a/b"))
    assert assembled == ["42"]


def test_prefetch_does_not_touch_hls_for_unavailable_track(monkeypatch):
    TrackUnavailable = ytdlp.TrackUnavailable

    async def gone(track_id, permalink, force=False):
        raise TrackUnavailable(track_id)

    async def must_not_assemble(track_id):
        raise AssertionError("HLS is not an option for a removed track")

    monkeypatch.setattr(soundcloud, "_resolve_cached", gone)
    monkeypatch.setattr(soundcloud, "_ensure_hls_cached", must_not_assemble)

    with pytest.raises(TrackUnavailable):
        asyncio.run(soundcloud._resolve_for_prefetch("42", "https://soundcloud.com/a/b"))


def test_concurrent_hls_remuxes_do_not_share_temp_file(tmp_path, monkeypatch):
    """Прод: прогрев и /stream одного трека попадают в РАЗНЫЕ воркеры
    gunicorn (GUNICORN_WORKERS=4), а asyncio.Lock живёт в одном процессе.
    С общим именем ``*.part`` второй ffmpeg продолжал писать в уже
    перемещённый на место готовый кэш-файл — тот оставался битым навсегда
    (_cached_file отдаёт его без проверок), и трек не играл уже никогда."""
    from app import transcode

    monkeypatch.setattr(soundcloud, "CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(ytdlp, "CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(soundcloud, "_enforce_cache_limit", lambda: None)

    outputs = []

    def fake_remux(_url, output_path, container="mp4", max_bytes=0):
        outputs.append(output_path)
        with open(output_path, "wb") as fh:
            fh.write(b"\x00" * 4096)
        return True

    monkeypatch.setattr(transcode, "remux_hls_to_file", fake_remux)

    async def both():
        return await asyncio.gather(
            soundcloud._remux_hls_to_cache("sc42", "https://cdn/a.m3u8", ".m4a"),
            soundcloud._remux_hls_to_cache("sc42", "https://cdn/a.m3u8", ".m4a"),
        )

    first, second = asyncio.run(both())

    assert outputs[0] != outputs[1]
    final = tmp_path / "sc42.m4a"
    assert first == second == str(final)
    assert final.stat().st_size == 4096
    assert not list(tmp_path.glob("*.part"))


def test_hls_assembly_survives_client_disconnect(monkeypatch):
    """Вотчдог плеера рвёт долгий старт через audio.load(). Отмена ожидающего
    не должна отменять общую сборку: иначе ремукс не доходит до установки
    файла, и каждая попытка начинается с нуля."""
    soundcloud._hls_tasks.clear()
    monkeypatch.setattr(soundcloud, "_cached_file", lambda _id: None)

    async def main():
        started = asyncio.Event()
        release = asyncio.Event()
        calls = []

        async def assemble(track_id):
            calls.append(track_id)
            started.set()
            await release.wait()
            return "/cache/sc42.m4a"

        monkeypatch.setattr(soundcloud, "_assemble_hls", assemble)

        first = asyncio.ensure_future(soundcloud._ensure_hls_cached("42"))
        await started.wait()
        second = asyncio.ensure_future(soundcloud._ensure_hls_cached("42"))
        await asyncio.sleep(0)

        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first

        release.set()
        assert await second == "/cache/sc42.m4a"
        # Done-callback задачи выполняется отдельным тиком цикла.
        for _ in range(3):
            await asyncio.sleep(0)
        assert calls == ["42"]
        assert soundcloud._hls_tasks == {}

    try:
        asyncio.run(main())
    finally:
        soundcloud._hls_tasks.clear()


def test_assemble_hls_swallows_resolve_errors(monkeypatch):
    """Сбой api-v2 не должен превращаться в 500: вызывающий отдаёт 503."""
    monkeypatch.setattr(soundcloud, "_cached_file", lambda _id: None)

    async def boom(_track_id):
        raise RuntimeError("api-v2 down")

    monkeypatch.setattr(soundcloud, "resolve_hls_via_api", boom)

    assert asyncio.run(soundcloud._assemble_hls("42")) is None
