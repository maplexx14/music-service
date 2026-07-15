from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File, Form, Request, Response, Query
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
from app.cache import get_cache, set_cache, clear_pattern
from app.models import Track, User, Playlist, playlist_tracks, user_track_plays, user_track_skips, user_play_events, rec_impressions
from app.schemas import TrackResponse, TrackCreate, ExternalTrackImport
from pydantic import BaseModel, Field
from app.dependencies import get_current_active_user, get_current_admin_user
from fastapi.responses import RedirectResponse, StreamingResponse
from starlette.background import BackgroundTask
from app import storage
from app import external_archive
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
    # Первая страница без фильтров — самый горячий запрос (главная у всех
    # пользователей одна и та же) — короткий Redis-кэш.
    cache_key = None
    if not genre and not artist and skip == 0:
        cache_key = f"tracks:popular:{limit}"
        cached = get_cache(cache_key)
        if cached is not None:
            return [TrackResponse(**t) for t in cached]

    query = db.query(Track)
    if genre:
        query = query.filter(Track.genre == genre)
    if artist:
        query = query.filter(Track.artist.ilike(f"%{artist}%"))
    tracks = query.order_by(Track.play_count.desc()).offset(skip).limit(limit).all()
    if cache_key:
        set_cache(
            cache_key,
            [TrackResponse.model_validate(t).model_dump(mode="json") for t in tracks],
            expire=120,
        )
    return tracks


@router.get("/{track_id}", response_model=TrackResponse)
def get_track(track_id: int, db: Session = Depends(get_db)):
    track = db.query(Track).filter(Track.id == track_id).first()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    # Счётчик прослушиваний инкрементирует POST /{id}/play, а не чтение
    # метаданных: запись + коммит на каждом GET брали row lock и
    # сериализовали параллельных читателей популярного трека.
    return track


# Реконструкция прокси-URL провайдера по источнику материализованного трека.
EXTERNAL_STREAM_PREFIX = {
    "soulseek": "/api/soulseek/stream/",
    "ytmusic": "/api/ytdlp/stream/",
}


