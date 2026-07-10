from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List
from app.database import get_db
from app.cache import get_cache, set_cache
from app.models import User
from app.schemas import UserResponse
from app.dependencies import get_current_active_user, get_current_admin_user

router = APIRouter()


@router.get("/me", response_model=UserResponse)
async def get_current_user_info(current_user: User = Depends(get_current_active_user)):
    return current_user


@router.get("/stats/count")
def get_user_count(
    current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db)
):
    cached = get_cache("users:count")
    if cached is not None:
        return cached
    total = db.query(User).count()
    result = {"total": total}
    set_cache("users:count", result, expire=300)
    return result


@router.get("/{user_id}", response_model=UserResponse)
def get_user(user_id: int, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user
