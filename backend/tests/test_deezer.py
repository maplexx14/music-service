"""Deezer как первый источник аудио для ytmusic-треков.

Проверяем то, что ломается молча: расшифровку «полосами» (иначе в кэш ляжет
шум с правильным размером), строгий матчинг (иначе вместо трека заиграет
чужая запись) и место Deezer в цепочке стрима.
"""

import asyncio
import os

from Crypto.Cipher import Blowfish
from starlette.requests import Request

from app.routers import deezer, ytdlp


def _encrypt(plain: bytes, sng_id: str) -> bytes:
    key = deezer._bf_key(sng_id)
    out = b""
    for i in range(0, len(plain), deezer._CHUNK):
        chunk = plain[i:i + deezer._CHUNK]
        if (i // deezer._CHUNK) % 3 == 0 and len(chunk) == deezer._CHUNK:
            chunk = Blowfish.new(key, Blowfish.MODE_CBC, deezer._BF_IV).encrypt(chunk)
        out += chunk
    return out


def test_decrypt_restores_striped_file_with_partial_tail():
    plain = os.urandom(deezer._CHUNK * 7 + 1000)
    encrypted = _encrypt(plain, "66609426")

    assert encrypted != plain
    # Незашифрованные блоки (1, 2, 4, 5) и неполный хвост идут как есть.
    assert encrypted[deezer._CHUNK:deezer._CHUNK * 3] == plain[deezer._CHUNK:deezer._CHUNK * 3]
    assert deezer.decrypt(encrypted, "66609426") == plain
    # Ключ зависит от id трека: чужой id даёт мусор.
    assert deezer.decrypt(encrypted, "1") != plain


def test_same_recording_requires_duration_artist_and_title():
    ok = deezer.is_same_recording
    assert ok("Arrogant Boy", "Deep Purple", 198, "Arrogant Boy", "Deep Purple", 199)
    # Русский артист латиницей в Deezer.
    assert ok("Владивосток 2000", "Mumiy Troll", 160, "Владивосток 2000", "Мумий Тролль", 161)
    # Длительность вне окна — другая версия.
    assert not ok("Arrogant Boy", "Deep Purple", 230, "Arrogant Boy", "Deep Purple", 199)
    # Совпало одно слово запроса, но не артист (реальный ложный кандидат).
    assert not ok("123", "Scridge", 181, "Spring", "123", 181)
    assert not ok("Spring", "Scridge", 181, "Spring", "123", 181)


def _fake_cache(monkeypatch):
    store = {}

    async def get_cache(key):
        return store.get(key)

    async def set_cache(key, value, expire=None):
        store[key] = value

    monkeypatch.setattr(deezer, "get_cache_async", get_cache)
    monkeypatch.setattr(deezer, "set_cache_async", set_cache)
    return store


class _Resp:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


def test_find_equivalent_skips_unreadable_and_caches_result(monkeypatch):
    store = _fake_cache(monkeypatch)
    calls = []

    async def fake_get(url, params=None):
        calls.append(params["q"])
        return _Resp({"data": [
            {"id": 1, "title": "Cup Noodles", "duration": 191, "readable": False, "artist": {"name": "123"}},
            {"id": 2, "title": "Cup Noodles", "duration": 191, "readable": True, "artist": {"name": "123"}},
        ]})

    monkeypatch.setattr(deezer._client, "get", fake_get)

    assert asyncio.run(deezer.find_deezer_equivalent("mRt8c7taItw", "Cup Noodles", "123", 192)) == "2"
    assert store["ytmusic:dzmatch:mRt8c7taItw"] == {"sng_id": "2"}
    # Второй вызов — из кэша, без поиска.
    assert asyncio.run(deezer.find_deezer_equivalent("mRt8c7taItw", "Cup Noodles", "123", 192)) == "2"
    assert len(calls) == 1


def test_search_error_is_not_cached_as_miss(monkeypatch):
    store = _fake_cache(monkeypatch)

    async def fake_get(url, params=None):
        return _Resp({"error": {"type": "Exception", "message": "Quota limit exceeded", "code": 4}})

    monkeypatch.setattr(deezer._client, "get", fake_get)

    assert asyncio.run(deezer.find_deezer_equivalent("vid12345", "Song", "Artist", 200)) is None
    assert "ytmusic:dzmatch:vid12345" not in store


def _request(path="/api/ytdlp/stream/VIDEOID1", query=b""):
    return Request({
        "type": "http", "method": "GET", "path": path, "query_string": query,
        "headers": [], "server": ("test", 80), "scheme": "http", "root_path": "",
    })


def _setup_chain(monkeypatch, deezer_response):
    monkeypatch.setattr(ytdlp, "_ytmusic", object())

    async def has_local_copy(_video_id):
        return False

    monkeypatch.setattr(ytdlp, "_has_local_copy", has_local_copy)
    seen = []

    async def stream_for_ytmusic(video_id, request):
        seen.append(video_id)
        return deezer_response

    monkeypatch.setattr(deezer, "stream_for_ytmusic", stream_for_ytmusic)
    return seen


def test_stream_serves_deezer_before_other_sources(monkeypatch):
    sentinel = object()
    seen = _setup_chain(monkeypatch, sentinel)

    async def must_not_run(*_a, **_kw):
        raise AssertionError("после ответа Deezer цепочка не продолжается")

    from app.routers import soulseek

    monkeypatch.setattr(soulseek, "await_soulseek_match", must_not_run)
    monkeypatch.setattr(ytdlp, "stream_cached_audio", must_not_run)

    assert asyncio.run(ytdlp.stream_ytmusic("VIDEOID1", _request())) is sentinel
    assert seen == ["VIDEOID1"]


def test_stream_falls_through_when_deezer_has_nothing(monkeypatch):
    seen = _setup_chain(monkeypatch, None)

    from app.routers import soulseek

    async def slsk_match(_video_id):
        return "TOKEN"

    monkeypatch.setattr(soulseek, "await_soulseek_match", slsk_match)

    response = asyncio.run(ytdlp.stream_ytmusic("VIDEOID1", _request()))

    assert seen == ["VIDEOID1"]
    assert response.status_code == 307
    assert response.headers["location"].startswith("/api/soulseek/stream/TOKEN")


def test_disabled_without_arl_makes_no_network_calls(monkeypatch):
    monkeypatch.setattr(deezer, "_ARL_ENV", "")
    monkeypatch.setattr(deezer, "_ARL_FILE", "/nonexistent/arl")

    async def boom(*_a, **_kw):
        raise AssertionError("без ARL сети быть не должно")

    monkeypatch.setattr(deezer, "await_deezer_match", boom)

    assert asyncio.run(deezer.stream_for_ytmusic("VIDEOID1", _request())) is None
    assert asyncio.run(deezer.prefetch_for_ytmusic("VIDEOID1")) is False


def test_lazy_archive_skips_youtube_when_deezer_serves(monkeypatch):
    from app import external_archive

    monkeypatch.setattr(deezer, "enabled", lambda: True)

    async def no_fail_marker(_key):
        return None

    monkeypatch.setattr(external_archive, "get_cache_async", no_fail_marker)

    async def match(video_id):
        return "3962842901" if video_id == "WITHMATCH" else None

    monkeypatch.setattr(deezer, "await_deezer_match", match)

    assert asyncio.run(external_archive._deezer_serves("WITHMATCH")) is True
    assert asyncio.run(external_archive._deezer_serves("NOMATCH1")) is False
    assert asyncio.run(external_archive._deezer_serves(None)) is False


def test_lazy_archive_uses_youtube_after_deezer_download_failed(monkeypatch):
    from app import external_archive

    monkeypatch.setattr(deezer, "enabled", lambda: True)

    async def fail_marker(key):
        return {"error": "403"} if key == "deezer:fail:WITHMATCH" else None

    monkeypatch.setattr(external_archive, "get_cache_async", fail_marker)

    async def match(_video_id):
        return "3962842901"

    monkeypatch.setattr(deezer, "await_deezer_match", match)

    assert asyncio.run(external_archive._deezer_serves("WITHMATCH")) is False


def test_preview_sized_file_is_rejected():
    # 132 с трека: полный MP3 128 — 2 113 200 байт, превью 30 с — ~480 КБ.
    assert deezer.is_full_length(2_113_200, 132)
    assert not deezer.is_full_length(480_000, 132)
    assert deezer.is_full_length(1_000, 0)
    assert not deezer.is_full_length(0, 0)


def test_matching_handles_stylized_names_accents_and_long_tracks():
    ok = deezer.is_same_recording
    # «KoЯn» в Deezer против «Korn» в YouTube Music.
    assert ok("Thoughtless", "KoЯn", 272, "Thoughtless", "Korn", 273)
    assert ok("Ace of Spades", "Motörhead", 169, "Ace of Spades", "Motorhead", 168)
    # Длинный трек: 7:00 против 7:06 — одна запись.
    assert ok("Knocking At Your Back Door", "Deep Purple", 420, "Knocking At Your Back Door", "Deep Purple", 426)
    # Кавер-группа с тем же названием и близкой длительностью — нет.
    assert not ok("Thoughtless", "Klones Of Nu Metal", 275, "Thoughtless", "Korn", 273)
    # Настоящая кириллица не ломается: «й» не превращается в «и».
    assert deezer._key("Мумий Тролль") != deezer._key("Мумии Тролль")
