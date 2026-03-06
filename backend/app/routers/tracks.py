from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File, Form, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from typing import List, Optional
import os
import uuid
import aiofiles
from pathlib import Path
from app.database import get_db
from app.models import Track, User, user_liked_tracks
from app.schemas import TrackResponse, TrackCreate
from app.dependencies import get_current_active_user
from app.utils import compress_image

router = APIRouter()

# Allowed audio file extensions
ALLOWED_EXTENSIONS = {'.mp3', '.wav', '.flac', '.m4a', '.ogg', '.aac'}
ALLOWED_IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp'}
# Use environment variable or default path
MUSIC_DIR = Path(os.getenv("MUSIC_FILES_DIR", os.path.join(os.path.dirname(__file__), "..", "..", "music_files")))
COVER_DIR = Path(os.getenv("COVER_FILES_DIR", os.path.join(os.path.dirname(__file__), "..", "..", "cover_files")))
MUSIC_DIR.mkdir(parents=True, exist_ok=True)
COVER_DIR.mkdir(parents=True, exist_ok=True)


@router.get("/", response_model=List[TrackResponse])
async def get_tracks(
    skip: int = 0,
    limit: int = 100,
    genre: Optional[str] = None,
    artist: Optional[str] = None,
    db: AsyncSession = Depends(get_db)
):
    query = select(Track)
    if genre:
        query = query.filter(Track.genre == genre)
    if artist:
        query = query.filter(Track.artist.ilike(f"%{artist}%"))
    
    result = await db.execute(query.order_by(Track.play_count.desc()).offset(skip).limit(limit))
    return result.scalars().all()


@router.get("/{track_id}", response_model=TrackResponse)
async def get_track(track_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Track).filter(Track.id == track_id))
    track = result.scalars().first()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    # Increment play count
    track.play_count += 1
    await db.commit()
    return track


@router.get("/{track_id}/stream")
async def stream_track(
    track_id: int,
    db: AsyncSession = Depends(get_db)
):
    """
    Stream audio file with proper headers for audio playback.
    Supports range requests for seeking.
    """
    from fastapi import Request
    from fastapi.responses import FileResponse, Response
    import mimetypes
    
    result = await db.execute(select(Track).filter(Track.id == track_id))
    track = result.scalars().first()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    
    # Get full file path - handle both absolute and relative paths
    if track.file_path.startswith('/'):
        # Absolute path in file_path
        file_path = MUSIC_DIR / Path(track.file_path).name
    else:
        # Relative path
        file_path = MUSIC_DIR / Path(track.file_path).name
    
    if not file_path.exists():
        # Try alternative path
        alt_path = MUSIC_DIR / track.file_path.replace('/music_files/', '')
        if alt_path.exists():
            file_path = alt_path
        else:
            raise HTTPException(
                status_code=404, 
                detail=f"Audio file not found. Looking for: {file_path}. Track file_path: {track.file_path}"
            )
    
    # Determine media type from file extension
    mime_type, _ = mimetypes.guess_type(str(file_path))
    if not mime_type or not mime_type.startswith('audio/'):
        # Default to audio/mpeg if can't determine
        mime_type = "audio/mpeg"
    
    # Return file with proper headers for audio streaming
    # FileResponse automatically handles Range requests
    return FileResponse(
        path=str(file_path),
        media_type=mime_type,
        headers={
            "Accept-Ranges": "bytes",
            "Content-Type": mime_type,
            "Cache-Control": "public, max-age=3600",
        }
    )


@router.post("/", response_model=TrackResponse, status_code=status.HTTP_201_CREATED)
async def create_track(
    track: TrackCreate,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db)
):
    db_track = Track(**track.dict())
    db.add(db_track)
    await db.commit()
    await db.refresh(db_track)
    return db_track


