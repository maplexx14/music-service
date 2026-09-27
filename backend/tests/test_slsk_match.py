"""Матчинг ytmusic→Soulseek и параллельный харвест.

Регресс на TypeError в find_soulseek_equivalent: он передавал в
soundcloud._is_exact_match аргумент tolerance=, которого у функции не было,
и падал на КАЖДОМ поиске, вернувшем ответы. Исключение глоталось в
_match_job/await_soulseek_match, поэтому выглядело как «Soulseek ничего не
находит»: поиск шёл 6-8с, матч всегда выходил None.

Второй блок — параллельность _harvest_pass и её собственная квота поисков,
независимая от общей _match_sem (иначе харвест морит пользовательские матчи).
"""

import asyncio

from app import slsk_harvest
from app.routers import soulseek, ytdlp
from app.routers.soundcloud import _is_exact_match

# Модульный импорт захватывает НАСТОЯЩУЮ функцию: autouse-фикстура
# _no_external_pool_network в conftest подменяет атрибут модуля уже во время
# теста, то есть после импорта этого файла.
from app.routers.soulseek import find_soulseek_equivalent as _real_find

_TITLE = "Andante Risoluto"
_ARTIST = "Nicholas Britell"
_DURATION = 148


class _Cand:
    """Минимальный кандидат для _is_exact_match."""

    def __init__(self, title: str, artist: str, duration: int):
        self.title = title
        self.artist = artist
        self.duration = duration


def _peer_response(filename: str, length: int, size: int = 5_000_000) -> dict:
    return {
        "username": "peer",
        "hasFreeUploadSlot": True,
        "uploadSpeed": 100_000,
        "files": [{"filename": filename, "length": str(length), "size": size,
                   "bitRate": 320}],
    }


def _patch_io(monkeypatch):
    """Убирает Redis и файловую систему из проверяемого пути.

    Возвращает на место настоящий find_soulseek_equivalent: autouse-фикстура
    conftest подменяет атрибут модуля пустышкой, а _harvest_one зовёт его
    именно через атрибут — без этого харвест-тесты не дошли бы до матчера.
    """
    cache: dict = {}

    async def _get(key):
        return cache.get(key)

    async def _set(key, value, expire=None):
        cache[key] = value

    monkeypatch.setattr(soulseek, "find_soulseek_equivalent", _real_find)
    monkeypatch.setattr(soulseek, "get_cache_async", _get)
    monkeypatch.setattr(soulseek, "set_cache_async", _set)
    monkeypatch.setattr(soulseek, "SOULSEEK_USERNAME", "tester")
    monkeypatch.setattr(soulseek, "_slskd_available", lambda: True)
    monkeypatch.setattr(soulseek, "_find_local_path", lambda _f: None)
    monkeypatch.setattr(soulseek, "_enqueue_download", lambda *a, **k: _noop())
    return cache


async def _noop():
    return None


def test_matching_peer_returns_token(monkeypatch):
    """Регресс: поиск вернул годного пира — токен обязан получиться."""
    _patch_io(monkeypatch)

    async def _search(q, timeout=None):
        return [_peer_response("Nicholas Britell - Andante Risoluto.mp3", _DURATION)]

    monkeypatch.setattr(soulseek, "_slskd_search_responses", _search)
    token = asyncio.run(
        _real_find("vid1", _TITLE, _ARTIST, _DURATION)
    )
    assert token, "матч обязан вернуть токен, а не None (регресс на tolerance=)"


def test_soulseek_tolerance_wider_than_soundcloud(monkeypatch):
    """±8с для пиров против ±5с у SoundCloud — намеренное расхождение.

    Рип пира разошёлся на 7с: для Soulseek это ещё та же запись, для
    SoundCloud — уже нет. Если tolerance перестанет доходить, вернётся None.
    """
    _patch_io(monkeypatch)
    drift = _DURATION + 7

    async def _search(q, timeout=None):
        return [_peer_response("Nicholas Britell - Andante Risoluto.mp3", drift)]

    monkeypatch.setattr(soulseek, "_slskd_search_responses", _search)
    assert asyncio.run(_real_find("vid2", _TITLE, _ARTIST, _DURATION))
    # Тот же кандидат, но звукодcloud-шное окно его не берёт.
    assert not _is_exact_match(
        _Cand(_TITLE, _ARTIST, drift), _TITLE, _ARTIST, _DURATION
    )
    # ...а расширенное берёт.
    assert _is_exact_match(
        _Cand(_TITLE, _ARTIST, drift), _TITLE, _ARTIST, _DURATION, tolerance=8
    )


