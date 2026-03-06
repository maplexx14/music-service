from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import or_
from sqlalchemy.orm import selectinload
from app.database import get_db
from app.models import Track, Playlist, User
from app.schemas import SearchResponse, TrackResponse, PlaylistResponse, UserResponse

router = APIRouter()


@router.get("/", response_model=SearchResponse)
async def search(
    q: str = Query(..., min_length=1),
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db)
):
    search_term = f"%{q}%"
    
    # Search tracks
    tracks_result = await db.execute(
        select(Track).filter(
            or_(
                Track.title.ilike(search_term),
                Track.artist.ilike(search_term),
                Track.album.ilike(search_term)
            )
        ).limit(limit)
    )
    tracks = tracks_result.scalars().all()
    
    # Search playlists
    playlists_result = await db.execute(
        select(Playlist).options(selectinload(Playlist.tracks)).filter(
            or_(
                Playlist.name.ilike(search_term),
                Playlist.description.ilike(search_term)
            )
        ).filter(Playlist.is_public == True).limit(limit)
    )
    playlists = playlists_result.scalars().all()
    
    # Search users
    users_result = await db.execute(
        select(User).filter(
            or_(
                User.username.ilike(search_term),
                User.full_name.ilike(search_term)
            )
        ).filter(User.is_active == True).limit(limit)
    )
    users = users_result.scalars().all()
    
    return SearchResponse(
        tracks=[TrackResponse.model_validate(t) for t in tracks],
        playlists=[PlaylistResponse.model_validate(p) for p in playlists],
        users=[UserResponse.model_validate(u) for u in users]
    )
