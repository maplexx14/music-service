from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List
from app.database import get_db
from app.models import Playlist, Track, User
from app.schemas import PlaylistResponse, PlaylistCreate, PlaylistUpdate
from app.dependencies import get_current_active_user

router = APIRouter()


@router.get("/", response_model=List[PlaylistResponse])
async def get_playlists(
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
async def get_my_playlists(
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    playlists = db.query(Playlist).filter(Playlist.owner_id == current_user.id).all()
    return playlists


@router.get("/{playlist_id}", response_model=PlaylistResponse)
async def get_playlist(
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
async def create_playlist(
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
async def update_playlist(
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


@router.delete("/{playlist_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_playlist(
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
async def add_track_to_playlist(
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
async def remove_track_from_playlist(
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
