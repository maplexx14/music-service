import asyncio
import logging

import pytest

from app.routers import soundcloud, ytdlp


def test_ytdlp_unexpected_resolve_failure_is_transient_and_logged(monkeypatch, caplog):
    cached = []

    async def fail_resolve(_video_id):
        raise RuntimeError("upstream connection reset")

    async def remember_cache(key, value, expire):
        cached.append((key, value, expire))

    monkeypatch.setattr(ytdlp, "_resolve_audio", fail_resolve)
    monkeypatch.setattr(ytdlp, "set_cache_async", remember_cache)

    with caplog.at_level(logging.WARNING, logger="app.routers.ytdlp"):
        with pytest.raises(ytdlp.TransientResolveError):
            asyncio.run(ytdlp._resolve_and_cache("video123", "resolve:key"))

    assert cached == [("resolve:key", {"transient": True}, ytdlp._TRANSIENT_TTL)]
    assert "audio resolve failed for video123" in caplog.text


def test_ytdlp_explicitly_unavailable_track_is_not_negative_cached(monkeypatch):
    cached = []

    async def unavailable(_video_id):
        raise ytdlp.TrackUnavailable("video123")

    async def remember_cache(key, value, expire):
        cached.append((key, value, expire))

    monkeypatch.setattr(ytdlp, "_resolve_audio", unavailable)
    monkeypatch.setattr(ytdlp, "set_cache_async", remember_cache)

    with pytest.raises(ytdlp.TrackUnavailable):
        asyncio.run(ytdlp._resolve_and_cache("video123", "resolve:key"))

    assert cached == []


def test_invidious_unavailable_result_falls_back_to_ytdlp(monkeypatch):
    async def invidious_unavailable(_video_id):
        raise ytdlp.TrackUnavailable("video123")

    async def ytdlp_resolve(_video_id):
        return "https://cdn.example/audio.m4a", ".m4a", 123

    monkeypatch.setattr(ytdlp, "_INVIDIOUS_ENABLED", True)
    monkeypatch.setattr(ytdlp, "_resolve_via_invidious", invidious_unavailable)
    monkeypatch.setattr(ytdlp, "_resolve_via_ytdlp", ytdlp_resolve)

    assert asyncio.run(ytdlp._resolve_audio("video123")) == (
        "https://cdn.example/audio.m4a", ".m4a", 123
    )


def test_needs_auth_detects_age_gated_video():
    # availability=needs_auth — прямой признак age-gate/login-only
    assert ytdlp._needs_auth({"availability": "needs_auth", "formats": []})
    # age_limit>=18 при нуле форматов — вторичная эвристика того же случая
    assert ytdlp._needs_auth({"age_limit": 18, "formats": []})
    # 18+, но форматы есть — играется, НЕ считаем недоступным
    assert not ytdlp._needs_auth({"age_limit": 18, "formats": [{"url": "x"}]})
    # обычное публичное видео без форматов — это временный сбой, не age-gate
    assert not ytdlp._needs_auth({"availability": "public", "formats": []})
    assert not ytdlp._needs_auth({})


def test_resolve_audio_propagates_ytdlp_unavailable_over_invidious_transient(monkeypatch):
    """Age-gate: Invidious кидает transient (500), yt-dlp — TrackUnavailable.
    Итог должен быть TrackUnavailable (→404, чистый скип), а не transient (503,
    бесконечный ретрай на фронте)."""

    async def invidious_transient(_video_id):
        raise ytdlp.TransientResolveError("v")

    async def ytdlp_unavailable(_video_id):
        raise ytdlp.TrackUnavailable("v")

    monkeypatch.setattr(ytdlp, "_INVIDIOUS_ENABLED", True)
    monkeypatch.setattr(ytdlp, "_resolve_via_invidious", invidious_transient)
    monkeypatch.setattr(ytdlp, "_resolve_via_ytdlp", ytdlp_unavailable)

    with pytest.raises(ytdlp.TrackUnavailable):
        asyncio.run(ytdlp._resolve_audio("v"))


def test_resolve_audio_transient_when_both_sources_transient(monkeypatch):
    async def transient(_video_id):
        raise ytdlp.TransientResolveError("v")

    monkeypatch.setattr(ytdlp, "_INVIDIOUS_ENABLED", True)
    monkeypatch.setattr(ytdlp, "_resolve_via_invidious", transient)
    monkeypatch.setattr(ytdlp, "_resolve_via_ytdlp", transient)

    with pytest.raises(ytdlp.TransientResolveError):
        asyncio.run(ytdlp._resolve_audio("v"))


