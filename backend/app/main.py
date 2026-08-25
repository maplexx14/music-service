import asyncio
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from app.database import engine, Base
from app.rate_limit import limiter
from app.routers import auth, tracks, playlists, search, recommendations, users, external, soulseek, ytdlp, soundcloud, importer, aggregate, flow, yandex_music, spotify, artists, albums

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
app.include_router(yandex_music.router, prefix="/api/yandex", tags=["yandex"])
app.include_router(spotify.router, prefix="/api/spotify", tags=["spotify"])
app.include_router(aggregate.router, prefix="/api/search", tags=["search"])
app.include_router(artists.router, prefix="/api/artists", tags=["artists"])
app.include_router(albums.router, prefix="/api/albums", tags=["albums"])
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
async def _warn_if_mail_cannot_be_delivered() -> None:
    # Вход с нового устройства ОБЯЗАТЕЛЬНО требует код на почту (см.
    # routers/auth.py login), поэтому ненастроенный SMTP не «портит письма»,
    # а закрывает вход всем, чьё устройство ещё не подтверждено. Молча узнать
    # об этом от юзеров — худший вариант, поэтому предупреждаем на старте.
    import logging

    from app.email_2fa import LOG_CODE_WITHOUT_SMTP
    from app.mailer import SMTP_REQUIRED, smtp_configuration_errors, smtp_configured

    if smtp_configured():
        return
    logger = logging.getLogger("mailer")
    errors = "; ".join(smtp_configuration_errors())
    if SMTP_REQUIRED:
        raise RuntimeError(f"SMTP configuration is required but invalid: {errors}")
    if LOG_CODE_WITHOUT_SMTP:
        logger.warning(
            "SMTP is not configured; DEBUG is on, so 2FA login codes go to this log"
        )
    else:
        logger.error(
            "SMTP is not configured correctly (%s) and DEBUG is off: login from a new device asks for "
            "an email code that cannot be delivered. Set SMTP_HOST (or DEBUG=true for "
            "local development)",
            errors,
        )


@app.on_event("startup")
async def _warn_if_captcha_is_off() -> None:
    # Регистрация без каптчи открыта скриптам: rate-limit режет темп с одного
    # адреса, но не ботнет, а каждый созданный аккаунт тянет за собой письмо
    # подтверждения с нашего домена (репутация отправителя). Молчать об этом
    # нельзя — но и падать нельзя: локальная разработка идёт без ключей.
    import logging

    from app.captcha import captcha_configured, half_configured

    logger = logging.getLogger("captcha")
    if captcha_configured():
        return
    if half_configured():
        logger.error(
            "Turnstile is half-configured: set BOTH TURNSTILE_SITE_KEY and "
            "TURNSTILE_SECRET_KEY, otherwise the captcha is skipped entirely"
        )
    else:
        logger.warning(
            "Turnstile keys are not set: registration accepts requests without a "
            "captcha. Set TURNSTILE_SITE_KEY/TURNSTILE_SECRET_KEY in production"
        )


@app.on_event("startup")
async def _configure_threadpool() -> None:
    # Синхронные (def) эндпоинты БД/API (auth, search, playlists, ...) выполняются
    # в anyio threadpool — короткие запросы, тредов под них нужно немного.
    # Аудио/обложки стрим больше НЕ идёт через этот threadpool (см.
    # _init_async_storage_client ниже и storage.py init_async_client) —
    # THREADPOOL_TOKENS не нужно поднимать под конкурентность слушателей.
    import anyio
    from anyio import to_thread

    tokens = int(os.getenv("THREADPOOL_TOKENS", "70"))
    try:
        to_thread.current_default_thread_limiter().total_tokens = tokens
    except Exception:  # noqa: BLE001 — не критично, если API изменится
        pass


@app.on_event("startup")
async def _init_async_storage_client() -> None:
    # aiohttp-сессия внутри async S3-клиента привязана к event loop конкретного
    # воркера — создаём здесь (после того как loop уже запущен), а не на импорте
    # модуля. Полагается на то, что gunicorn запускается БЕЗ --preload (см.
    # docker-compose.yml/Dockerfile): каждый воркер форкается до импорта
    # app.main, поэтому у каждого гарантированно свой клиент/сессия.
    from app import storage

    if storage.is_minio_backend():
        await storage.init_async_client()


@app.on_event("shutdown")
async def _close_async_storage_client() -> None:
    from app import storage

    await storage.close_async_client()


@app.on_event("startup")
async def _cooccurrence_rebuild_loop() -> None:
    # Периодический пересчёт item-item co-occurrence для коллаборативных
    # рекомендаций (см. app/cooccurrence.py). Считать на каждый запрос дорого
    # (self-join по всем сигналам всех юзеров), меняется матрица медленно —
    # раз в час в фоне достаточно. Первый пересчёт — сразу на старте (матрица
    # могла устареть, пока сервис лежал), в треде — не блокируем event loop.
    #
    # LEADER ELECTION: эта задача запускается в каждом воркере gunicorn
    # (on_event("startup") = per-worker), но пересчёт должен идти только в ОДНОМ.
    # Иначе 8 воркеров параллельно гоняют тот же тяжёлый self-join. Лидер
    # определяется try-acquire на Redis-ключ с TTL = 2 × interval: только тот
    # воркер, который захватил ключ, выполняет rebuild_cooccurrence; остальные
    # проверяют на каждой итерации и тихо пропускают. Если лидер упал, ключ
    # протухает и другой воркер подхватывает роль.
    import logging

    from app.cache import redis_client
    from app.cooccurrence import rebuild_cooccurrence
    from app.database import SessionLocal

    logger = logging.getLogger("cooccurrence")
    interval = int(os.getenv("COOCCURRENCE_REBUILD_INTERVAL_SEC", "3600"))
    lock_key = "background:cooccurrence:leader"
    lock_ttl = interval * 2

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
                # Атомарный try-acquire: SET NX EX. Если вернул 1 — этот воркер лидер.
                is_leader = redis_client.set(lock_key, "1", nx=True, ex=lock_ttl)
                if is_leader:
                    await asyncio.to_thread(_rebuild_once)
                # else: другой воркер уже лидер — ничего не делаем
            except Exception:  # noqa: BLE001 — фон не должен умирать навсегда
                logger.exception("cooccurrence rebuild failed")
            await asyncio.sleep(interval)

    asyncio.create_task(_loop())


