"""Keep blocking provider calls out of the cache/DB and audio thread pools."""
import contextvars
import os
from concurrent.futures import ThreadPoolExecutor

from app.request_timing import run_blocking

background = contextvars.ContextVar("provider_background", default=False)
_foreground = ThreadPoolExecutor(max_workers=int(os.getenv("PROVIDER_THREADS", "8")), thread_name_prefix="provider")
_background = ThreadPoolExecutor(max_workers=int(os.getenv("PREFETCH_THREADS", "2")), thread_name_prefix="prefetch")
_audio = ThreadPoolExecutor(max_workers=int(os.getenv("AUDIO_RESOLVE_THREADS", "4")), thread_name_prefix="audio-resolve")


async def provider_call(function, *args, **kwargs):
    is_background = background.get()
    return await run_blocking(
        _background if is_background else _foreground,
        "prefetch" if is_background else "provider", function, *args, **kwargs,
    )


async def audio_call(function, *args, **kwargs):
    is_background = background.get()
    return await run_blocking(
        _background if is_background else _audio,
        "prefetch" if is_background else "audio_resolve", function, *args, **kwargs,
    )
