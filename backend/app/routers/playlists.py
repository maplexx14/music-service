from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy.orm import selectinload
from typing import List
import os
import uuid
import aiofiles
from pathlib import Path
from app.database import get_db
from app.models import Playlist, Track, User, LikedPlaylist
from app.schemas import PlaylistResponse, PlaylistCreate, PlaylistUpdate, LikedPlaylistResponse
from app.dependencies import get_current_active_user
from sqlalchemy import delete as sa_delete
from app.utils import compress_image

ALLOWED_IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp'}
COVER_DIR = Path(os.getenv("COVER_FILES_DIR", os.path.join(os.path.dirname(__file__), "..", "..", "cover_files")))
COVER_DIR.mkdir(parents=True, exist_ok=True)

router = APIRouter()


@router.get("/shared/{playlist_uuid}", response_model=PlaylistResponse)
async def get_shared_playlist(
    playlist_uuid: str,
    db: AsyncSession = Depends(get_db)
):
    result = await db.execute(
        select(Playlist).options(selectinload(Playlist.tracks))
        .filter(Playlist.uuid == playlist_uuid, Playlist.is_public == True)
    )
    playlist = result.scalars().first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    return playlist


@router.get("/", response_model=List[PlaylistResponse])
async def get_playlists(
    skip: int = 0,
    limit: int = 100,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db)
):
    # Get user's playlists and public playlists
    result = await db.execute(select(Playlist).options(selectinload(Playlist.tracks)).filter(
        (Playlist.owner_id == current_user.id) | (Playlist.is_public == True)
    ).offset(skip).limit(limit))
    return result.scalars().all()


@router.get("/me", response_model=List[PlaylistResponse])
async def get_my_playlists(
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db)
):
    result = await db.execute(select(Playlist).options(selectinload(Playlist.tracks)).filter(Playlist.owner_id == current_user.id))
    return result.scalars().all()


@router.get("/me/liked", response_model=List[LikedPlaylistResponse])
async def get_liked_playlists(
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db)
):
    result = await db.execute(
        select(LikedPlaylist)
        .options(selectinload(LikedPlaylist.playlist).selectinload(Playlist.tracks))
        .filter(LikedPlaylist.user_id == current_user.id)
        .order_by(LikedPlaylist.created_at.desc())
    )
    return result.scalars().all()


@router.get("/{playlist_id}", response_model=PlaylistResponse)
async def get_playlist(
    playlist_id: int,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db)
):
    result = await db.execute(select(Playlist).options(selectinload(Playlist.tracks)).filter(Playlist.id == playlist_id))
    playlist = result.scalars().first()
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
    db: AsyncSession = Depends(get_db)
):
    db_playlist = Playlist(**playlist.dict(), owner_id=current_user.id)
    db.add(db_playlist)
    await db.commit()
    
    # Re-fetch with tracks loaded
    result = await db.execute(select(Playlist).options(selectinload(Playlist.tracks)).filter(Playlist.id == db_playlist.id))
    db_playlist = result.scalars().first()
    return db_playlist


@router.put("/{playlist_id}", response_model=PlaylistResponse)
async def update_playlist(
    playlist_id: int,
    playlist_update: PlaylistUpdate,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db)
):
    result = await db.execute(select(Playlist).options(selectinload(Playlist.tracks)).filter(Playlist.id == playlist_id))
    playlist = result.scalars().first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    
    if playlist.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    
    update_data = playlist_update.dict(exclude_unset=True)
    for field, value in update_data.items():
        setattr(playlist, field, value)
    
    await db.commit()
    return playlist


@router.post("/{playlist_id}/cover", response_model=PlaylistResponse)
async def upload_playlist_cover(
    playlist_id: int,
    cover: UploadFile = File(...),
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db)
):
    result = await db.execute(select(Playlist).options(selectinload(Playlist.tracks)).filter(Playlist.id == playlist_id))
    playlist = result.scalars().first()
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

    cover_filename = f"{uuid.uuid4()}.webp"
    cover_path = COVER_DIR / cover_filename
    try:
        content = await cover.read()
        compressed_content = await compress_image(content, max_size=(800, 800), format="WEBP", quality=80)
        async with aiofiles.open(cover_path, 'wb') as f:
            await f.write(compressed_content)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to save cover: {str(e)}"
        )

    playlist.cover_url = f"/cover_files/{cover_filename}"
    await db.commit()
    return playlist


@router.delete("/{playlist_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_playlist(
    playlist_id: int,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db)
):
    result = await db.execute(select(Playlist).filter(Playlist.id == playlist_id))
    playlist = result.scalars().first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    
    if playlist.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    
    await db.delete(playlist)
    await db.commit()
    return None


@router.post("/{playlist_id}/tracks/{track_id}", status_code=status.HTTP_200_OK)
async def add_track_to_playlist(
    playlist_id: int,
    track_id: int,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db)
):
    result = await db.execute(select(Playlist).options(selectinload(Playlist.tracks)).filter(Playlist.id == playlist_id))
    playlist = result.scalars().first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    
    if playlist.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    
    track_res = await db.execute(select(Track).filter(Track.id == track_id))
    track = track_res.scalars().first()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    
    if track in playlist.tracks:
        raise HTTPException(status_code=400, detail="Track already in playlist")
    
    # Get current max position
    from app.models import playlist_tracks
    from sqlalchemy import func
    max_position = await db.scalar(select(func.max(playlist_tracks.c.position)).filter(
        playlist_tracks.c.playlist_id == playlist_id
    )) or -1
    
    # Add track with next position
    from sqlalchemy import insert
    stmt = insert(playlist_tracks).values(
        playlist_id=playlist_id,
        track_id=track_id,
        position=max_position + 1
    )
    await db.execute(stmt)
    await db.commit()
    
    return {"message": "Track added to playlist"}


@router.delete("/{playlist_id}/tracks/{track_id}", status_code=status.HTTP_200_OK)
async def remove_track_from_playlist(
    playlist_id: int,
    track_id: int,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db)
):
    result = await db.execute(select(Playlist).options(selectinload(Playlist.tracks)).filter(Playlist.id == playlist_id))
    playlist = result.scalars().first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    
    if playlist.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    
    track_res = await db.execute(select(Track).filter(Track.id == track_id))
    track = track_res.scalars().first()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    
    if track not in playlist.tracks:
        raise HTTPException(status_code=400, detail="Track not in playlist")
    
    playlist.tracks.remove(track)
    await db.commit()
    return {"message": "Track removed from playlist"}


@router.post("/{playlist_id}/like", status_code=200)
async def like_playlist(
    playlist_id: int,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db)
):
    pl = await db.execute(select(Playlist).filter(Playlist.id == playlist_id))
    if not pl.scalars().first():
        raise HTTPException(status_code=404, detail="Playlist not found")

    existing = await db.execute(
        select(LikedPlaylist).filter(
            (LikedPlaylist.user_id == current_user.id) &
            (LikedPlaylist.playlist_id == playlist_id)
        )
    )
    if existing.scalars().first():
        return {"message": "Playlist already liked"}

    db.add(LikedPlaylist(user_id=current_user.id, playlist_id=playlist_id))
    await db.commit()
    return {"message": "Playlist liked successfully"}


@router.delete("/{playlist_id}/like", status_code=200)
async def unlike_playlist(
    playlist_id: int,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db)
):
    await db.execute(
        sa_delete(LikedPlaylist).where(
            (LikedPlaylist.user_id == current_user.id) &
            (LikedPlaylist.playlist_id == playlist_id)
        )
    )
    await db.commit()
    return {"message": "Playlist unliked successfully"}
