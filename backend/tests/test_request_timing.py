import asyncio
from concurrent.futures import ThreadPoolExecutor

from app.cache import get_cache, get_cache_async
from app.request_timing import RequestTimingMiddleware, run_blocking


def test_server_timing_includes_sync_cache_and_executor_stages_without_query_values(caplog):
    executor = ThreadPoolExecutor(max_workers=1)
    messages = []

    async def app(scope, receive, send):
        await run_blocking(executor, "provider", get_cache, "test:timing")
        await get_cache_async("test:timing")
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    async def send(message):
        messages.append(message)

    middleware = RequestTimingMiddleware(app)
    middleware.slow_seconds = 0
    try:
        asyncio.run(middleware({"type": "http", "method": "GET", "path": "/api/search", "query_string": b"q=private-query"}, None, send))
    finally:
        executor.shutdown(wait=True)
    header = dict(messages[0]["headers"])[b"server-timing"].decode()
    for name in ("app", "provider_queue", "provider", "cache_queue", "cache", "redis"):
        assert f"{name};dur=" in header
    assert "private-query" not in caplog.text
    assert '"path": "/api/search"' in caplog.text
