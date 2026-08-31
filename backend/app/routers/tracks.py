from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File, Form, Request, Response, Query
from sqlalchemy.orm import Session
from sqlalchemy import desc, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from typing import List, Optional
import logging
import os
import uuid
import json
import shutil
import aiofiles
from pathlib import Path
from mutagen import File as MutagenFile
from app.database import get_db
from app.cache import get_cache, set_cache
from app.recommendation_cache import invalidate_recommendation_cache
from app.recommendation_telemetry import link_materialized_deliveries
from app.models import Track, User, Playlist, playlist_tracks, user_track_plays, user_track_skips, user_play_events, rec_impressions
from app.schemas import TrackResponse, TrackCreate, ExternalTrackImport
from pydantic import BaseModel, Field
from app.dependencies import get_current_active_user, get_current_admin_user
from fastapi.responses import RedirectResponse, StreamingResponse
from starlette.background import BackgroundTask
from app import storage
from app import external_archive
import mimetypes
import asyncio
from datetime import datetime, timezone
from app.transcode import transcode_to_aac, AAC_EXT, AAC_CONTENT_TYPE
from app.acoustic_features import ANALYZER_VERSION, analyze_file

logger = logging.getLogger(__name__)

router = APIRouter()


def _dialect_insert(db: Session, table):
    if db.get_bind().dialect.name == "sqlite":
        return sqlite_insert(table)
    return pg_insert(table)

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
CHUNKED_UPLOAD_DIR = MUSIC_DIR / "_uploads"
CHUNKED_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


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


