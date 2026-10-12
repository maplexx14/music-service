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