def test_remix_rejected(monkeypatch):
    """Ремикс — не оригинал, даже при точной длительности."""
    _patch_io(monkeypatch)

    async def _search(q, timeout=None):
        return [_peer_response(
            "Nicholas Britell - Andante Risoluto (Extended Mix).mp3", _DURATION
        )]

    monkeypatch.setattr(soulseek, "_slskd_search_responses", _search)
    assert asyncio.run(_real_find("vid3", _TITLE, _ARTIST, _DURATION)) is None


# --- параллельный харвест ----------------------------------------------------


class _Track:
    def __init__(self, i: int):
        self.external_id = f"vid{i:02d}"
        self.title = f"Track {i}"
        self.artist = "Tester"
        self.album = "Alb"
        self.duration = 200 + i
        self.cover_url = None
        self.is_explicit = False


def test_harvest_pass_bounded_and_parallel(monkeypatch):
    """Квота харвестера связывает, и она же даёт ускорение против serial."""
    n, search_sec = 12, 0.05
    state = {"inflight": 0, "max": 0}
    _patch_io(monkeypatch)
    monkeypatch.setattr(soulseek, "_slskd_available", lambda: True)

    async def _catalog(artist, limit=30):
        return [_Track(i) for i in range(n)]

    async def _search(q, timeout=None):
        state["inflight"] += 1
        state["max"] = max(state["max"], state["inflight"])
        try:
            await asyncio.sleep(search_sec)
            i = int(q.split("Track ")[1])
            # Длительность из запроса: ответы не должны перепутаться.
            return [_peer_response(f"Tester - Track {i}.mp3", 200 + i)]
        finally:
            state["inflight"] -= 1

    async def _watch(video_id, token, meta):
        return None

    async def _no_archive(key):
        return None

    monkeypatch.setattr(ytdlp, "_fetch_artist_catalog", _catalog)
    monkeypatch.setattr(ytdlp, "archived_music_path", _no_archive)
    monkeypatch.setattr(soulseek, "_slskd_search_responses", _search)
    monkeypatch.setattr(slsk_harvest, "_watch_and_adopt", _watch)

    async def _run(conc: int) -> tuple[float, int]:
        import time
        state["inflight"] = state["max"] = 0
        monkeypatch.setattr(slsk_harvest, "_harvest_concurrency", conc)
        monkeypatch.setattr(slsk_harvest, "_harvest_sem", None)
        # Общая квота остаётся дефолтной (2) — доказываем независимость.
        monkeypatch.setattr(soulseek, "_match_sem", None)
        t0 = time.monotonic()
        assert await slsk_harvest._harvest_pass("Tester", n) is True
        return time.monotonic() - t0, state["max"]

    serial, _ = asyncio.run(_run(1))
    parallel, peak = asyncio.run(_run(4))
    assert peak <= 4, f"квота не связала: {peak} > 4"
    assert parallel < serial * 0.6, f"нет ускорения: {parallel:.2f} vs {serial:.2f}"


def test_harvest_one_failure_does_not_abort_pass(monkeypatch):
    """Отказ на одном треке не роняет проход (изоляция в _harvest_one)."""
    good, bad = _Track(1), _Track(2)
    _patch_io(monkeypatch)

    async def _search(q, timeout=None):
        if "Track 2" in q:
            raise RuntimeError("slskd упал на этом треке")
        return [_peer_response("Tester - Track 1.mp3", 201)]

    async def _watch(video_id, token, meta):
        return None

    async def _no_archive(key):
        return None

    monkeypatch.setattr(ytdlp, "archived_music_path", _no_archive)
    monkeypatch.setattr(soulseek, "_slskd_search_responses", _search)
    monkeypatch.setattr(slsk_harvest, "_watch_and_adopt", _watch)
    async def _both():
        return await asyncio.gather(
            slsk_harvest._harvest_one("Tester", good),
            slsk_harvest._harvest_one("Tester", bad),
        )

    assert asyncio.run(_both()) == ["matched", ""]