def test_single_flight_deduplicates_parallel_resolves():
    calls = []

    async def slow_resolve():
        calls.append(1)
        await asyncio.sleep(0.05)
        return ("https://cdn.example/audio.mp3", ".mp3", 123, True)

    async def run():
        return await asyncio.gather(
            ytdlp.single_flight_resolve("test:42", slow_resolve),
            ytdlp.single_flight_resolve("test:42", slow_resolve),
            ytdlp.single_flight_resolve("test:42", slow_resolve),
        )

    results = asyncio.run(run())

    assert len(calls) == 1  # три параллельных вызова → один реальный резолв
    assert results == [("https://cdn.example/audio.mp3", ".mp3", 123, True)] * 3
    assert "test:42" not in ytdlp._inflight_resolves  # ключ подчищен


def test_single_flight_propagates_failure_and_clears_key():
    async def failing_resolve():
        raise ytdlp.TransientResolveError("42")

    with pytest.raises(ytdlp.TransientResolveError):
        asyncio.run(ytdlp.single_flight_resolve("test:fail", failing_resolve))

    assert "test:fail" not in ytdlp._inflight_resolves


def test_probe_rejects_empty_success_response():
    class Response:
        status_code = 206
        content = b""
        headers = {"content-range": "bytes 0-0/123"}

    class Client:
        async def get(self, _url, headers):
            assert headers == {"Range": "bytes=0-0"}
            return Response()

    assert asyncio.run(ytdlp._probe(Client(), "https://cdn.example/audio")) == (599, None)


def test_soundcloud_temporary_failure_is_not_cached_as_unavailable(monkeypatch, caplog):
    cached = []

    async def no_cached_value(_key):
        return None

    async def fail_to_thread(_func, *_args, **_kwargs):
        raise RuntimeError("network timeout")

    async def remember_cache(key, value, expire):
        cached.append((key, value, expire))

    monkeypatch.setattr(soundcloud, "get_cache_async", no_cached_value)
    monkeypatch.setattr(soundcloud.asyncio, "to_thread", fail_to_thread)
    async def fail_api_fallback(_track_id):
        raise RuntimeError("API timeout")

    monkeypatch.setattr(soundcloud, "_resolve_via_api", fail_api_fallback)
    monkeypatch.setattr(soundcloud, "set_cache_async", remember_cache)

    with caplog.at_level(logging.WARNING, logger="app.routers.soundcloud"):
        with pytest.raises(ytdlp.TransientResolveError):
            asyncio.run(soundcloud._resolve_cached("42", "https://soundcloud.com/a/b"))

    assert cached == [
        ("soundcloud:resolve:42", {"transient": True}, soundcloud._TRANSIENT_TTL)
    ]
    assert "SoundCloud resolve failed for 42" in caplog.text


def test_soundcloud_drm_only_track_is_unavailable(monkeypatch):
    """MONETIZE-трек с одними лишь ctr-/cbc-encrypted-hls транскодами (DRM) и
    без прогрессивного пресета — невоспроизводим. Должен дать TrackUnavailable
    (→404, чистый скип), а не RuntimeError→transient (→503, вечный ретрай)."""

    async def api_get(_path, _params):
        return {
            "media": {
                "transcodings": [
                    {"url": "enc1", "format": {"protocol": "ctr-encrypted-hls"}},
                    {"url": "enc2", "format": {"protocol": "cbc-encrypted-hls"}},
                ]
            }
        }

    monkeypatch.setattr(soundcloud, "_api_get", api_get)

    with pytest.raises(ytdlp.TrackUnavailable):
        asyncio.run(soundcloud._resolve_via_api("1809571188"))


def test_soundcloud_drm_track_with_dead_progressive_is_unavailable(monkeypatch):
    """Реальный случай трека 1809571188: прогрессивный mp3-пресет ещё числится
    в метаданных, но его эндпоинт отдаёт 404, а рядом есть DRM-транскоды. Это
    не временный сбой — трек недоступен (→404), а не transient (→503)."""

    async def api_get(_path, _params):
        return {
            "media": {
                "transcodings": [
                    {"url": "enc", "format": {"protocol": "ctr-encrypted-hls"}},
                    {
                        "url": "https://api-v2.soundcloud.com/prog",
                        "format": {"protocol": "progressive", "mime_type": "audio/mpeg"},
                    },
                ]
            }
        }

    async def cached_cid(_key):
        return "CID"

    class DeadTranscoding:
        status_code = 404
        is_error = True
        is_redirect = False
        headers: dict = {}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def get(self, _url, params=None):
            return DeadTranscoding()

    import httpx

    monkeypatch.setattr(soundcloud, "_api_get", api_get)
    monkeypatch.setattr(soundcloud, "get_cache_async", cached_cid)
    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)

    with pytest.raises(ytdlp.TrackUnavailable):
        asyncio.run(soundcloud._resolve_via_api("1809571188"))