async def iter_file_range(file_path: Path, start: int, end: int, chunk_size: int = 256 * 1024):
    """Yield exactly the requested inclusive byte range without loading the file.

    Async (aiofiles), не держит OS-тред на всю длительность стрима — см. план
    async-переделки для 10k конкурентных слушателей.
    """
    remaining = end - start + 1
    async with aiofiles.open(file_path, "rb") as audio_file:
        await audio_file.seek(start)
        while remaining > 0:
            chunk = await audio_file.read(min(chunk_size, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


@router.get("/{track_id}/stream")
async def stream_track(
    track_id: int,
    request: Request,
    db: Session = Depends(get_db)
):
    """
    Stream audio file with proper headers for audio playback.
    Supports range requests for seeking.
    """
    # смотрим по базе данных. Хендлер async (дальше async-стриминг из MinIO),
    # поэтому sync-запрос уходит в тредпул: блокирующий SQLAlchemy в event
    # loop подвешивал ВСЕ запросы на время каждого lookup'а (см. рекомендации —
    # там тот же приём с run_in_executor).
    track = await asyncio.to_thread(
        db.query(Track).filter(Track.id == track_id).first
    )
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")

    # Заархивированный трек (в т.ч. изначально внешний ytmusic/soundcloud) лежит в
    # объектном хранилище. Проксируем его через бэкенд (тот же origin/https,
    # что и приложение), А НЕ редиректом на MINIO_PUBLIC_ENDPOINT: за https-
    # туннелем прямой http://<minio>:9000 блокируется как mixed content, а
    # localhost с другого устройства указывает на сам клиент. Внутренний клиент
    # (minio:9000) доступен из контейнера всегда. Range поддерживаем вручную.
    if storage.is_minio_path(track.file_path):
        return await storage.minio_range_response_async(track.file_path, request)

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
        "Cache-Control": "public, max-age=604800, immutable",
        "Vary": "Accept-Encoding",
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
async def stream_cover(key: str):
    """Отдаёт обложку из MinIO через бэкенд-прокси (тот же origin, что и app).

    Нужно, чтобы за https-туннелем обложки не ломались как mixed content
    и были доступны с любых устройств (а не только с localhost).
    """
    if not storage.is_minio_backend():
        raise HTTPException(status_code=404, detail="Cover not found")
    try:
        stream, content_type, size = await storage.open_cover_object_async(key)
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


def _link_archived_object(db: Session, track: Track) -> None:
    """Если внешний трек уже был заархивирован в MinIO лениво (игрался из
    поиска/потока без DB-записи) — привязываем объект к только что
    созданной записи, чтобы /tracks/{id}/stream отдавал его прямо из MinIO."""
    if not storage.is_minio_backend():
        return
    if storage.is_minio_path(track.file_path) or track.source not in ("ytmusic", "soundcloud"):
        return
    if not track.external_id:
        return
    file_path = storage.find_music_object(f"external/{track.source}/{track.external_id}")
    if file_path:
        track.file_path = file_path
        acoustic_features = get_cache(
            f"archive:acoustic:{track.source}/{track.external_id}"
        )
        if acoustic_features:
            track.acoustic_features = acoustic_features
            track.acoustic_analyzed_at = datetime.now(timezone.utc)
            track.acoustic_analyzer_version = ANALYZER_VERSION
        db.commit()


def get_or_create_external_track(db: Session, payload: ExternalTrackImport) -> Track:
    """Идемпотентно апсертит внешний трек по (source, external_id)."""
    track = (
        db.query(Track)
        .filter(Track.source == payload.source, Track.external_id == payload.external_id)
        .first()
    )
    if track:
        _link_archived_object(db, track)
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
    else:
        db.refresh(track)
    _link_archived_object(db, track)
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
    track = get_or_create_external_track(db, payload)
    link_materialized_deliveries(
        db,
        user_id=current_user.id,
        source=payload.source,
        external_id=payload.external_id,
        track_id=track.id,
    )
    db.commit()
    return track


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

    # Transcode to AAC for smaller, faster-loading files
    aac_path = transcode_to_aac(str(file_path))
    if aac_path != str(file_path):
        # Transcoded successfully — replace original with AAC version
        file_path.unlink(missing_ok=True)
        file_path = Path(aac_path)
        file_ext = AAC_EXT
        filename = f"{file_id}{file_ext}"

    # Analyze the final audio representation before it is optionally uploaded
    # to MinIO and the temporary local file is removed.
    acoustic_features = await asyncio.to_thread(analyze_file, file_path)

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
        # Use AAC content type for transcoded files
        if file_ext == AAC_EXT:
            audio_mime = AAC_CONTENT_TYPE
        relative_path = storage.upload_music_file(
            str(file_path), filename, audio_mime or "audio/mp4"
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
        cover_url=cover_url,
        acoustic_features=acoustic_features,
        acoustic_analyzed_at=(
            datetime.now(timezone.utc) if acoustic_features else None
        ),
        acoustic_analyzer_version=ANALYZER_VERSION if acoustic_features else None,
    )
    db.add(db_track)
    db.commit()
    db.refresh(db_track)
    
    return db_track


# ─────────────── chunked upload ───────────────

DEFAULT_CHUNK_SIZE = 512 * 1024  # 512 KB


class ChunkedUploadInit(BaseModel):
    filename: str
    file_size: int = Field(gt=0)
    chunk_size: int = Field(default=DEFAULT_CHUNK_SIZE, gt=0)


class ChunkedUploadInitResponse(BaseModel):
    upload_id: str
    chunk_size: int
    total_chunks: int


class ChunkedUploadComplete(BaseModel):
    upload_id: str
    title: str
    artist: str
    album: Optional[str] = None
    genre: Optional[str] = None


@router.post("/upload/init", response_model=ChunkedUploadInitResponse)
async def init_chunked_upload(
    payload: ChunkedUploadInit,
    current_user: User = Depends(get_current_active_user),
):
    file_ext = Path(payload.filename).suffix.lower()
    if file_ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"File type not allowed. Allowed types: {', '.join(ALLOWED_EXTENSIONS)}"
        )
    if payload.file_size > MAX_AUDIO_SIZE:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File too large (max {MAX_AUDIO_SIZE // (1024 * 1024)} MB)"
        )

    upload_id = str(uuid.uuid4())
    upload_dir = CHUNKED_UPLOAD_DIR / upload_id
    upload_dir.mkdir(parents=True, exist_ok=True)

    total_chunks = (payload.file_size + payload.chunk_size - 1) // payload.chunk_size

    meta = {
        "upload_id": upload_id,
        "filename": payload.filename,
        "file_ext": file_ext,
        "file_size": payload.file_size,
        "chunk_size": payload.chunk_size,
        "total_chunks": total_chunks,
        "received_chunks": [],
    }
    (upload_dir / "meta.json").write_text(json.dumps(meta))

    return ChunkedUploadInitResponse(
        upload_id=upload_id,
        chunk_size=payload.chunk_size,
        total_chunks=total_chunks,
    )


@router.post("/upload/chunk")
async def upload_chunk(
    upload_id: str = Form(...),
    chunk_index: int = Form(...),
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_active_user),
):
    upload_dir = CHUNKED_UPLOAD_DIR / upload_id
    meta_path = upload_dir / "meta.json"
    if not meta_path.exists():
        raise HTTPException(status_code=404, detail="Upload session not found")

    meta = json.loads(meta_path.read_text())

    if chunk_index < 0 or chunk_index >= meta["total_chunks"]:
        raise HTTPException(status_code=400, detail="Invalid chunk index")

    chunk_path = upload_dir / f"chunk_{chunk_index:06d}"
    await save_upload(file, chunk_path, meta["chunk_size"] + 1024, "chunk")

    if chunk_index not in meta["received_chunks"]:
        meta["received_chunks"].append(chunk_index)
        meta_path.write_text(json.dumps(meta))

    return {"chunk_index": chunk_index, "received": len(meta["received_chunks"])}


@router.get("/upload/status/{upload_id}")
async def chunked_upload_status(
    upload_id: str,
    current_user: User = Depends(get_current_active_user),
):
    upload_dir = CHUNKED_UPLOAD_DIR / upload_id
    meta_path = upload_dir / "meta.json"
    if not meta_path.exists():
        raise HTTPException(status_code=404, detail="Upload session not found")

    meta = json.loads(meta_path.read_text())
    return {
        "upload_id": upload_id,
        "filename": meta["filename"],
        "total_chunks": meta["total_chunks"],
        "received_chunks": meta["received_chunks"],
    }


@router.post("/upload/complete", response_model=TrackResponse, status_code=status.HTTP_201_CREATED)
async def complete_chunked_upload(
    payload: ChunkedUploadComplete,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db),
):
    upload_dir = CHUNKED_UPLOAD_DIR / payload.upload_id
    meta_path = upload_dir / "meta.json"
    if not meta_path.exists():
        raise HTTPException(status_code=404, detail="Upload session not found")

    meta = json.loads(meta_path.read_text())
    total_chunks = meta["total_chunks"]
    received = sorted(meta["received_chunks"])

    if len(received) != total_chunks:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Incomplete upload: {len(received)}/{total_chunks} chunks received"
        )

    file_ext = meta["file_ext"]
    file_id = str(uuid.uuid4())
    filename = f"{file_id}{file_ext}"
    assembled_path = MUSIC_DIR / filename

    # Assemble chunks into final file
    try:
        with open(assembled_path, "wb") as out:
            for i in range(total_chunks):
                chunk_path = upload_dir / f"chunk_{i:06d}"
                if not chunk_path.exists():
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=f"Missing chunk {i}"
                    )
                with open(chunk_path, "rb") as cf:
                    shutil.copyfileobj(cf, out)
    finally:
        shutil.rmtree(upload_dir, ignore_errors=True)

    # Validate with mutagen
    try:
        audio = MutagenFile(str(assembled_path))
    except Exception:
        audio = None
    if audio is None or audio.info is None:
        assembled_path.unlink(missing_ok=True)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File is not a valid audio file"
        )
    duration = int(audio.info.length)

    # Transcode to AAC
    aac_path = transcode_to_aac(str(assembled_path))
    if aac_path != str(assembled_path):
        assembled_path.unlink(missing_ok=True)
        assembled_path = Path(aac_path)
        file_ext = AAC_EXT
        filename = f"{file_id}{file_ext}"

    acoustic_features = await asyncio.to_thread(analyze_file, assembled_path)

    relative_path = f"/music_files/{filename}"

    if storage.is_minio_backend():
        audio_mime, _ = mimetypes.guess_type(str(assembled_path))
        if file_ext == AAC_EXT:
            audio_mime = AAC_CONTENT_TYPE
        relative_path = storage.upload_music_file(
            str(assembled_path), filename, audio_mime or "audio/mp4"
        )
        assembled_path.unlink(missing_ok=True)

    db_track = Track(
        title=payload.title,
        artist=payload.artist,
        album=payload.album,
        genre=payload.genre,
        duration=duration,
        file_path=relative_path,
        cover_url=None,
        acoustic_features=acoustic_features,
        acoustic_analyzed_at=(
            datetime.now(timezone.utc) if acoustic_features else None
        ),
        acoustic_analyzer_version=ANALYZER_VERSION if acoustic_features else None,
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
    # Порядок по id обязателен: до миграции 0021 уникальности в БД не было, и
    # два одновременных лайка могли создать второй is_liked-плейлист. Читатели
    # (профиль вкуса, рекомендации) выбирают самый старый — здесь тот же выбор,
    # иначе лайки расползлись бы по двум плейлистам.
    playlist = (
        db.query(Playlist)
        .filter(Playlist.owner_id == user.id, Playlist.is_liked.is_(True))
        .order_by(Playlist.id)
        .first()
    )
    if playlist is None:
        playlist = Playlist(
            name="Понравившиеся",
            is_public=False,
            is_liked=True,
            owner_id=user.id,
        )
        db.add(playlist)
        try:
            db.commit()
        except IntegrityError:
            # Параллельный запрос успел вставить свой — берём его, а не падаем.
            db.rollback()
            playlist = (
                db.query(Playlist)
                .filter(Playlist.owner_id == user.id, Playlist.is_liked.is_(True))
                .order_by(Playlist.id)
                .first()
            )
            if playlist is None:
                raise
            return playlist
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
    # Лайк снимает дизлайк/скип: строка в user_track_skips исключает трек из
    # рекомендаций и волны, а лайкнутый трек в чёрном списке — противоречие.
    db.execute(user_track_skips.delete().where(
        (user_track_skips.c.user_id == current_user.id) &
        (user_track_skips.c.track_id == track_id)
    ))
    db.commit()
    # Лайк — сильный явный сигнал: сбрасываем кэш рекомендаций сразу, а не
    # ждём истечения TTL (иначе юзер лайкает и 5 минут видит старую выдачу).
    invalidate_recommendation_cache(current_user.id)
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
    invalidate_recommendation_cache(current_user.id)
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


@router.get("/me/liked/ids", response_model=List[int])
def get_liked_track_ids(
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    # Только id — для playerStore.likedTrackIds (состояние сердечек).
    # Полный /me/liked гонял все лайкнутые треки целиком ради списка id.
    liked_playlist = get_or_create_liked_playlist(db, current_user)
    rows = db.query(playlist_tracks.c.track_id).filter(
        playlist_tracks.c.playlist_id == liked_playlist.id
    ).all()
    return [row[0] for row in rows]


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

    # Insert first so we can distinguish the first listener from a repeat.
    # The primary key makes this race-safe across concurrent play requests.
    insert_stmt = _dialect_insert(db, user_track_plays).values(
        user_id=current_user.id,
        track_id=track_id,
        play_count=1,
        last_played=func.now(),
    ).on_conflict_do_nothing(
        index_elements=[user_track_plays.c.user_id, user_track_plays.c.track_id],
    )
    
    try:
        inserted = db.execute(insert_stmt).rowcount or 0
        if inserted:
            db.query(Track).filter(Track.id == track_id).update(
                {Track.unique_listener_count: Track.unique_listener_count + 1},
                synchronize_session=False,
            )
        else:
            db.execute(
                user_track_plays.update()
                .where(
                    (user_track_plays.c.user_id == current_user.id)
                    & (user_track_plays.c.track_id == track_id)
                )
                .values(
                    play_count=user_track_plays.c.play_count + 1,
                    last_played=func.now(),
                )
            )
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
        
    invalidate_recommendation_cache(current_user.id)
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
    stmt = _dialect_insert(db, user_track_skips).values(
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
    invalidate_recommendation_cache(current_user.id)
    return {"message": "Skip recorded"}


@router.post("/{track_id}/dislike", status_code=status.HTTP_200_OK)
def dislike_track(
    track_id: int,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    """Явный дизлайк — «не нравится, больше не показывать».

    Пишется в ту же таблицу, что и скипы (наличие строки уже исключает трек
    из рекомендаций и волны), но с флагом disliked: артисту начисляется более
    тяжёлый штраф, не затухающий по времени. Лайк при этом снимается — иначе
    трек одновременно и в «Понравившихся», и в чёрном списке.
    """
    track = db.query(Track).filter(Track.id == track_id).first()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")

    # Атомарный upsert — как в /skip и /play. Ручное действие тоже гоняется:
    # двойной клик или ретрай фронтенда дают два параллельных запроса, и
    # update-then-insert на обоих видит rowcount 0 и оба делают INSERT —
    # второй ловит UniqueViolation по составному ключу. _dialect_insert
    # держит и SQLite (тесты), и PostgreSQL.
    stmt = _dialect_insert(db, user_track_skips).values(
        user_id=current_user.id,
        track_id=track_id,
        skip_count=1,
        disliked=True,
        last_skipped=func.now(),
    ).on_conflict_do_update(
        index_elements=[user_track_skips.c.user_id, user_track_skips.c.track_id],
        # При существующей строке (скип до дизлайка) skip_count не трогаем —
        # как в старом UPDATE.
        set_={"disliked": True, "last_skipped": func.now()},
    )
    db.execute(stmt)

    liked_playlist = get_or_create_liked_playlist(db, current_user)
    db.execute(playlist_tracks.delete().where(
        (playlist_tracks.c.playlist_id == liked_playlist.id) &
        (playlist_tracks.c.track_id == track_id)
    ))
    db.commit()
    invalidate_recommendation_cache(current_user.id)
    return {"message": "Track disliked"}


@router.delete("/{track_id}/dislike", status_code=status.HTTP_200_OK)
def undislike_track(
    track_id: int,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    """Снятие дизлайка. Строку удаляем целиком: она же исключает трек из
    выдачи, а накопленный скип-счётчик после явной отмены не должен держать
    трек в чёрном списке."""
    db.execute(user_track_skips.delete().where(
        (user_track_skips.c.user_id == current_user.id) &
        (user_track_skips.c.track_id == track_id)
    ))
    db.commit()
    invalidate_recommendation_cache(current_user.id)
    return {"message": "Dislike removed"}


@router.get("/me/disliked/ids", response_model=List[int])
def get_disliked_track_ids(
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    """id дизлайкнутых треков — для состояния кнопки в плеере."""
    rows = db.execute(
        select(user_track_skips.c.track_id).where(
            user_track_skips.c.user_id == current_user.id,
            user_track_skips.c.disliked.is_(True),
        )
    ).scalars()
    return list(rows)


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
    invalidate_recommendation_cache(current_user.id)
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
