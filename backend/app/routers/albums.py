"""Страница альбома: релиз внешнего источника как плейлист.

Открывается из карусели «Альбомы» на странице исполнителя (см. routers/artists.py
и ArtistPageResponse.albums). Треки альбома играются сразу, как и любая внешняя
выдача; в БД они попадают только по явному действию пользователя — «Добавить в
медиатеку» здесь или лайк/добавление отдельного трека на самой странице.

Провайдер пока один — YouTube Music (source="ytmusic"), но источник приходит
параметром пути: у SoundCloud альбомы отдаются как плейлисты (см.
routers/soundcloud.py), и когда появится второй провайдер альбомов, добавится
ветка, а не второй эндпоинт.
"""
import asyncio
import logging
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func, insert
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies import get_current_active_user
from app.models import Playlist, User, playlist_tracks
from app.routers import ytdlp
from app.routers.tracks import get_or_create_external_track
from app.recommendation_telemetry import link_materialized_deliveries
from app.schemas import (
    AlbumSaveRequest,
    AlbumSaveResponse,
    ExternalAlbumDetail,
    ExternalTrackImport,
)

logger = logging.getLogger(__name__)

router = APIRouter()


async def _album(request: Request, source: str, external_id: str) -> ExternalAlbumDetail:
    """Альбом у провайдера или 404. Общая часть просмотра и сохранения."""
    if source != "ytmusic":
        raise HTTPException(status_code=404, detail="Неизвестный источник альбома")

    detail = await ytdlp.ytmusic_album(request, external_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="Альбом не найден")
    return detail


@router.get("/{source}/{external_id}", response_model=ExternalAlbumDetail)
async def album_detail(source: str, external_id: str, request: Request):
    """Альбом целиком: метаданные релиза и его треки со ссылками на поток."""
    return await _album(request, source, external_id)


@router.post("/library", response_model=AlbumSaveResponse)
async def save_album_to_library(
    payload: AlbumSaveRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Сохраняет альбом в медиатеку пользователя отдельным плейлистом.

    Треки материализуются в БД (get_or_create_external_track): в плейлист можно
    положить только запись с числовым id. Повторный вызов копий не плодит —
    плейлист с этим названием дополняется теми треками, которых в нём ещё нет
    (в переиздание могли добавить бонусы).
    """
    detail = await _album(request, payload.source, payload.external_id)
    album, tracks = detail.album, detail.tracks
    if not tracks:
        raise HTTPException(status_code=404, detail="В этом альбоме нет треков")

    # Материализация треков — чисто sync (SQLAlchemy + commit'ы на каждый трек);
    # в async-хендлере это блокировало бы event loop на всём цикле. Уходит в
    # тредпул (см. recommendations.py — тот же приём).
    return await asyncio.to_thread(
        _save_album_tracks, db, current_user, album, tracks
    )


def _save_album_tracks(db: Session, current_user: User, album, tracks) -> AlbumSaveResponse:
    """Материализует треки альбома в плейлист. Sync-тело save_album_to_library."""
    playlist = (
        db.query(Playlist)
        .filter(Playlist.owner_id == current_user.id, Playlist.name == album.title)
        .first()
    )
    created = playlist is None
    if created:
        playlist = Playlist(
            name=album.title,
            description=f"Альбом {album.artist}" if album.artist else "Альбом",
            cover_url=album.cover_url,
            is_public=False,  # личная подборка, а не публикация
            owner_id=current_user.id,
        )
        db.add(playlist)
        db.commit()
        db.refresh(playlist)

    existing_ids = {t.id for t in playlist.tracks}

    track_ids: List[int] = []
    for ext in tracks:
        try:
            saved = get_or_create_external_track(
                db,
                ExternalTrackImport(
                    source=ext.source,
                    external_id=ext.external_id,
                    title=ext.title,
                    artist=ext.artist,
                    album=ext.album,
                    duration=ext.duration,
                    cover_url=ext.cover_url,
                    # stream_url НЕ сохраняем: в нём зашит текущий хост, а он
                    # меняется при переносе деплоя (см. resolveRawUrl на фронте
                    # — для записи с числовым id поток строится заново).
                    genre=ext.genre,
                ),
            )
        except Exception:  # noqa: BLE001 — один битый трек не должен ронять всё
            logger.warning("failed to materialize %s for album %s", ext.id, album.title)
            continue
        link_materialized_deliveries(
            db,
            user_id=current_user.id,
            source=ext.source,
            external_id=ext.external_id,
            track_id=saved.id,
        )
        track_ids.append(saved.id)

    # Позиции продолжают существующие: плейлист отдаётся отсортированным по
    # position (см. Playlist.tracks), и дырки/нули перемешали бы порядок.
    position = (
        db.query(func.max(playlist_tracks.c.position))
        .filter(playlist_tracks.c.playlist_id == playlist.id)
        .scalar()
    )
    position = -1 if position is None else position

    rows = []
    for track_id in track_ids:
        if track_id in existing_ids:
            continue
        existing_ids.add(track_id)
        position += 1
        rows.append(
            {"playlist_id": playlist.id, "track_id": track_id, "position": position}
        )

    if rows:
        db.execute(insert(playlist_tracks), rows)
        db.commit()

    return AlbumSaveResponse(
        playlist_id=playlist.id,
        name=playlist.name,
        created=created,
        added=len(rows),
        total=len(existing_ids),
    )
