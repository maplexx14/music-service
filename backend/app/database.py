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

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
