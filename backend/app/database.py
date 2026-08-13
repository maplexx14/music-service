from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
import os

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    if os.getenv("DEBUG", "").lower() in ("1", "true", "yes"):
        DATABASE_URL = "postgresql://music_user:music_password@postgres:5432/music_db"
    else:
        raise RuntimeError("DATABASE_URL environment variable must be set (or set DEBUG=true for local development)")

# Пул под конкурентную нагрузку. Синхронные (def) эндпоинты выполняются в
# threadpool, каждый занятый тред держит одно соединение — поэтому размер пула
# должен покрывать размер threadpool (см. THREADPOOL_TOKENS в main.py).
#
# pool_size + max_overflow = потолок соединений НА ОДИН воркер, а воркеров
# gunicorn запускает несколько (GUNICORN_WORKERS, см. docker-compose.yml).
# Итог умножается: 20+20 на воркер × 8 воркеров = 320 против Postgres
# max_connections=400 (см. POSTGRES_MAX_CONNECTIONS в docker-compose.yml) —
# остаток под alembic, psql и служебные подключения. При изменении
# GUNICORN_WORKERS пересчитать оба лимита, иначе лишние воркеры под нагрузкой
# получат FATAL: too many connections вместо ожидания в пуле.
#
# Под таргет 10k активных юзеров (~1k одновременных стримов): увеличен с 10+10
# до 20+20 на воркер. THREADPOOL_TOKENS (70) остаётся больше: async-стримы
# (tracks.py:160, storage.py:462) не держат соединение БД во время передачи
# байтов (проверено — idle in transaction не появляется), держат только на
# начальную SELECT tracks. Треды, которым БД всё же нужна для работы, ждут в
# очереди пула (pool_timeout=30s).
DB_POOL_SIZE = int(os.getenv("DB_POOL_SIZE", "20"))
DB_MAX_OVERFLOW = int(os.getenv("DB_MAX_OVERFLOW", "20"))

engine_options = {"pool_pre_ping": True}
if not DATABASE_URL.startswith("sqlite"):
    engine_options.update(
        pool_size=DB_POOL_SIZE,
        max_overflow=DB_MAX_OVERFLOW,
        pool_recycle=1800,  # пересоздаём соединения раз в 30 мин (защита от разрывов)
        pool_timeout=30,
    )
engine = create_engine(DATABASE_URL, **engine_options)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
