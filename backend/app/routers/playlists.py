from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File
from sqlalchemy.orm import Session
from typing import List
import os
import uuid
import aiofiles
from pathlib import Path
from app.database import get_db
from app.models import Playlist, Track, User
from app.schemas import PlaylistResponse, PlaylistCreate, PlaylistUpdate
from app.dependencies import get_current_active_user

ALLOWED_IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp'}
COVER_DIR = Path(os.getenv("COVER_FILES_DIR", os.path.join(os.path.dirname(__file__), "..", "..", "cover_files")))
COVER_DIR.mkdir(parents=True, exist_ok=True)

router = APIRouter()


@router.get("/", response_model=List[PlaylistResponse])
def get_playlists(
    skip: int = 0,
    limit: int = 100,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    # Get user's playlists and public playlists
    playlists = db.query(Playlist).filter(
        (Playlist.owner_id == current_user.id) | (Playlist.is_public == True)
    ).offset(skip).limit(limit).all()
    return playlists


@router.get("/me", response_model=List[PlaylistResponse])
def get_my_playlists(
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    playlists = db.query(Playlist).filter(Playlist.owner_id == current_user.id).all()
    return playlists


@router.get("/{playlist_id}", response_model=PlaylistResponse)
def get_playlist(
    playlist_id: int,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    playlist = db.query(Playlist).filter(Playlist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    
    # Check if user has access
    if not playlist.is_public and playlist.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    
    return playlist


@router.post("/", response_model=PlaylistResponse, status_code=status.HTTP_201_CREATED)
def create_playlist(
    playlist: PlaylistCreate,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    db_playlist = Playlist(**playlist.dict(), owner_id=current_user.id)
    db.add(db_playlist)
    db.commit()
    db.refresh(db_playlist)
    return db_playlist


@router.put("/{playlist_id}", response_model=PlaylistResponse)
def update_playlist(
    playlist_id: int,
    playlist_update: PlaylistUpdate,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    playlist = db.query(Playlist).filter(Playlist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    
    if playlist.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    
    update_data = playlist_update.dict(exclude_unset=True)
    for field, value in update_data.items():
        setattr(playlist, field, value)
    
    db.commit()
    db.refresh(playlist)
    return playlist


@router.post("/{playlist_id}/cover", response_model=PlaylistResponse)
async def upload_playlist_cover(
    playlist_id: int,
    cover: UploadFile = File(...),
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    playlist = db.query(Playlist).filter(Playlist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")

    if playlist.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")

    cover_ext = Path(cover.filename).suffix.lower()
    if cover_ext not in ALLOWED_IMAGE_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cover type not allowed. Allowed types: {', '.join(ALLOWED_IMAGE_EXTENSIONS)}"
        )

    cover_filename = f"{uuid.uuid4()}{cover_ext}"
    cover_path = COVER_DIR / cover_filename
    try:
        async with aiofiles.open(cover_path, 'wb') as f:
            content = await cover.read()
            await f.write(content)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to save cover: {str(e)}"
        )

    playlist.cover_url = f"/cover_files/{cover_filename}"
    db.commit()
    db.refresh(playlist)
    return playlist


@router.delete("/{playlist_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_playlist(
    playlist_id: int,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    playlist = db.query(Playlist).filter(Playlist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    
    if playlist.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    
    db.delete(playlist)
    db.commit()
    return None


@router.post("/{playlist_id}/tracks/{track_id}", status_code=status.HTTP_200_OK)
def add_track_to_playlist(
    playlist_id: int,
    track_id: int,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    playlist = db.query(Playlist).filter(Playlist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    
    if playlist.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    
    track = db.query(Track).filter(Track.id == track_id).first()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    
    if track in playlist.tracks:
        raise HTTPException(status_code=400, detail="Track already in playlist")
    
    # Get current max position
    from app.models import playlist_tracks
    from sqlalchemy import func
    max_position = db.query(func.max(playlist_tracks.c.position)).filter(
        playlist_tracks.c.playlist_id == playlist_id
    ).scalar() or -1
    
    # Add track with next position
    from sqlalchemy import insert
    stmt = insert(playlist_tracks).values(
        playlist_id=playlist_id,
        track_id=track_id,
        position=max_position + 1
    )
    db.execute(stmt)
    db.commit()
    
    return {"message": "Track added to playlist"}


@router.delete("/{playlist_id}/tracks/{track_id}", status_code=status.HTTP_200_OK)
def remove_track_from_playlist(
    playlist_id: int,
    track_id: int,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    playlist = db.query(Playlist).filter(Playlist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    
    if playlist.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    
    track = db.query(Track).filter(Track.id == track_id).first()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    
    if track not in playlist.tracks:
        raise HTTPException(status_code=400, detail="Track not in playlist")
    
    playlist.tracks.remove(track)
    db.commit()
    return {"message": "Track removed from playlist"}