@router.post("/upload", response_model=TrackResponse, status_code=status.HTTP_201_CREATED)
async def upload_track(
    file: UploadFile = File(...),
    cover: Optional[UploadFile] = File(None),
    title: str = Form(...),
    artist: str = Form(...),
    album: Optional[str] = Form(None),
    genre: Optional[str] = Form(None),
    duration: Optional[int] = Form(None),
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Upload a music file and create a track record.
    """
    # Check file extension
    file_ext = Path(file.filename).suffix.lower()
    if file_ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"File type not allowed. Allowed types: {', '.join(ALLOWED_EXTENSIONS)}"
        )
    
    # Generate unique filename
    file_id = str(uuid.uuid4())
    filename = f"{file_id}{file_ext}"
    file_path = MUSIC_DIR / filename
    
    # Save file
    try:
        async with aiofiles.open(file_path, 'wb') as f:
            content = await file.read()
            await f.write(content)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to save file: {str(e)}"
        )
    
    # Calculate duration if not provided (basic estimation)
    # For production, use mutagen or similar library to extract real duration
    if duration is None:
        # Estimate: assume average bitrate, this is a placeholder
        # In production, use mutagen to get actual duration
        duration = 180  # Default 3 minutes
    
    # Save cover if provided
    cover_url = None
    if cover and cover.filename:
        cover_ext = Path(cover.filename).suffix.lower()
        if cover_ext not in ALLOWED_IMAGE_EXTENSIONS:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Cover type not allowed. Allowed types: {', '.join(ALLOWED_IMAGE_EXTENSIONS)}"
            )
        cover_filename = f"{file_id}.webp"
        cover_path = COVER_DIR / cover_filename
        try:
            content = await cover.read()
            compressed_content = await compress_image(content, max_size=(600, 600), format="WEBP", quality=80)
            async with aiofiles.open(cover_path, 'wb') as f:
                await f.write(compressed_content)
        except Exception as e:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Failed to save cover: {str(e)}"
            )
        cover_url = f"/cover_files/{cover_filename}"

    # Create track record
    relative_path = f"/music_files/{filename}"
    db_track = Track(
        title=title,
        artist=artist,
        album=album,
        genre=genre,
        duration=duration,
        file_path=relative_path,
        cover_url=cover_url
    )
    db.add(db_track)
    await db.commit()
    await db.refresh(db_track)
    
    return db_track


@router.post("/{track_id}/cover", response_model=TrackResponse)
async def upload_track_cover(
    track_id: int,
    cover: UploadFile = File(...),
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db)
):
    result = await db.execute(select(Track).filter(Track.id == track_id))
    track = result.scalars().first()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")

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
        compressed_content = await compress_image(content, max_size=(600, 600), format="WEBP", quality=80)
        async with aiofiles.open(cover_path, 'wb') as f:
            await f.write(compressed_content)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to save cover: {str(e)}"
        )

    track.cover_url = f"/cover_files/{cover_filename}"
    await db.commit()
    await db.refresh(track)
    return track


@router.post("/{track_id}/like", status_code=status.HTTP_200_OK)
async def like_track(
    track_id: int,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db)
):
    result = await db.execute(select(Track).filter(Track.id == track_id))
    track = result.scalars().first()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    
    # Check if already liked
    like_res = await db.execute(
        select(user_liked_tracks).filter(
            (user_liked_tracks.c.user_id == current_user.id) & 
            (user_liked_tracks.c.track_id == track_id)
        )
    )
    if like_res.first():
        raise HTTPException(status_code=400, detail="Track already liked")
    
    from sqlalchemy import insert
    await db.execute(insert(user_liked_tracks).values(user_id=current_user.id, track_id=track_id))
    await db.commit()
    return {"message": "Track liked successfully"}


@router.delete("/{track_id}/like", status_code=status.HTTP_200_OK)
async def unlike_track(
    track_id: int,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db)
):
    result = await db.execute(select(Track).filter(Track.id == track_id))
    track = result.scalars().first()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    
    # Check if liked
    like_res = await db.execute(
        select(user_liked_tracks).filter(
            (user_liked_tracks.c.user_id == current_user.id) & 
            (user_liked_tracks.c.track_id == track_id)
        )
    )
    if not like_res.first():
        raise HTTPException(status_code=400, detail="Track not liked")
    
    from sqlalchemy import delete
    await db.execute(delete(user_liked_tracks).where(
        (user_liked_tracks.c.user_id == current_user.id) & 
        (user_liked_tracks.c.track_id == track_id)
    ))
    await db.commit()
    return {"message": "Track unliked successfully"}


@router.get("/me/liked", response_model=List[TrackResponse])
async def get_liked_tracks(
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db)
):
    result = await db.execute(
        select(Track).join(user_liked_tracks).filter(user_liked_tracks.c.user_id == current_user.id)
    )
    return result.scalars().all()


@router.post("/{track_id}/play", status_code=status.HTTP_200_OK)
async def record_track_play(
    track_id: int,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db)
):
    """Record that a user played a track (for recommendations)"""
    result = await db.execute(select(Track).filter(Track.id == track_id))
    track = result.scalars().first()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    
    # Update or create play record
    from app.models import user_track_plays
    from sqlalchemy import update, insert
    
    stmt = (
        update(user_track_plays)
        .where(
            (user_track_plays.c.user_id == current_user.id) &
            (user_track_plays.c.track_id == track_id)
        )
        .values(play_count=user_track_plays.c.play_count + 1)
    )
    result = await db.execute(stmt)
    
    if result.rowcount == 0:
        # Insert new record
        stmt = insert(user_track_plays).values(
            user_id=current_user.id,
            track_id=track_id,
            play_count=1
        )
        await db.execute(stmt)
    
    await db.commit()
    return {"message": "Play recorded"}
