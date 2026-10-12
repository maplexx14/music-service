"""«Связь с разработчиком»: сообщения из настроек и их разбор в админке."""
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session, joinedload

from app.database import get_db
from app.dependencies import get_current_active_user, get_current_admin_user
from app.models import DeveloperMessage, User
from app.rate_limit import limiter

router = APIRouter()

MESSAGE_MAX_CHARS = 4000


class MessageCreate(BaseModel):
    message: str = Field(..., max_length=MESSAGE_MAX_CHARS)
    # Версия сборки, устройство, экран — что клиент сочтёт полезным для
    # разбора. Сервер не разбирает, только хранит.
    context: Optional[Dict[str, Any]] = None


def _snapshot(row: DeveloperMessage) -> dict:
    user = row.user
    return {
        "id": row.id,
        "message": row.message,
        "context": row.context,
        "is_read": row.is_read,
        "created_at": row.created_at,
        "user": {
            "id": user.id,
            "username": user.username,
            "email": user.email,
        } if user else None,
    }


@router.post("", status_code=status.HTTP_201_CREATED)
@limiter.limit("5/minute")
def send_message(
    request: Request,
    payload: MessageCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    text = payload.message.strip()
    if not text:
        raise HTTPException(status_code=422, detail="Сообщение пустое")
    context = payload.context or {}
    # Контекст — подсказка, а не хранилище: огромный объект от клиента не
    # должен раздувать таблицу.
    if len(str(context)) > 2000:
        context = {}
    row = DeveloperMessage(user_id=current_user.id, message=text, context=context or None)
    db.add(row)
    db.commit()
    return {"id": row.id}


@router.get("")
def list_messages(
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin_user),
) -> List[dict]:
    rows = (
        db.query(DeveloperMessage)
        .options(joinedload(DeveloperMessage.user))
        .order_by(DeveloperMessage.created_at.desc(), DeveloperMessage.id.desc())
        .limit(limit)
        .all()
    )
    return [_snapshot(row) for row in rows]


@router.post("/{message_id}/read")
def mark_read(
    message_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin_user),
):
    row = db.query(DeveloperMessage).filter(DeveloperMessage.id == message_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Сообщение не найдено")
    row.is_read = True
    db.commit()
    return _snapshot(row)
