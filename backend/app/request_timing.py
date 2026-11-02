"""Bounded request diagnostics; slow work is logged without query strings."""
import asyncio
import contextvars
import json
import logging
import os
import time
import threading
from collections import defaultdict
from functools import wraps

_current = contextvars.ContextVar("request_timing", default=None)
logger = logging.getLogger("request.slow")
loop_lag_ms = 0.0


class _Spans:
    def __init__(self):
        self.values = defaultdict(float)
        self.lock = threading.Lock()

    def add(self, name, duration):
        with self.lock:
            self.values[name] += duration

    def snapshot(self):
        with self.lock:
            return dict(self.values)


async def monitor_event_loop():
    global loop_lag_ms
    while True:
        started = time.perf_counter()
        await asyncio.sleep(0.5)
        loop_lag_ms = max(0.0, (time.perf_counter() - started - 0.5) * 1000)
        if loop_lag_ms >= 200:
            logger.warning("event_loop_lag_ms=%.0f", loop_lag_ms)


def note_span(name: str, elapsed: float) -> None:
    spans = _current.get()
    if spans is not None:
        spans.add(name, elapsed * 1000)


def timed_sync(name):
    def decorate(function):
        @wraps(function)
        def invoke(*args, **kwargs):
            started = time.perf_counter()
            try:
                return function(*args, **kwargs)
            finally:
                note_span(name, time.perf_counter() - started)
        return invoke
    return decorate


async def run_blocking(executor, name, function, *args, **kwargs):
    queued = time.perf_counter()
    context = contextvars.copy_context()

    def invoke():
        started = time.perf_counter()
        note_span(name + "_queue", started - queued)
        try:
            return function(*args, **kwargs)
        finally:
            note_span(name, time.perf_counter() - started)

    return await asyncio.get_running_loop().run_in_executor(executor, context.run, invoke)


class RequestTimingMiddleware:
    def __init__(self, app):
        self.app = app
        self.slow_seconds = float(os.getenv("SLOW_REQUEST_SECONDS", "1"))

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        started = time.perf_counter()
        spans = _Spans()
        token = _current.set(spans)
        status = 500

        async def send_timed(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                elapsed = time.perf_counter() - started
                stages = spans.snapshot()
                timing = f"app;dur={elapsed * 1000:.1f}"
                for name, duration in sorted(stages.items()):
                    timing += f", {name};dur={duration:.1f}"
                message["headers"] = [*(message.get("headers") or []), (b"server-timing", timing.encode())]
                if elapsed >= self.slow_seconds:
                    logger.warning(json.dumps({
                        "method": scope["method"], "path": scope["path"], "status": status,
                        "headers_ms": round(elapsed * 1000),
                        "event_loop_lag_ms": round(loop_lag_ms),
                        "stages_ms": {key: round(value, 1) for key, value in stages.items()},
                    }))
            await send(message)

        try:
            await self.app(scope, receive, send_timed)
        finally:
            _current.reset(token)
