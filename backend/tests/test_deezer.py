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
    assert store["ytmusic:dzmatch:mRt8c7taItw"] == {"sng_id": "2", "explicit": False, "edited": False}
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

    async def slsk_match(_video_id, timeout=3.0):
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


def _search_returning(monkeypatch, items):
    calls = []

    async def fake_get(url, params=None):
        calls.append(params["q"])
        return _Resp({"data": items})

    monkeypatch.setattr(deezer._client, "get", fake_get)
    return calls


def test_find_equivalent_prefers_explicit_over_edited(monkeypatch):
    # Реальная картина Deezer: у записи две редакции с тем же названием и
    # длительностью, и edited стоит в выдаче первой.
    store = _fake_cache(monkeypatch)
    _search_returning(monkeypatch, [
        {"id": 10, "title": "Song", "duration": 200, "artist": {"name": "Artist"},
         "explicit_lyrics": False, "explicit_content_lyrics": 3},
        {"id": 11, "title": "Song", "duration": 200, "artist": {"name": "Artist"},
         "explicit_lyrics": True, "explicit_content_lyrics": 1},
    ])

    assert asyncio.run(deezer.find_deezer_equivalent("VIDEOID1", "Song", "Artist", 200)) == "11"
    assert store["ytmusic:dzmatch:VIDEOID1"]["explicit"] is True
    assert asyncio.run(deezer.match_is_explicit("VIDEOID1")) is True


def test_find_equivalent_takes_edited_only_as_last_resort(monkeypatch):
    _fake_cache(monkeypatch)
    _search_returning(monkeypatch, [
        {"id": 10, "title": "Song", "duration": 200, "artist": {"name": "Artist"},
         "explicit_content_lyrics": 3},
    ])

    assert asyncio.run(deezer.find_deezer_equivalent("VIDEOID1", "Song", "Artist", 200)) == "10"
    assert asyncio.run(deezer.match_is_edited("VIDEOID1")) is True
    assert asyncio.run(deezer.match_is_explicit("VIDEOID1")) is False


def test_legacy_match_without_edition_is_searched_again(monkeypatch):
    # Матч старого формата выбран без оглядки на цензуру — ему не доверяем.
    store = _fake_cache(monkeypatch)
    store["ytmusic:dzmatch:VIDEOID1"] = {"sng_id": "10"}
    calls = _search_returning(monkeypatch, [
        {"id": 11, "title": "Song", "duration": 200, "artist": {"name": "Artist"},
         "explicit_content_lyrics": 1},
    ])

    assert asyncio.run(deezer.deezer_match_for("VIDEOID1")) is None
    assert asyncio.run(deezer.find_deezer_equivalent("VIDEOID1", "Song", "Artist", 200)) == "11"
    assert len(calls) == 1


def test_edited_match_yields_to_full_soundcloud(monkeypatch):
    from app.routers import soundcloud

    store = _fake_cache(monkeypatch)
    store["ytmusic:dzmatch:VIDEOID1"] = {"sng_id": "10", "explicit": False, "edited": True}
    monkeypatch.setattr(deezer, "enabled", lambda: True)

    async def sc_match(video_id, full_only=False):
        assert full_only
        return ("123", "https://soundcloud.com/a/song")

    monkeypatch.setattr(soundcloud, "await_soundcloud_match", sc_match)

    async def must_not_download(*_a, **_kw):
        raise AssertionError("edited-версию при оригинале на SoundCloud не качаем")

    monkeypatch.setattr(deezer, "fetch_to_cache", must_not_download)

    assert asyncio.run(deezer.stream_for_ytmusic("VIDEOID1", _request())) is None


