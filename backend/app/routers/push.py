"""Web Push: ключ для подписки, подписка устройства, проверка и отметка открытий.

Рассылка и её правила — в app/push.py.
"""
import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app import push
from app.database import get_db
from app.dependencies import get_current_active_user
from app.models import User
from app.rate_limit import limiter

router = APIRouter()

_OPEN_KINDS = {"release", "reengage", "test"}


class SubscriptionKeys(BaseModel):
    p256dh: str = Field(..., min_length=40, max_length=256)
    auth: str = Field(..., min_length=8, max_length=64)


class SubscriptionIn(BaseModel):
    endpoint: str = Field(..., max_length=2048)
    keys: SubscriptionKeys


class UnsubscribeIn(BaseModel):
    endpoint: str = Field(..., max_length=2048)


class OpenedIn(BaseModel):
    kind: str = Field(..., max_length=32)


@router.get("/config")
def push_config(
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db),
):
    return {"public_key": push.public_key(db)}


@router.post("/subscribe", status_code=204)
@limiter.limit("20/minute")
def subscribe(
    request: Request,
    body: SubscriptionIn,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db),
):
    if not push.endpoint_allowed(body.endpoint):
        raise HTTPException(status_code=400, detail="Неизвестный push-сервис")
    push.save_subscription(
        db,
        current_user.id,
        body.endpoint,
        body.keys.p256dh,
        body.keys.auth,
        request.headers.get("user-agent"),
    )


@router.post("/unsubscribe", status_code=204)
def unsubscribe(
    body: UnsubscribeIn,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db),
):
    push.remove_subscription(db, current_user.id, body.endpoint)


@router.post("/test")
@limiter.limit("3/minute")
async def send_test(
    request: Request,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db),
):
    payload = {
        "title": "Уведомления включены",
        "body": "Сообщим, когда у ваших артистов выйдет новое",
        "url": "/?push=test",
        "tag": "test",
    }
    sent = await asyncio.to_thread(push.send_to_user, db, current_user.id, payload)
    return {"sent": sent}


@router.post("/opened", status_code=204)
def opened(body: OpenedIn, current_user: User = Depends(get_current_active_user)):
    if body.kind in _OPEN_KINDS:
        push.record_stat(f"opened_{body.kind}")
