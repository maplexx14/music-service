"""Поиск не ждёт медленный каталог артиста дольше дедлайна.

Каталог (search → get_artist → get_playlist в YouTube Music) — самый медленный
источник /search/external/grouped. Опоздавший каталог выдача пропускает, а сам
он дорабатывает в фоне, чтобы лечь в кэш для следующего запроса.
"""

import asyncio

from app.routers import aggregate
from app.schemas import ExternalTrackResponse


def _ext(source: str, title: str, artist: str = "A") -> ExternalTrackResponse:
    return ExternalTrackResponse(
        id=f"{source}:{title}",
        source=source,
        external_id=title,
        title=title,
        artist=artist,
        duration=200,
        stream_url="",
    )


def _patch(monkeypatch, catalog_delay: float, finished: list):
    async def fake_catalog(_request, q, limit=10):
        await asyncio.sleep(catalog_delay)
        finished.append(True)
        return [_ext("ytmusic", "From Catalog")]

    async def fake_songs(_request, q, limit=10):
        return [_ext("ytmusic", "Song")]

    async def fake_sc(_request, q, limit=10):
        return [_ext("soundcloud", "Cloud")]

    monkeypatch.setattr(aggregate.ytdlp, "ytmusic_artist_catalog", fake_catalog)
    monkeypatch.setattr(aggregate.ytdlp, "search_ytmusic", fake_songs)
    monkeypatch.setattr(aggregate.soundcloud, "search_soundcloud", fake_sc)
    monkeypatch.setattr(aggregate, "_CATALOG_MIN_WAIT", 0.05)
    monkeypatch.setattr(aggregate, "_CATALOG_GRACE", 0.01)


def _titles(grouped) -> set:
    return {t.title for t in [*grouped.top, *grouped.ytmusic, *grouped.soundcloud]}


def test_grouped_answers_without_late_catalog_and_lets_it_finish(monkeypatch):
    finished: list = []
    _patch(monkeypatch, catalog_delay=0.3, finished=finished)

    async def run():
        loop = asyncio.get_running_loop()
        started = loop.time()
        grouped = await aggregate.search_external_grouped(None, "q", 30)
        elapsed = loop.time() - started
        # Задача каталога не отменена — дорабатывает и кладёт выдачу в кэш.
        await asyncio.sleep(0.4)
        return grouped, elapsed

    grouped, elapsed = asyncio.run(run())

    assert elapsed < 0.2
    assert _titles(grouped) == {"Song", "Cloud"}
    assert finished == [True]


def test_grouped_keeps_catalog_that_makes_the_deadline(monkeypatch):
    _patch(monkeypatch, catalog_delay=0.0, finished=[])

    grouped = asyncio.run(aggregate.search_external_grouped(None, "q", 30))

    assert _titles(grouped) == {"From Catalog", "Song", "Cloud"}


def test_slow_song_provider_does_not_hold_fast_results(monkeypatch):
    cancelled = []
    _patch(monkeypatch, catalog_delay=0, finished=[])
    monkeypatch.setattr(aggregate, "_EXTERNAL_SEARCH_BUDGET", 0.04)

    async def slow(*args, **kwargs):
        try:
            await asyncio.sleep(10)
        finally:
            cancelled.append(True)

    monkeypatch.setattr(aggregate.ytdlp, "search_ytmusic", slow)

    async def run():
        started = asyncio.get_running_loop().time()
        result = await aggregate.search_external_grouped(None, "q", 30)
        await asyncio.sleep(0)
        return result, asyncio.get_running_loop().time() - started

    result, elapsed = asyncio.run(run())
    assert elapsed < 0.2
    assert _titles(result) == {"From Catalog", "Cloud"}
    assert cancelled == [True]


def test_aborted_search_cancels_all_three_sources(monkeypatch):
    started, cancelled = [], []

    async def slow(*args, **kwargs):
        started.append(True)
        try:
            await asyncio.sleep(10)
        finally:
            cancelled.append(True)

    for owner, name in ((aggregate.ytdlp, "ytmusic_artist_catalog"), (aggregate.ytdlp, "search_ytmusic"), (aggregate.soundcloud, "search_soundcloud")):
        monkeypatch.setattr(owner, name, slow)

    async def run():
        task = asyncio.create_task(aggregate.search_external_grouped(None, "q", 30))
        while len(started) < 3:
            await asyncio.sleep(0)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await asyncio.sleep(0)

    asyncio.run(run())
    assert len(cancelled) == 3
