from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from app.database import engine, Base
from app.routers import auth, tracks, playlists, search, recommendations, users
import os

# Create database tables
Base.metadata.create_all(bind=engine)

app = FastAPI(title="Music Streaming API", version="1.0.0")

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173"],
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

# Mount static files for music
music_dir = os.path.join(os.path.dirname(__file__), "..", "music_files")
os.makedirs(music_dir, exist_ok=True)
# Mount static files with CORS support
if os.path.exists(music_dir):
    app.mount("/music_files", StaticFiles(directory=music_dir), name="music_files")


@app.get("/")
async def root():
    return {"message": "Music Streaming API"}


@app.get("/api/health")
async def health_check():
    return {"status": "healthy"}