def iter_file_range(file_path: Path, start: int, end: int, chunk_size: int = 256 * 1024):
    """Yield exactly the requested inclusive byte range without loading the file."""
    remaining = end - start + 1
    with file_path.open("rb") as audio_file:
        audio_file.seek(start)
        while remaining > 0:
            chunk = audio_file.read(min(chunk_size, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


@router.get("/{track_id}/stream")
def stream_track(
    track_id: int,
    request: Request,
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

    # Заархивированный трек (в т.ч. изначально внешний ytmusic/soundcloud) лежит в
    # объектном хранилище. Проксируем его через бэкенд (тот же origin/https,
    # что и приложение), А НЕ редиректом на MINIO_PUBLIC_ENDPOINT: за https-
    # туннелем прямой http://<minio>:9000 блокируется как mixed content, а
    # localhost с другого устройства указывает на сам клиент. Внутренний клиент
    # (minio:9000) доступен из контейнера всегда. Range поддерживаем вручную.
    if storage.is_minio_path(track.file_path):
        file_size, mime_type = storage.stat_music_object(track.file_path)
        range_header = request.headers.get("range")
        common_headers = {
            "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=3600",
        }
        if range_header:
            try:
                unit, raw_range = range_header.strip().split("=", 1)
                if unit.lower() != "bytes" or "," in raw_range:
                    raise ValueError
                raw_start, raw_end = raw_range.split("-", 1)
                if raw_start:
                    start = int(raw_start)
                    end = int(raw_end) if raw_end else file_size - 1
                else:
                    suffix_length = int(raw_end)
                    if suffix_length <= 0:
                        raise ValueError
                    start = max(file_size - suffix_length, 0)
                    end = file_size - 1
                if start < 0 or start >= file_size or end < start:
                    raise ValueError
                end = min(end, file_size - 1)
            except (ValueError, TypeError):
                return Response(
                    status_code=status.HTTP_416_REQUESTED_RANGE_NOT_SATISFIABLE,
                    headers={**common_headers, "Content-Range": f"bytes */{file_size}"},
                )
            content_length = end - start + 1
            return StreamingResponse(
                storage.iter_music_object(track.file_path, offset=start, length=content_length),
                status_code=status.HTTP_206_PARTIAL_CONTENT,
                media_type=mime_type,
                headers={
                    **common_headers,
                    "Content-Range": f"bytes {start}-{end}/{file_size}",
                    "Content-Length": str(content_length),
                },
            )
        return StreamingResponse(
            storage.iter_music_object(track.file_path),
            media_type=mime_type,
            headers={**common_headers, "Content-Length": str(file_size)},
        )

    # Внешний трек — проксируем на эндпоинт провайдера (yt-dlp / slskd).
    if track.source and track.source != "local":
        # Ленивое кэширование: при прослушивании ytmusic/soundcloud фоном
        # скачиваем трек в MinIO. На следующих запросах верхняя проверка
        # is_minio_path отдаст его напрямую из MinIO. Дедуп и лимит
        # параллельности — внутри schedule_archive; ошибки не ломают стрим.
        archive_bg = None
        if track.source in external_archive.ARCHIVABLE_SOURCES:
            archive_bg = BackgroundTask(external_archive.schedule_archive, track.id)

        prefix = EXTERNAL_STREAM_PREFIX.get(track.source)
        if prefix and track.external_id:
            return RedirectResponse(
                url=f"{prefix}{track.external_id}", status_code=307, background=archive_bg
            )
        if track.stream_url:
            # stream_url мог быть сохранён с абсолютным (старым) хостом — при
            # переносе деплоя/смене туннеля он протухает. Если это наш же прокси
            # (…/api/…), редиректим на относительный путь: он разрешится против
            # текущего хоста. Прямой CDN-URL провайдера (напр. jamendo) — как есть.
            url = track.stream_url
            api_idx = url.find("/api/")
            if api_idx > 0 and "://" in url[:api_idx]:
                url = url[api_idx:]
            return RedirectResponse(url=url, status_code=307, background=archive_bg)
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
    
    # iOS активирует системный scrubber только если сам медиаресурс честно
    # отвечает 206 на byte-range запросы. Одного Accept-Ranges недостаточно.
    file_size = file_path.stat().st_size
    range_header = request.headers.get("range")
    common_headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=3600",
    }

    if range_header:
        try:
            unit, raw_range = range_header.strip().split("=", 1)
            if unit.lower() != "bytes" or "," in raw_range:
                raise ValueError
            raw_start, raw_end = raw_range.split("-", 1)

            if raw_start:
                start = int(raw_start)
                end = int(raw_end) if raw_end else file_size - 1
            else:
                suffix_length = int(raw_end)
                if suffix_length <= 0:
                    raise ValueError
                start = max(file_size - suffix_length, 0)
                end = file_size - 1

            if start < 0 or start >= file_size or end < start:
                raise ValueError
            end = min(end, file_size - 1)
        except (ValueError, TypeError):
            return Response(
                status_code=status.HTTP_416_REQUESTED_RANGE_NOT_SATISFIABLE,
                headers={**common_headers, "Content-Range": f"bytes */{file_size}"},
            )

        content_length = end - start + 1
        return StreamingResponse(
            iter_file_range(file_path, start, end),
            status_code=status.HTTP_206_PARTIAL_CONTENT,
            media_type=mime_type,
            headers={
                **common_headers,
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Content-Length": str(content_length),
            },
        )

    return StreamingResponse(
        iter_file_range(file_path, 0, file_size - 1),
        media_type=mime_type,
        headers={**common_headers, "Content-Length": str(file_size)},
    )


@router.get("/cover/{key:path}")
def stream_cover(key: str):
    """Отдаёт обложку из MinIO через бэкенд-прокси (тот же origin, что и app).

    Нужно, чтобы за https-туннелем обложки не ломались как mixed content
    и были доступны с любых устройств (а не только с localhost).
    """
    if not storage.is_minio_backend():
        raise HTTPException(status_code=404, detail="Cover not found")
    try:
        stream, content_type, size = storage.open_cover_object(key)
    except Exception:
        raise HTTPException(status_code=404, detail="Cover not found")
    return StreamingResponse(
        stream,
        media_type=content_type,
        headers={
            "Content-Length": str(size),
            "Cache-Control": "public, max-age=86400",
        },
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
        genre=payload.genre,
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
    cover_path = None
    cover_filename = None
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

    relative_path = f"/music_files/{filename}"

    # Режим minio: файлы уже лежат на диске (нужны были для mutagen-
    # валидации) — заливаем их в объектное хранилище и удаляем локальные
    # копии. В БД уйдёт minio://… для аудио и прямой URL для обложки.
    if storage.is_minio_backend():
        audio_mime, _ = mimetypes.guess_type(str(file_path))
        relative_path = storage.upload_music_file(
            str(file_path), filename, audio_mime or "audio/mpeg"
        )
        file_path.unlink(missing_ok=True)
        if cover_path is not None:
            cover_mime, _ = mimetypes.guess_type(str(cover_path))
            cover_url = storage.upload_cover_file(
                str(cover_path), cover_filename, cover_mime or "image/jpeg"
            )
            cover_path.unlink(missing_ok=True)

    # Create track record
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

    if storage.is_minio_backend():
        # Старая обложка могла лежать в MinIO — чистим её, чтобы не копить сирот.
        storage.remove_cover_url(track.cover_url)
        cover_mime, _ = mimetypes.guess_type(str(cover_path))
        track.cover_url = storage.upload_cover_file(
            str(cover_path), cover_filename, cover_mime or "image/jpeg"
        )
        cover_path.unlink(missing_ok=True)
    else:
        track.cover_url = f"/cover_files/{cover_filename}"
    db.commit()
    db.refresh(track)
    return track


def get_or_create_liked_playlist(db: Session, user: User) -> Playlist:
    playlist = db.query(Playlist).filter(
        Playlist.owner_id == user.id, Playlist.is_liked == True
    ).first()
    if playlist is None:
        playlist = Playlist(
            name="Понравившиеся",
            is_public=False,
            is_liked=True,
            owner_id=user.id,
        )
        db.add(playlist)
        db.commit()
        db.refresh(playlist)
    return playlist


@router.post("/{track_id}/like", status_code=status.HTTP_200_OK)
def like_track(
    track_id: int,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    track = db.query(Track).filter(Track.id == track_id).first()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")

    liked_playlist = get_or_create_liked_playlist(db, current_user)

    exists = db.query(playlist_tracks).filter(
        playlist_tracks.c.playlist_id == liked_playlist.id,
        playlist_tracks.c.track_id == track_id,
    ).first()
    if exists:
        raise HTTPException(status_code=400, detail="Track already liked")

    max_position = db.query(func.max(playlist_tracks.c.position)).filter(
        playlist_tracks.c.playlist_id == liked_playlist.id
    ).scalar() or -1
    db.execute(playlist_tracks.insert().values(
        playlist_id=liked_playlist.id,
        track_id=track_id,
        position=max_position + 1,
    ))
    db.commit()
    # Лайк — сильный явный сигнал: сбрасываем кэш рекомендаций сразу, а не
    # ждём истечения TTL (иначе юзер лайкает и 5 минут видит старую выдачу).
    clear_pattern(f"recs:{current_user.id}:*")
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

    liked_playlist = get_or_create_liked_playlist(db, current_user)

    exists = db.query(playlist_tracks).filter(
        playlist_tracks.c.playlist_id == liked_playlist.id,
        playlist_tracks.c.track_id == track_id,
    ).first()
    if not exists:
        raise HTTPException(status_code=400, detail="Track not liked")

    db.execute(playlist_tracks.delete().where(
        (playlist_tracks.c.playlist_id == liked_playlist.id) &
        (playlist_tracks.c.track_id == track_id)
    ))
    db.commit()
    # Явное действие — инвалидируем кэш рекомендаций (см. like_track).
    clear_pattern(f"recs:{current_user.id}:*")
    return {"message": "Track unliked successfully"}


@router.get("/me/liked", response_model=List[TrackResponse])
def get_liked_tracks(
    response: Response,
    skip: int = Query(0, ge=0),
    limit: Optional[int] = Query(None, ge=1, le=100),
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    # Свежие лайки первыми; без limit возвращаем весь список (нужен playerStore).
    liked_playlist = get_or_create_liked_playlist(db, current_user)
    query = (
        db.query(Track)
        .join(playlist_tracks, playlist_tracks.c.track_id == Track.id)
        .filter(playlist_tracks.c.playlist_id == liked_playlist.id)
        .order_by(desc(playlist_tracks.c.position))
    )
    response.headers["X-Total-Count"] = str(query.count())
    if limit is not None:
        query = query.offset(skip).limit(limit)
    return query.all()


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

    # Глобальный счётчик популярности живёт здесь (раньше — на GET /{id}, т.е.
    # write-on-read). Атомарный UPDATE без загрузки строки; 0 строк = трека нет,
    # это заодно даёт честный 404 до upsert'а в user_track_plays.
    updated = (
        db.query(Track)
        .filter(Track.id == track_id)
        .update({Track.play_count: Track.play_count + 1}, synchronize_session=False)
    )
    if not updated:
        db.rollback()
        raise HTTPException(status_code=404, detail="Track not found")

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
        # Сыгранный трек больше не «непринятая рекомендация» — сбрасываем его
        # счётчик показов, чтобы он не ушёл в impression-fatigue (см.
        # recommendations.py) из-за показов ДО того, как юзер его послушал.
        db.execute(
            rec_impressions.delete().where(
                (rec_impressions.c.user_id == current_user.id)
                & (rec_impressions.c.track_id == track_id)
            )
        )
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
    # Скип — явный негативный сигнал: кэш рекомендаций сбрасываем сразу.
    clear_pattern(f"recs:{current_user.id}:*")
    return {"message": "Skip recorded"}


class ListenEventPayload(BaseModel):
    # Финальная доля прослушивания трека (0..1) на момент переключения/конца.
    completion: float = Field(..., ge=0.0, le=1.0)
    # Локальный час клиента 0-23 — таймзона юзера серверу неизвестна.
    client_hour: Optional[int] = Field(None, ge=0, le=23)


@router.post("/{track_id}/listen", status_code=status.HTTP_200_OK)
def record_listen_event(
    track_id: int,
    payload: ListenEventPayload,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    """Событие прослушивания с финальной долей дослушивания.

    Фронт шлёт его при КАЖДОМ уходе с трека (переключение/естественный
    конец), в отличие от /play (порог >=50%) и /skip (<25%): зона 25-50%
    иначе не видна рекомендациям вовсе. Лог питает completion-веса и
    контекст времени суток (см. recommendations.py)."""
    exists = db.query(Track.id).filter(Track.id == track_id).scalar()
    if not exists:
        raise HTTPException(status_code=404, detail="Track not found")

    db.execute(
        user_play_events.insert().values(
            user_id=current_user.id,
            track_id=track_id,
            completion=payload.completion,
            client_hour=payload.client_hour,
        )
    )
    db.commit()
    return {"message": "Listen recorded"}


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

    # Аудио и обложка могут быть как на диске, так и в MinIO (гибрид) —
    # чистим по типу пути, а не по текущему backend.
    if storage.is_minio_path(file_path):
        storage.remove_object_path(file_path)
    else:
        safe_remove(file_path, MUSIC_DIR)

    if cover_path and "://" in cover_path:
        storage.remove_cover_url(cover_path)
    else:
        safe_remove(cover_path, COVER_DIR)

    return {"message": "Track deleted"}
