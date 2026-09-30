"""Админка привязок «зацензуренный трек → оригинал на SoundCloud».

Логика и мотивация — в app/censorship.py.
"""
import asyncio
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app import censorship
from app.censorship import STATUS_CONFIRMED, STATUS_REJECTED, STATUS_SUGGESTED
from app.database import get_db
from app.dependencies import get_current_admin_user
from app.models import CensorOverride, User

router = APIRouter()

_STATUSES = {STATUS_CONFIRMED, STATUS_SUGGESTED, STATUS_REJECTED}


class OverrideCreate(BaseModel):
    """Привязать ytmusic-трек к оригиналу.

    Оригинал — ссылкой soundcloud.com/… (ввели руками) или id трека
    SoundCloud (выбрали из кандидатов).
    """
    video_id: str
    title: str
    artist: str
    soundcloud: str


def _get_row(db: Session, override_id: int) -> CensorOverride:
    row = db.query(CensorOverride).filter(CensorOverride.id == override_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Привязка не найдена")
    return row


def _set_status(db: Session, row: CensorOverride, status: str, user: User) -> dict:
    row.status = status
    row.created_by = user.id
    censorship.sync_library_titles(db, row)
    db.commit()
    censorship.invalidate()
    return censorship._snapshot(row)


@router.get("/overrides")
def list_overrides(
    status: Optional[str] = Query(None),
    limit: int = Query(200, ge=1, le=500),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin_user),
) -> List[dict]:
    query = db.query(CensorOverride)
    if status:
        if status not in _STATUSES:
            raise HTTPException(status_code=400, detail="Неизвестный статус")
        query = query.filter(CensorOverride.status == status)
    rows = query.order_by(CensorOverride.updated_at.desc(), CensorOverride.id.desc()).limit(limit)
    return [censorship._snapshot(row) for row in rows]


@router.get("/candidates")
async def list_candidates(
    title: str = Query(..., min_length=1),
    artist: str = Query(..., min_length=1),
    duration: int = Query(0, ge=0),
    current_user: User = Depends(get_current_admin_user),
) -> List[dict]:
    return await censorship.find_candidates(title, artist, duration)


@router.post("/overrides")
async def create_override(
    payload: OverrideCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin_user),
) -> dict:
    item = await censorship.resolve_soundcloud_track(payload.soundcloud)
    if item is None:
        raise HTTPException(status_code=400, detail="Трек SoundCloud не найден")
    fields = censorship.original_fields(item)
    if not fields["original_permalink"]:
        raise HTTPException(status_code=400, detail="У трека SoundCloud нет ссылки")

    def save() -> dict:
        row = (
            db.query(CensorOverride)
            .filter(CensorOverride.source == "ytmusic", CensorOverride.external_id == payload.video_id)
            .first()
        )
        if row is None:
            row = CensorOverride(
                source="ytmusic",
                external_id=payload.video_id,
                censored_title=payload.title,
                censored_artist=payload.artist,
                censored_key=censorship.censored_key(payload.artist, payload.title),
            )
            db.add(row)
        # У существующей привязки цензурные поля не трогаем: трек в выдаче уже
        # показывается под названием оригинала, и клиент прислал бы именно его.
        for name, value in fields.items():
            setattr(row, name, value)
        row.score = None
        return _set_status(db, row, STATUS_CONFIRMED, current_user)

    return await asyncio.to_thread(save)


@router.post("/overrides/{override_id}/confirm")
def confirm_override(
    override_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin_user),
) -> dict:
    return _set_status(db, _get_row(db, override_id), STATUS_CONFIRMED, current_user)


@router.post("/overrides/{override_id}/reject")
def reject_override(
    override_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin_user),
) -> dict:
    """Отклонить подсказку или снять подтверждённую привязку.

    Строка остаётся со статусом rejected: автоподсказки больше не предложат
    этот трек (см. censorship._save_suggestion_blocking).
    """
    return _set_status(db, _get_row(db, override_id), STATUS_REJECTED, current_user)