def test_soundcloud_uses_api_fallback_when_ytdlp_metadata_returns_404(monkeypatch):
    cached = []

    async def no_cached_value(_key):
        return None

    async def fail_to_thread(_func, *_args, **_kwargs):
        raise RuntimeError("HTTP Error 404: Not Found")

    async def api_fallback(track_id):
        assert track_id == "42"
        return "https://cdn.example/audio.mp3", ".mp3", 123

    async def remember_cache(key, value, expire):
        cached.append((key, value, expire))

    monkeypatch.setattr(soundcloud, "get_cache_async", no_cached_value)
    monkeypatch.setattr(soundcloud.asyncio, "to_thread", fail_to_thread)
    monkeypatch.setattr(soundcloud, "_resolve_via_api", api_fallback)
    monkeypatch.setattr(soundcloud, "set_cache_async", remember_cache)

    resolved = asyncio.run(soundcloud._resolve_cached("42", "https://soundcloud.com/a/b"))

    assert resolved == ("https://cdn.example/audio.mp3", ".mp3", 123, True)
    assert cached == [
        (
            "soundcloud:resolve:42",
            {"url": "https://cdn.example/audio.mp3", "ext": ".mp3", "total": 123},
            soundcloud._RESOLVE_TTL,
        )
    ]


def test_bot_check_is_not_treated_as_unavailable():
    """«Sign in to confirm you're not a bot» — rate-limit по IP, а не мёртвый
    ролик. Если счесть его недоступностью, фронт скипнет живой трек по 404."""
    # YouTube пишет "you’re" через типографский апостроф (U+2019) — матч не
    # должен на него опираться.
    msg = "Sign in to confirm you’re not a bot"
    assert ytdlp.is_bot_check_error(msg)
    assert not ytdlp.is_track_unavailable_error(Exception(msg))


def test_geo_blocked_video_is_classified_unavailable():
    """"Video unavailable" на всех клиентах — перманентно для нашего IP.
    Должно дать 404 (чистый скип), а не 503 с выжиганием ретраев."""
    assert ytdlp.is_track_unavailable_error(
        Exception("[youtube] Video unavailable. This video is not available")
    )
    assert not ytdlp.is_bot_check_error("Video unavailable")


def test_bot_check_gets_long_backoff_cache(monkeypatch):
    """Bot-check кэшируется отдельным маркером и НАДОЛГО: быстрый ретрай
    только продлевает блокировку."""
    cached = []

    async def bot_check(_video_id):
        raise ytdlp.BotCheckError("v")

    async def remember_cache(key, value, expire):
        cached.append((key, value, expire))

    monkeypatch.setattr(ytdlp, "_resolve_audio", bot_check)
    monkeypatch.setattr(ytdlp, "set_cache_async", remember_cache)

    with pytest.raises(ytdlp.BotCheckError):
        asyncio.run(ytdlp._resolve_and_cache("v", "resolve:key"))

    assert cached == [
        ("resolve:key", {"transient": True, "bot_check": True}, ytdlp._BOT_CHECK_TTL)
    ]
    assert ytdlp._BOT_CHECK_TTL > ytdlp._TRANSIENT_TTL


def test_cached_bot_check_marker_short_circuits_resolve(monkeypatch):
    """Пока жив бэкофф-маркер, к YouTube не ходим вовсе."""

    async def cached_bot_check(_key):
        return {"transient": True, "bot_check": True}

    def must_not_run(*_a, **_kw):
        raise AssertionError("resolve must not be attempted during backoff")

    monkeypatch.setattr(ytdlp, "get_cache_async", cached_bot_check)
    monkeypatch.setattr(ytdlp, "single_flight_resolve", must_not_run)

    with pytest.raises(ytdlp.BotCheckError):
        asyncio.run(ytdlp._resolve_cached("v"))


def test_bot_check_survives_hedge_without_downgrade(monkeypatch):
    """Invidious упал transient, yt-dlp вернул bot-check. Итог обязан остаться
    BotCheckError — иначе бэкофф схлопнется в 25с и повторы продлят блокировку."""

    async def invidious_transient(_video_id):
        raise ytdlp.TransientResolveError("v")

    async def ytdlp_bot_check(_video_id):
        raise ytdlp.BotCheckError("v")

    monkeypatch.setattr(ytdlp, "_INVIDIOUS_ENABLED", True)
    monkeypatch.setattr(ytdlp, "_resolve_via_invidious", invidious_transient)
    monkeypatch.setattr(ytdlp, "_resolve_via_ytdlp", ytdlp_bot_check)

    with pytest.raises(ytdlp.BotCheckError):
        asyncio.run(ytdlp._resolve_audio("v"))


def test_client_candidates_are_valid_ytdlp_clients():
    """Регрессия на первопричину: primary-набор был "android_music", которого
    в yt-dlp уже нет — слот молча пустовал ("Skipping unsupported client"),
    резолв каждый раз съедал хедж-задержку и веером поднимал все фолбэки."""
    from yt_dlp.extractor.youtube._base import INNERTUBE_CLIENTS

    for client_set in ytdlp._CLIENT_CANDIDATES:
        for client in client_set:
            assert client in INNERTUBE_CLIENTS, f"unknown yt-dlp client: {client}"
