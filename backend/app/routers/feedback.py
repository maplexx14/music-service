"""«Связь с разработчиком» и «Оценить сервис»: что юзеры пишут и как
оценивают сервис из настроек, и разбор этого в админке."""
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from app.database import get_db
from app.dependencies import get_current_active_user, get_current_admin_user
from app.models import DeveloperMessage, ServiceRating, User
from app.rate_limit import limiter

router = APIRouter()

MESSAGE_MAX_CHARS = 4000
RATING_COMMENT_MAX_CHARS = 1000


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


class RatingUpsert(BaseModel):
    score: int = Field(..., ge=1, le=5)
    comment: Optional[str] = Field(None, max_length=RATING_COMMENT_MAX_CHARS)


def _rating_snapshot(row: ServiceRating) -> dict:
    return {"score": row.score, "comment": row.comment, "updated_at": row.updated_at}


@router.get("/rating")
def get_my_rating(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    row = db.query(ServiceRating).filter(ServiceRating.user_id == current_user.id).first()
    return _rating_snapshot(row) if row else None


@router.put("/rating")
@limiter.limit("10/minute")
def set_my_rating(
    request: Request,
    payload: RatingUpsert,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    comment = (payload.comment or "").strip() or None
    row = db.query(ServiceRating).filter(ServiceRating.user_id == current_user.id).first()
    if row is None:
        row = ServiceRating(user_id=current_user.id, score=payload.score, comment=comment)
        db.add(row)
    else:
        row.score = payload.score
        row.comment = comment
    db.commit()
    db.refresh(row)
    return _rating_snapshot(row)


@router.get("/ratings")
def list_ratings(
    limit: int = Query(200, ge=1, le=1000),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin_user),
):
    """Сводка для админки: среднее и распределение по всем оценкам, плюс
    последние оценки с комментариями."""
    counts = dict(
        db.query(ServiceRating.score, func.count(ServiceRating.id))
        .group_by(ServiceRating.score)
        .all()
    )
    total = sum(counts.values())
    average = (
        sum(score * count for score, count in counts.items()) / total if total else None
    )
    rows = (
        db.query(ServiceRating)
        .options(joinedload(ServiceRating.user))
        .order_by(ServiceRating.updated_at.desc(), ServiceRating.id.desc())
        .limit(limit)
        .all()
    )
    return {
        "total": total,
        "average": round(average, 2) if average is not None else None,
        "distribution": {score: counts.get(score, 0) for score in range(1, 6)},
        "items": [
            {
                "id": row.id,
                **_rating_snapshot(row),
                "user": {
                    "id": row.user.id,
                    "username": row.user.username,
                    "email": row.user.email,
                } if row.user else None,
            }
            for row in rows
        ],
    }
