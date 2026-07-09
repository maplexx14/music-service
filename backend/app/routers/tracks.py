from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File, Form, Request
from sqlalchemy.orm import Session
from sqlalchemy import desc, func
from sqlalchemy.dialects.postgresql import insert as pg_insert
from typing import List, Optional
import logging
import os
import uuid
import aiofiles
from pathlib import Path
from mutagen import File as MutagenFile
from app.database import get_db
from app.models import Track, User, user_liked_tracks, user_track_plays, user_track_skips
from app.schemas import TrackResponse, TrackCreate, ExternalTrackImport
from app.dependencies import get_current_active_user, get_current_admin_user
from fastapi.responses import FileResponse, RedirectResponse
import mimetypes

logger = logging.getLogger(__name__)

router = APIRouter()

# Allowed audio file extensions
ALLOWED_EXTENSIONS = {'.mp3', '.wav', '.flac', '.m4a', '.ogg', '.aac'}
ALLOWED_IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp'}
MAX_AUDIO_SIZE = 50 * 1024 * 1024  # 50 MB
MAX_COVER_SIZE = 5 * 1024 * 1024   # 5 MB
UPLOAD_CHUNK_SIZE = 1024 * 1024


async def save_upload(upload: UploadFile, dest: Path, max_size: int, kind: str) -> None:
    """Stream an upload to disk in chunks, enforcing a size limit."""
    written = 0
    try:
        async with aiofiles.open(dest, 'wb') as f:
            while chunk := await upload.read(UPLOAD_CHUNK_SIZE):
                written += len(chunk)
                if written > max_size:
                    raise HTTPException(
                        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        detail=f"{kind} file too large (max {max_size // (1024 * 1024)} MB)"
                    )
                await f.write(chunk)
    except HTTPException:
        dest.unlink(missing_ok=True)
        raise
    except Exception:
        dest.unlink(missing_ok=True)
        logger.exception("Failed to save %s file", kind)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to save {kind} file"
        )
# Use environment variable or default path
MUSIC_DIR = Path(os.getenv("MUSIC_FILES_DIR", os.path.join(os.path.dirname(__file__), "..", "..", "music_files")))
COVER_DIR = Path(os.getenv("COVER_FILES_DIR", os.path.join(os.path.dirname(__file__), "..", "..", "cover_files")))
MUSIC_DIR.mkdir(parents=True, exist_ok=True)
COVER_DIR.mkdir(parents=True, exist_ok=True)


@router.get("/", response_model=List[TrackResponse])
def get_tracks(
    skip: int = 0,
    limit: int = 100,
    genre: Optional[str] = None,
    artist: Optional[str] = None,
    db: Session = Depends(get_db)
):
    query = db.query(Track)
    if genre:
        query = query.filter(Track.genre == genre)
    if artist:
        query = query.filter(Track.artist.ilike(f"%{artist}%"))
    tracks = query.order_by(Track.play_count.desc()).offset(skip).limit(limit).all()
    return tracks


@router.get("/{track_id}", response_model=TrackResponse)
def get_track(track_id: int, db: Session = Depends(get_db)):
    track = db.query(Track).filter(Track.id == track_id).first()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    # Increment play count
    track.play_count += 1
    db.commit()
    return track


# Реконструкция прокси-URL провайдера по источнику материализованного трека.
EXTERNAL_STREAM_PREFIX = {
    "soulseek": "/api/soulseek/stream/",
    "ytmusic": "/api/ytdlp/stream/",
}


