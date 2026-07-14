import asyncio
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from app.database import engine, Base
from app.rate_limit import limiter
from app.routers import auth, tracks, playlists, search, recommendations, users, external, soulseek, ytdlp, soundcloud, importer, aggregate, flow

# Schema is managed by Alembic migrations (alembic upgrade head).
# For quick local dev without migrations set DEBUG=true.
if os.getenv("DEBUG", "").lower() in ("1", "true", "yes"):
    Base.metadata.create_all(bind=engine)

app = FastAPI(title="Music Streaming API", version="1.0.0")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# CORS: allow_origins=["*"] и allow_credentials=True несовместимы.
# По умолчанию allow_credentials=False (Bearer в заголовке не требует cookies).
# Для разных доменов фронта и бэка задайте CORS_ORIGINS в .env (через запятую).
CORS_ORIGINS_STR = os.getenv("CORS_ORIGINS", "*")
CORS_ORIGINS = [o.strip() for o in CORS_ORIGINS_STR.split(",") if o.strip()]
if not CORS_ORIGINS or "*" in CORS_ORIGINS:
    CORS_ORIGINS = ["*"]
    ALLOW_CREDENTIALS = False
else:
    ALLOW_CREDENTIALS = True

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=ALLOW_CREDENTIALS,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

# Include routers
app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
app.include_router(users.router, prefix="/api/users", tags=["users"])
app.include_router(tracks.router, prefix="/api/tracks", tags=["tracks"])
app.include_router(playlists.router, prefix="/api/playlists", tags=["playlists"])
app.include_router(search.router, prefix="/api/search", tags=["search"])
app.include_router(recommendations.router, prefix="/api/recommendations", tags=["recommendations"])
app.include_router(external.router, prefix="/api/external", tags=["external"])
app.include_router(soulseek.router, prefix="/api/soulseek", tags=["soulseek"])
app.include_router(ytdlp.router, prefix="/api/ytdlp", tags=["ytdlp"])
app.include_router(soundcloud.router, prefix="/api/soundcloud", tags=["soundcloud"])
app.include_router(importer.router, prefix="/api/import", tags=["import"])
app.include_router(aggregate.router, prefix="/api/search", tags=["search"])
app.include_router(flow.router, prefix="/api/recommendations", tags=["recommendations"])

# Mount static files for music
music_dir = os.path.join(os.path.dirname(__file__), "..", "music_files")
os.makedirs(music_dir, exist_ok=True)
# Mount static files for covers
cover_dir = os.path.join(os.path.dirname(__file__), "..", "cover_files")
os.makedirs(cover_dir, exist_ok=True)
# Mount static files with CORS support
if os.path.exists(music_dir):
    app.mount("/music_files", StaticFiles(directory=music_dir), name="music_files")
if os.path.exists(cover_dir):
    app.mount("/cover_files", StaticFiles(directory=cover_dir), name="cover_files")


@app.on_event("startup")
async def _configure_threadpool() -> None:
    # Синхронные (def) эндпоинты и sync-генераторы стримов выполняются в
    # anyio threadpool. Дефолт — 40 тредов, что мало под 100+ конкурентных
    # запросов; поднимаем лимит. Должен согласовываться с размером пула БД.
    import anyio
    from anyio import to_thread

    tokens = int(os.getenv("THREADPOOL_TOKENS", "60"))
    try:
        to_thread.current_default_thread_limiter().total_tokens = tokens
    except Exception:  # noqa: BLE001 — не критично, если API изменится
        pass


@app.on_event("startup")
async def _cooccurrence_rebuild_loop() -> None:
    # Периодический пересчёт item-item co-occurrence для коллаборативных
    # рекомендаций (см. app/cooccurrence.py). Считать на каждый запрос дорого
    # (self-join по всем сигналам всех юзеров), меняется матрица медленно —
    # раз в час в фоне достаточно. Первый пересчёт — сразу на старте (матрица
    # могла устареть, пока сервис лежал), в треде — не блокируем event loop.
    import logging

    from app.cooccurrence import rebuild_cooccurrence
    from app.database import SessionLocal

    logger = logging.getLogger("cooccurrence")
    interval = int(os.getenv("COOCCURRENCE_REBUILD_INTERVAL_SEC", "3600"))

    def _rebuild_once() -> None:
        db = SessionLocal()
        try:
            pairs = rebuild_cooccurrence(db)
            logger.info("cooccurrence rebuilt: %d pairs", pairs)
        finally:
            db.close()

    async def _loop() -> None:
        while True:
            try:
                await asyncio.to_thread(_rebuild_once)
            except Exception:  # noqa: BLE001 — фон не должен умирать навсегда
                logger.exception("cooccurrence rebuild failed")
            await asyncio.sleep(interval)

    asyncio.create_task(_loop())


@app.on_event("startup")
async def _warmup_ytdlp() -> None:
    # Первый резолв YouTube Music в свежем процессе платит cold-start за
    # импорт yt_dlp и загрузку реестра экстракторов/плагинов (~0.5-0.7с) —
    # без прогрева это ощущается как «первый проигранный трек всегда долго
    # грузится». Гоняем в фоне (create_task), не await — не хотим держать
    # health-check/остальной startup на сетевой инициализации yt-dlp.
    if ytdlp._ytmusic is None:
        return
    asyncio.create_task(asyncio.to_thread(ytdlp._warmup_ydl_blocking))


@app.get("/")
async def root():
    return {"message": "Music Streaming API"}


@app.get("/api/health")
async def health_check():
    return {"status": "healthy"}
