from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import func
from typing import Dict, Any

from app.database import get_db
from app.models import User, Track
from app.dependencies import get_current_admin_user
from app.cache import get_online_users_count

router = APIRouter(
    dependencies=[Depends(get_current_admin_user)]
)

@router.get("/stats", response_model=Dict[str, Any])
async def get_admin_stats(db: AsyncSession = Depends(get_db)):
    """Get overall statistics for the admin dashboard"""
    # Get total users
    users_result = await db.execute(select(func.count(User.id)))
    total_users = users_result.scalar() or 0
    
    # Get total tracks
    tracks_result = await db.execute(select(func.count(Track.id)))
    total_tracks = tracks_result.scalar() or 0
    
    # Get online users from Redis
    online_users = await get_online_users_count()
    
    return {
        "total_users": total_users,
        "total_tracks": total_tracks,
        "online_users": online_users
    }

@router.put("/users/{user_id}/ban", status_code=status.HTTP_200_OK)
async def ban_user(user_id: int, db: AsyncSession = Depends(get_db)):
    """Ban a user (set is_active to False)"""
    result = await db.execute(select(User).filter(User.id == user_id))
    user = result.scalars().first()
    
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
        
    if getattr(user, "is_admin", False):
        raise HTTPException(status_code=400, detail="Cannot ban an admin")
        
    user.is_active = False
    await db.commit()
    
    return {"message": f"User {user.username} has been banned"}

@router.put("/users/{user_id}/unban", status_code=status.HTTP_200_OK)
async def unban_user(user_id: int, db: AsyncSession = Depends(get_db)):
    """Unban a user (set is_active to True)"""
    result = await db.execute(select(User).filter(User.id == user_id))
    user = result.scalars().first()
    
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
        
    user.is_active = True
    await db.commit()
    
    return {"message": f"User {user.username} has been unbanned"}

@router.delete("/tracks/{track_id}", status_code=status.HTTP_200_OK)
async def delete_track_admin(track_id: int, db: AsyncSession = Depends(get_db)):
    """Delete a track (Admin only)"""
    result = await db.execute(select(Track).filter(Track.id == track_id))
    track = result.scalars().first()
    
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
        
    await db.delete(track)
    await db.commit()
    
    return {"message": f"Track '{track.title}' has been deleted"}