@router.get("/{track_id}/stream")
def stream_track(
    track_id: int,
    db: Session = Depends(get_db)
):
    """
    Stream audio file with proper headers for audio playback.
    Supports range requests for seeking.
    """
    # смотрим по базе данных
    track = db.query(Track).filter(Track.id == track_id).first()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")

    # Внешний трек — проксируем на эндпоинт провайдера (yt-dlp / slskd).
    if track.source and track.source != "local":
        prefix = EXTERNAL_STREAM_PREFIX.get(track.source)
        if prefix and track.external_id:
            return RedirectResponse(url=f"{prefix}{track.external_id}", status_code=307)
        if track.stream_url:
            return RedirectResponse(url=track.stream_url, status_code=307)
        raise HTTPException(status_code=404, detail="External stream unavailable")

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
            logger.error("Audio file not found for track %s: %s", track_id, file_path)
            raise HTTPException(status_code=404, detail="Audio file not found")
    
    # чек типа файла
    # если не аудио, то преобразовываем(хуйня на самом деле)
    mime_type, _ = mimetypes.guess_type(str(file_path))
    if not mime_type or not mime_type.startswith('audio/'):
        mime_type = "audio/mpeg"
    
    # тут отдает файл с музыкой
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
def create_track(
    track: TrackCreate,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    db_track = Track(**track.dict())
    db.add(db_track)
    db.commit()
    db.refresh(db_track)
    return db_track


def get_or_create_external_track(db: Session, payload: ExternalTrackImport) -> Track:
    """Идемпотентно апсертит внешний трек по (source, external_id)."""
    track = (
        db.query(Track)
        .filter(Track.source == payload.source, Track.external_id == payload.external_id)
        .first()
    )
    if track:
        return track

    track = Track(
        title=payload.title,
        artist=payload.artist,
        album=payload.album,
        duration=payload.duration or 0,
        file_path=None,
        cover_url=payload.cover_url,
        source=payload.source,
        external_id=payload.external_id,
        stream_url=payload.stream_url,
    )
    db.add(track)
    try:
        db.commit()
    except Exception:
        # Гонка: параллельный запрос уже создал запись — берём её.
        db.rollback()
        track = (
            db.query(Track)
            .filter(Track.source == payload.source, Track.external_id == payload.external_id)
            .first()
        )
        if track is None:
            raise
        return track
    db.refresh(track)
    return track


@router.post("/import", response_model=TrackResponse)
def import_external_track(
    payload: ExternalTrackImport,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db),
):
    """Материализует внешний трек в БД, возвращает локальную запись (int id)."""
    if payload.source == "local":
        raise HTTPException(status_code=400, detail="Нельзя импортировать локальный трек")
    return get_or_create_external_track(db, payload)


@router.post("/upload", response_model=TrackResponse, status_code=status.HTTP_201_CREATED)
async def upload_track(
    file: UploadFile = File(...),
    cover: Optional[UploadFile] = File(None),
    title: str = Form(...),
    artist: str = Form(...),
    album: Optional[str] = Form(None),
    genre: Optional[str] = Form(None),
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
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
    
    await save_upload(file, file_path, MAX_AUDIO_SIZE, "audio")

    # Validate content and extract real duration with mutagen
    try:
        audio = MutagenFile(str(file_path))
    except Exception:
        audio = None
    if audio is None or audio.info is None:
        file_path.unlink(missing_ok=True)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File is not a valid audio file"
        )
    duration = int(audio.info.length)
    
    # Save cover if provided
    cover_url = None
    if cover and cover.filename:
        cover_ext = Path(cover.filename).suffix.lower()
        if cover_ext not in ALLOWED_IMAGE_EXTENSIONS:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Cover type not allowed. Allowed types: {', '.join(ALLOWED_IMAGE_EXTENSIONS)}"
            )
        cover_filename = f"{file_id}{cover_ext}"
        cover_path = COVER_DIR / cover_filename
        await save_upload(cover, cover_path, MAX_COVER_SIZE, "cover")
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
    db.commit()
    db.refresh(db_track)
    
    return db_track


@router.post("/{track_id}/cover", response_model=TrackResponse)
async def upload_track_cover(
    track_id: int,
    cover: UploadFile = File(...),
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    track = db.query(Track).filter(Track.id == track_id).first()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")

    cover_ext = Path(cover.filename).suffix.lower()
    if cover_ext not in ALLOWED_IMAGE_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cover type not allowed. Allowed types: {', '.join(ALLOWED_IMAGE_EXTENSIONS)}"
        )

    cover_filename = f"{uuid.uuid4()}{cover_ext}"
    cover_path = COVER_DIR / cover_filename
    await save_upload(cover, cover_path, MAX_COVER_SIZE, "cover")

    track.cover_url = f"/cover_files/{cover_filename}"
    db.commit()
    db.refresh(track)
    return track


