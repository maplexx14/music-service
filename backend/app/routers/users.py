from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from typing import List
from app.database import get_db
from app.models import User, LikedArtist
from app.schemas import UserResponse, LikedArtistResponse, LikedArtistCreate
from app.dependencies import get_current_active_user
from sqlalchemy import delete

router = APIRouter()


@router.get("/me", response_model=UserResponse)
async def get_current_user_info(current_user: User = Depends(get_current_active_user)):
    return current_user


@router.get("/{user_id}", response_model=UserResponse)
async def get_user(user_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).filter(User.id == user_id))
    user = result.scalars().first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user

@router.get("/me/liked/artists", response_model=List[LikedArtistResponse])
async def get_liked_artists(
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db)
):
    result = await db.execute(
        select(LikedArtist).filter(LikedArtist.user_id == current_user.id).order_by(LikedArtist.created_at.desc())
    )
    return result.scalars().all()

@router.post("/me/liked/artists", status_code=200)
async def like_artist(
    artist_data: LikedArtistCreate,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db)
):
    # Check if already liked
    res = await db.execute(
        select(LikedArtist).filter(
            (LikedArtist.user_id == current_user.id) & 
            (LikedArtist.artist_id == artist_data.artist_id)
        )
    )
    if res.first():
        return {"message": "Artist already liked"}

    new_liked_artist = LikedArtist(
        user_id=current_user.id,
        artist_id=artist_data.artist_id,
        artist_name=artist_data.artist_name,
        avatar_url=artist_data.avatar_url
    )
    db.add(new_liked_artist)
    await db.commit()
    return {"message": "Artist liked successfully"}

@router.delete("/me/liked/artists/{artist_id}", status_code=200)
async def unlike_artist(
    artist_id: str,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db)
):
    await db.execute(
        delete(LikedArtist).where(
            (LikedArtist.user_id == current_user.id) & 
            (LikedArtist.artist_id == artist_id)
        )
    )
    await db.commit()
    return {"message": "Artist unliked successfully"}
