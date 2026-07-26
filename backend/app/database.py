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
# gunicorn запускает несколько (-w 4). Итог умножается: старые 20+40 давали
# 240 соединений против Postgres max_connections=100 — четвёртый воркер под
# нагрузкой получал бы FATAL: too many connections вместо ожидания в пуле.
# 10+10 на воркер = 80 при -w 4, с запасом под alembic и служебные подключения.
# THREADPOOL_TOKENS остаётся больше: часть тредов занята стримами файлов и
# MinIO, они соединение БД не держат (проверено — стрим не даёт idle in
# transaction). Треды, которым БД всё же нужна, ждут в очереди пула.
DB_POOL_SIZE = int(os.getenv("DB_POOL_SIZE", "10"))
DB_MAX_OVERFLOW = int(os.getenv("DB_MAX_OVERFLOW", "10"))

engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    pool_size=DB_POOL_SIZE,
    max_overflow=DB_MAX_OVERFLOW,
    pool_recycle=1800,  # пересоздаём соединения раз в 30 мин (защита от разрывов)
    pool_timeout=30,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