@router.post("/{track_id}/like", status_code=status.HTTP_200_OK)
def like_track(
    track_id: int,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    track = db.query(Track).filter(Track.id == track_id).first()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    
    # Check if already liked
    if track in current_user.liked_tracks:
        raise HTTPException(status_code=400, detail="Track already liked")
    
    current_user.liked_tracks.append(track)
    db.commit()
    return {"message": "Track liked successfully"}


@router.delete("/{track_id}/like", status_code=status.HTTP_200_OK)
def unlike_track(
    track_id: int,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    track = db.query(Track).filter(Track.id == track_id).first()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    
    if track not in current_user.liked_tracks:
        raise HTTPException(status_code=400, detail="Track not liked")
    
    current_user.liked_tracks.remove(track)
    db.commit()
    return {"message": "Track unliked successfully"}


@router.get("/me/liked", response_model=List[TrackResponse])
def get_liked_tracks(
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    return current_user.liked_tracks


@router.get("/me/history", response_model=List[TrackResponse])
def get_listening_history(
    limit: int = 50,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    history = (
        db.query(Track)
        .join(user_track_plays, Track.id == user_track_plays.c.track_id)
        .filter(user_track_plays.c.user_id == current_user.id)
        .order_by(desc(user_track_plays.c.last_played))
        .limit(limit)
        .all()
    )
    return history


from sqlalchemy.exc import IntegrityError

@router.post("/{track_id}/play", status_code=status.HTTP_200_OK)
def record_track_play(
    track_id: int,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    """Record that a user played a track (for recommendations)"""
    
    # Сразу собираем атомарный UPSERT
    stmt = pg_insert(user_track_plays).values(
        user_id=current_user.id,
        track_id=track_id,
        play_count=1,
        last_played=func.now(),
    ).on_conflict_do_update(
        index_elements=[user_track_plays.c.user_id, user_track_plays.c.track_id],
        set_={
            "play_count": user_track_plays.c.play_count + 1,
            "last_played": func.now(),
        },
    )
    
    try:
        db.execute(stmt)
        db.commit()
    except IntegrityError as e:
        db.rollback()
        # Если сработал Foreign Key на track_id (трека нет в базе)
        if "track_id" in str(e.orig):
            raise HTTPException(status_code=404, detail="Track not found")
        raise HTTPException(status_code=400, detail="Database integrity error")
        
    return {"message": "Play recorded"}



@router.post("/{track_id}/skip")
def record_track_skip(
    track_id: int,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    """Скип трека (прослушано <25%) — негативный сигнал для рекомендаций.

    Порог контролирует фронт: он вызывает эндпоинт только когда переключили,
    прослушав меньше четверти трека.
    """
    track = db.query(Track).filter(Track.id == track_id).first()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")

    # Атомарный upsert — как и в /play, защищает от гонки параллельных запросов.
    stmt = pg_insert(user_track_skips).values(
        user_id=current_user.id,
        track_id=track_id,
        skip_count=1,
        last_skipped=func.now(),
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=[user_track_skips.c.user_id, user_track_skips.c.track_id],
        set_={
            "skip_count": user_track_skips.c.skip_count + 1,
            "last_skipped": func.now(),
        },
    )
    db.execute(stmt)
    db.commit()
    return {"message": "Skip recorded"}


@router.delete("/{track_id}", status_code=status.HTTP_200_OK)
def delete_track(
    track_id: int,
    current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db)
):
    track = db.query(Track).filter(Track.id == track_id).first()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")

    file_path = track.file_path
    cover_path = track.cover_url

    db.delete(track)
    db.commit()

    def safe_remove(path_value: Optional[str], base_dir: Path) -> None:
        if not path_value:
            return
        filename = Path(path_value).name
        if not filename:
            return
        target = base_dir / filename
        if target.exists():
            try:
                target.unlink()
            except OSError:
                pass

    safe_remove(file_path, MUSIC_DIR)
    safe_remove(cover_path, COVER_DIR)

    return {"message": "Track deleted"}