def test_replace_youtube_copy_only_for_explicit_match(monkeypatch):
    store = _fake_cache(monkeypatch)
    monkeypatch.setattr(deezer, "enabled", lambda: True)
    fetched = []

    async def fetch(video_id, sng_id, replace=False):
        fetched.append((video_id, sng_id, replace))
        return f"/cache/{video_id}.mp3"

    monkeypatch.setattr(deezer, "fetch_to_cache", fetch)
    store["ytmusic:dzmatch:EXPLICIT1"] = {"sng_id": "11", "explicit": True, "edited": False}
    store["ytmusic:dzmatch:NEUTRAL1"] = {"sng_id": "12", "explicit": False, "edited": False}

    assert asyncio.run(deezer.replace_youtube_copy("EXPLICIT1")) == "/cache/EXPLICIT1.mp3"
    # Не explicit — цензуре взяться неоткуда, своя копия остаётся.
    assert asyncio.run(deezer.replace_youtube_copy("NEUTRAL1")) is None
    assert fetched == [("EXPLICIT1", "11", True)]


def test_fetch_replace_drops_youtube_copy(monkeypatch, tmp_path):
    monkeypatch.setattr(ytdlp, "CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(ytdlp, "_enforce_cache_limit", lambda: None)
    _fake_cache(monkeypatch)
    old = tmp_path / "VIDEOID1.webm"
    old.write_bytes(b"youtube")
    adopted = []
    monkeypatch.setattr(
        deezer, "_schedule_adopt",
        lambda vid, path, replace=False: adopted.append((vid, path, replace)),
    )

    async def download(_sng_id, dest, on_start=None):
        with open(dest, "wb") as fh:
            fh.write(b"deezer")

    monkeypatch.setattr(deezer, "_download", download)

    # Без replace готовой считается любая копия.
    assert asyncio.run(deezer.fetch_to_cache("VIDEOID1", "11")) == str(old)

    path = asyncio.run(deezer.fetch_to_cache("VIDEOID1", "11", replace=True))
    assert path == str(tmp_path / "VIDEOID1.mp3")
    assert not old.exists()
    assert ytdlp._cached_file("VIDEOID1") == path
    assert adopted == [("VIDEOID1", path, True)]


def _setup_local_copy(monkeypatch, local_path, replacement):
    monkeypatch.setattr(ytdlp, "_ytmusic", object())

    async def local_copy(_video_id):
        return local_path

    monkeypatch.setattr(ytdlp, "_local_copy_path", local_copy)
    calls = []

    async def replace(video_id, request):
        calls.append(video_id)
        return replacement

    monkeypatch.setattr(deezer, "stream_replacing_youtube_copy", replace)

    async def cached_audio(request, cache_id, resolver, archive_key=None):
        return "local"

    monkeypatch.setattr(ytdlp, "stream_cached_audio", cached_audio)
    return calls


def test_stream_replaces_youtube_copy_with_explicit(monkeypatch):
    calls = _setup_local_copy(
        monkeypatch, "minio://music/external/ytmusic/VIDEOID1.m4a", "explicit"
    )

    assert asyncio.run(ytdlp.stream_ytmusic("VIDEOID1", _request())) == "explicit"
    assert calls == ["VIDEOID1"]


def test_stream_plays_youtube_copy_while_match_is_unknown(monkeypatch):
    calls = _setup_local_copy(monkeypatch, "minio://music/external/ytmusic/VIDEOID1.m4a", None)

    assert asyncio.run(ytdlp.stream_ytmusic("VIDEOID1", _request())) == "local"
    assert calls == ["VIDEOID1"]


def test_stream_keeps_non_youtube_copy(monkeypatch):
    calls = _setup_local_copy(
        monkeypatch, "minio://music/external/ytmusic/VIDEOID1.mp3", "explicit"
    )

    assert asyncio.run(ytdlp.stream_ytmusic("VIDEOID1", _request())) == "local"
    assert calls == []


def test_replacement_does_not_wait_for_unknown_match(monkeypatch):
    _fake_cache(monkeypatch)
    monkeypatch.setattr(deezer, "enabled", lambda: True)
    scheduled = []
    monkeypatch.setattr(deezer, "schedule_replace_youtube_copy", scheduled.append)

    async def must_not_wait(*_a, **_kw):
        raise AssertionError("стрим своей копии не ждёт поиска матча")

    monkeypatch.setattr(deezer, "await_deezer_match", must_not_wait)

    assert asyncio.run(deezer.stream_replacing_youtube_copy("VIDEOID1", _request())) is None
    assert scheduled == ["VIDEOID1"]


class _GatedStream:
    """CDN Deezer: первая половина файла сразу, вторая — после gate."""

    def __init__(self, first: bytes, rest: bytes, gate: asyncio.Event):
        self.headers = {"content-length": str(len(first) + len(rest))}
        self._parts = (first, rest)
        self._gate = gate

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    def raise_for_status(self):
        pass

    async def aiter_bytes(self):
        yield self._parts[0]
        await self._gate.wait()
        yield self._parts[1]


def test_stream_starts_before_download_finishes(monkeypatch, tmp_path):
    monkeypatch.setattr(ytdlp, "CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(ytdlp, "_enforce_cache_limit", lambda: None)
    monkeypatch.setattr(deezer, "_schedule_adopt", lambda *_a, **_kw: None)
    monkeypatch.setattr(deezer, "delete_cache", lambda _key: None)
    _fake_cache(monkeypatch)
    plain = os.urandom(deezer._CHUNK * 600)  # 1.2 МБ — 75 с MP3 128
    encrypted = _encrypt(plain, "11")
    half = len(encrypted) // 2

    async def media_url(_sng_id):
        return "https://cdn", "11", len(plain), 75

    monkeypatch.setattr(deezer, "_media_url", media_url)

    async def scenario():
        gate = asyncio.Event()
        monkeypatch.setattr(
            deezer._client, "stream",
            lambda *_a, **_kw: _GatedStream(encrypted[:half], encrypted[half:], gate),
        )
        response = await deezer._stream_download("VIDEOID1", "11", _request())
        # Ответ готов, хотя вторая половина файла ещё не пришла с CDN.
        assert response.headers["content-length"] == str(len(plain))
        assert "VIDEOID1" in deezer._fetches
        body = b""
        async for chunk in response.body_iterator:
            body += chunk
            if len(body) >= half:
                gate.set()
        await asyncio.sleep(0)
        return body

    assert asyncio.run(scenario()) == plain
    assert (tmp_path / "VIDEOID1.mp3").read_bytes() == plain


def test_preview_is_rejected_before_first_byte(monkeypatch, tmp_path):
    monkeypatch.setattr(ytdlp, "CACHE_DIR", str(tmp_path))
    store = _fake_cache(monkeypatch)

    async def media_url(_sng_id):
        return "https://cdn", "11", 0, 200  # размер в getData неизвестен

    monkeypatch.setattr(deezer, "_media_url", media_url)

    async def scenario():
        gate = asyncio.Event()
        gate.set()
        preview = os.urandom(30 * 16000)
        monkeypatch.setattr(
            deezer._client, "stream",
            lambda *_a, **_kw: _GatedStream(preview, b"", gate),
        )
        return await deezer._stream_download("VIDEOID1", "11", _request())

    assert asyncio.run(scenario()) is None
    assert "deezer:fail:VIDEOID1" in store


def test_match_waits_run_in_parallel(monkeypatch):
    import time

    from app.routers import soulseek, soundcloud

    monkeypatch.setattr(ytdlp, "_ytmusic", object())

    async def no_local(_video_id):
        return None

    monkeypatch.setattr(ytdlp, "_local_copy_path", no_local)

    async def slow_deezer(_video_id, _request):
        await asyncio.sleep(0.3)
        return None

    async def slow_slsk(_video_id, timeout=3.0):
        await asyncio.sleep(0.3)
        return "TOKEN"

    async def slow_sc(_video_id, full_only=False):
        await asyncio.sleep(0.3)
        return None

    monkeypatch.setattr(deezer, "stream_for_ytmusic", slow_deezer)
    monkeypatch.setattr(soulseek, "await_soulseek_match", slow_slsk)
    monkeypatch.setattr(soundcloud, "await_soundcloud_match", slow_sc)

    started = time.monotonic()
    response = asyncio.run(ytdlp.stream_ytmusic("VIDEOID1", _request()))

    assert time.monotonic() - started < 0.5
    assert response.headers["location"].startswith("/api/soulseek/stream/TOKEN")
    assert "deezer;dur=" in response.headers["server-timing"]


def test_adopt_replace_rebinds_rows_and_drops_youtube_object(monkeypatch, tmp_path, db):
    from app import external_archive, storage
    from app.models import Track
    from tests.conftest import TestingSessionLocal

    old = "minio://music/external/ytmusic/VIDEOID1.m4a"
    new = "minio://music/external/ytmusic/VIDEOID1.mp3"
    for _ in range(2):  # дубли одной записи тоже не должны смотреть в удалённое
        db.add(Track(title="Song", artist="Artist", duration=200, source="ytmusic",
                     external_id="VIDEOID1", file_path=old, file_size=1))
    db.commit()

    local = tmp_path / "VIDEOID1.mp3"
    local.write_bytes(b"deezer")
    removed = []
    monkeypatch.setattr(storage, "is_minio_backend", lambda: True)
    monkeypatch.setattr(storage, "ensure_buckets", lambda: None)
    monkeypatch.setattr(storage, "find_music_object", lambda prefix: old)
    monkeypatch.setattr(storage, "upload_music_file", lambda path, key, ct: (new, 6))
    monkeypatch.setattr(storage, "remove_object_path", removed.append)
    monkeypatch.setattr(external_archive, "analyze_file", lambda path: None)
    monkeypatch.setattr(external_archive, "SessionLocal", TestingSessionLocal)

    async def noop(*_a, **_kw):
        pass

    monkeypatch.setattr(external_archive, "_note_archived", noop)
    monkeypatch.setattr(external_archive, "_note_acoustic_features", noop)

    result = asyncio.run(
        external_archive.adopt_local_file("ytmusic", "VIDEOID1", str(local), replace=True)
    )

    assert result == new
    assert removed == [old]
    db.expire_all()
    assert [t.file_path for t in db.query(Track)] == [new, new]


def test_youtube_route_skips_match_waits_on_repeat_requests(monkeypatch):
    from app.routers import soulseek, soundcloud

    monkeypatch.setattr(ytdlp, "_ytmusic", object())
    store = {}

    async def get_cache(key):
        return store.get(key)

    async def set_cache(key, value, expire=None):
        store[key] = value

    monkeypatch.setattr(ytdlp, "get_cache_async", get_cache)
    monkeypatch.setattr(ytdlp, "set_cache_async", set_cache)

    async def no_local(_video_id):
        return None

    monkeypatch.setattr(ytdlp, "_local_copy_path", no_local)
    lookups = []

    async def no_deezer(video_id, _request):
        lookups.append(video_id)
        return None

    async def no_match(_video_id, **_kw):
        return None

    monkeypatch.setattr(deezer, "stream_for_ytmusic", no_deezer)
    monkeypatch.setattr(soulseek, "await_soulseek_match", no_match)
    monkeypatch.setattr(soundcloud, "await_soundcloud_match", no_match)

    async def youtube(request, cache_id, resolver, archive_key=None):
        return "youtube"

    monkeypatch.setattr(ytdlp, "stream_cached_audio", youtube)

    # Safari: пробный bytes=0-1, потом основной запрос — матчи ждём один раз.
    assert asyncio.run(ytdlp.stream_ytmusic("VIDEOID1", _request())) == "youtube"
    assert asyncio.run(ytdlp.stream_ytmusic("VIDEOID1", _request())) == "youtube"
    assert lookups == ["VIDEOID1"]


def test_stream_does_not_wait_for_soulseek_search(monkeypatch):
    from app.routers import soulseek

    async def search():
        await asyncio.sleep(5)
        return "LATE"

    async def no_cached(_video_id):
        return None

    monkeypatch.setattr(soulseek, "soulseek_match_for", no_cached)

    async def scenario():
        monkeypatch.setitem(soulseek._match_inflight, "VIDEOID1", asyncio.create_task(search()))
        try:
            return await soulseek.await_soulseek_match("VIDEOID1", timeout=ytdlp._SLSK_STREAM_WAIT)
        finally:
            soulseek._match_inflight["VIDEOID1"].cancel()

    import time

    started = time.monotonic()
    assert asyncio.run(scenario()) is None
    assert time.monotonic() - started < 0.5