@app.on_event("startup")
async def _play_events_cleanup_loop() -> None:
    """Периодическая очистка старых событий прослушивания.

    user_play_events — лог, который растёт бесконечно: каждое переключение
    трека пишет строку. Без очистки таблица раздувается и замедляет
    рекомендации (GROUP BY completion в recommendations.py). Агрегированные
    данные живут в user_track_plays — лог можно чистить без потери.

    LEADER ELECTION + CHUNKED DELETE: только один воркер выполняет cleanup,
    и удаляет батчами по 5000 строк с коммитом после каждого батча (защита
    от длинных блокирующих транзакций на таблице с миллионами строк).
    """
    import logging

    from app.cache import redis_client
    from app.database import SessionLocal
    from sqlalchemy import text

    logger = logging.getLogger("cleanup")
    interval = int(os.getenv("PLAY_EVENTS_CLEANUP_INTERVAL_SEC", "3600"))
    retention_days = int(os.getenv("PLAY_EVENTS_RETENTION_DAYS", "90"))
    lock_key = "background:cleanup:leader"
    lock_ttl = interval * 2
    chunk_size = 5000

    def _cleanup_once() -> None:
        db = SessionLocal()
        try:
            total_deleted = 0
            while True:
                result = db.execute(
                    text(
                        "DELETE FROM user_play_events WHERE id IN ("
                        "  SELECT id FROM user_play_events "
                        "  WHERE played_at < NOW() - INTERVAL '1 day' * :days "
                        "  LIMIT :chunk_size"
                        ")"
                    ),
                    {"days": retention_days, "chunk_size": chunk_size},
                )
                deleted = result.rowcount
                if deleted > 0:
                    db.commit()
                    total_deleted += deleted
                if deleted < chunk_size:
                    break
            if total_deleted > 0:
                logger.info(
                    "play_events cleanup: deleted %d rows older than %d days",
                    total_deleted,
                    retention_days,
                )
        finally:
            db.close()

    async def _loop() -> None:
        while True:
            try:
                is_leader = redis_client.set(lock_key, "1", nx=True, ex=lock_ttl)
                if is_leader:
                    await asyncio.to_thread(_cleanup_once)
            except Exception:  # noqa: BLE001
                logger.exception("play_events cleanup failed")
            await asyncio.sleep(interval)

    asyncio.create_task(_loop())


@app.on_event("startup")
async def _artist_probe_loop() -> None:
    """Фоновая сверка артистов-кандидатов по косинусу (app/artist_probe.py).

    Разведке потока нужен не ещё один пул, а один ПРОВЕРЕННЫЙ трек: воркер
    берёт незнакомые имена из графа похожести, сворачивает каталог каждого в
    вектор, меряет косинус к вектору вкуса и кладёт в Redis один трек
    победителя. ``get_flow`` читает готовое одним GET — в запросе сравнение
    стоило бы до шести сетевых вызовов подряд.

    LEADER ELECTION с ПРОДЛЕНИЕМ: как и в соседних циклах, работает один
    воркер, но ключ здесь держит токен владельца, и владелец продлевает TTL
    на каждой итерации. Без этого (см. _cooccurrence_rebuild_loop) ключ с
    TTL = 2 × interval ещё жив на следующей итерации, SET NX не проходит ни у
    кого — и проход по факту случается вдвое реже заявленного интервала.
    """
    import logging
    import uuid

    from app.artist_probe import refresh_probes
    from app.cache import redis_client

    logger = logging.getLogger("artist_probe")
    interval = int(os.getenv("ARTIST_PROBE_INTERVAL_SEC", "900"))
    if interval <= 0:
        logger.info("artist probe disabled (ARTIST_PROBE_INTERVAL_SEC <= 0)")
        return
    users = int(os.getenv("ARTIST_PROBE_USERS", "25"))
    days = int(os.getenv("ARTIST_PROBE_ACTIVE_DAYS", "14"))
    lock_key = "background:artist_probe:leader"
    # Токен переживает только этот процесс: воркер, которого перезапустили,
    # претендует на лидерство заново, а не наследует чужое владение.
    token = f"{os.getpid()}:{uuid.uuid4().hex}"
    # Запас на длительность самого прохода: сеть провайдеров может отвечать
    # долго, и терять лидерство посреди сравнения незачем.
    lock_ttl = interval + max(300, interval)

    def _acquire() -> bool:
        if redis_client.set(lock_key, token, nx=True, ex=lock_ttl):
            return True
        # Уже наш ключ с прошлой итерации — продлеваем и работаем дальше.
        if redis_client.get(lock_key) == token:
            redis_client.expire(lock_key, lock_ttl)
            return True
        return False

    async def _loop() -> None:
        while True:
            try:
                if await asyncio.to_thread(_acquire):
                    picked = await refresh_probes(days=days, limit=users)
                    if picked:
                        logger.info("artist probe: %d user(s) got a new pick", picked)
            except Exception:  # noqa: BLE001 — фон не должен умирать навсегда
                logger.exception("artist probe pass failed")
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
