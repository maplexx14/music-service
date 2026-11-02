import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor

from app import provider_work
from app.cache import get_cache_async
from app.routers import ytdlp


def test_background_provider_cannot_starve_audio_or_cache(monkeypatch):
    executor = ThreadPoolExecutor(max_workers=1)
    monkeypatch.setattr(provider_work, "_background", executor)
    entered, release = threading.Event(), threading.Event()

    def slow():
        entered.set()
        release.wait(2)

    async def run():
        token = provider_work.background.set(True)
        job = asyncio.create_task(provider_work.provider_call(slow))
        provider_work.background.reset(token)
        while not entered.is_set():
            await asyncio.sleep(0.001)
        try:
            assert await asyncio.wait_for(provider_work.audio_call(lambda: "audio"), 0.3) == "audio"
            await asyncio.wait_for(get_cache_async("test:isolated-cache"), 0.3)
        finally:
            release.set()
            await job

    try:
        asyncio.run(run())
    finally:
        executor.shutdown(wait=True)


def test_prefetch_returns_before_work_and_deduplicates(monkeypatch):
    monkeypatch.setattr(ytdlp, "_ytmusic", object())
    monkeypatch.setattr(ytdlp, "_prefetch_preparing", set())
    calls = []

    async def run():
        release = asyncio.Event()

        async def prepare(video_id):
            calls.append(video_id)
            await release.wait()

        monkeypatch.setattr(ytdlp, "_prepare_prefetch_ytmusic", prepare)
        first = await asyncio.wait_for(ytdlp.prefetch_ytmusic("PREFETCH01"), 0.1)
        second = await ytdlp.prefetch_ytmusic("PREFETCH01")
        assert first == second == {"status": "queued"}
        assert await ytdlp.prefetch_ytmusic_ready("PREFETCH01") == {"ready": False}
        while not calls:
            await asyncio.sleep(0)
        release.set()
        await asyncio.gather(*list(ytdlp._prefetch_tasks))
        assert ytdlp._prefetch_preparing == set()

    asyncio.run(run())
    assert calls == ["PREFETCH01"]


def test_stale_prefetch_expires_while_waiting_for_a_slot(monkeypatch):
    monkeypatch.setattr(ytdlp, "_prefetch_preparing", {"WAITING01"})
    monkeypatch.setattr(ytdlp, "_prepare_prefetch_sem", asyncio.Semaphore(0))
    monkeypatch.setattr(ytdlp, "_PREFETCH_JOB_BUDGET", 0.01)
    calls = []

    async def prepare(video_id):
        calls.append(video_id)

    monkeypatch.setattr(ytdlp, "_prepare_prefetch_ytmusic", prepare)
    asyncio.run(asyncio.wait_for(ytdlp._prepare_prefetch_job("WAITING01"), 0.2))
    assert not calls
    assert not ytdlp._prefetch_preparing
