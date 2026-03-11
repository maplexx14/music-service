from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from app.database import engine, Base, SessionLocal
from app.routers import auth, tracks, playlists, search, recommendations, users, admin
import os
import uuid as uuid_mod

from contextlib import asynccontextmanager
from sqlalchemy import text

@asynccontextmanager
async def lifespan(app: FastAPI):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    # Add uuid column if missing, then backfill
    async with SessionLocal() as db:
        col_check = await db.execute(text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'playlists' AND column_name = 'uuid'"
        ))
        if not col_check.first():
            await db.execute(text("ALTER TABLE playlists ADD COLUMN uuid VARCHAR UNIQUE"))
            await db.commit()

        result = await db.execute(text("SELECT id FROM playlists WHERE uuid IS NULL"))
        rows = result.fetchall()
        for row in rows:
            await db.execute(
                text("UPDATE playlists SET uuid = :uuid WHERE id = :id"),
                {"uuid": str(uuid_mod.uuid4()), "id": row[0]}
            )
        if rows:
            await db.commit()

    yield

app = FastAPI(title="Music Streaming API", version="1.0.0", lifespan=lifespan)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
app.include_router(users.router, prefix="/api/users", tags=["users"])
app.include_router(tracks.router, prefix="/api/tracks", tags=["tracks"])
app.include_router(playlists.router, prefix="/api/playlists", tags=["playlists"])
app.include_router(search.router, prefix="/api/search", tags=["search"])
app.include_router(recommendations.router, prefix="/api/recommendations", tags=["recommendations"])
app.include_router(admin.router, prefix="/api/admin", tags=["admin"])

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


@app.get("/")
async def root():
    return {"message": "Music Streaming API"}


@app.get("/api/health")
async def health_check():
    return {"status": "healthy"}
