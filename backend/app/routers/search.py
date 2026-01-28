from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from sqlalchemy import or_
from app.database import get_db
from app.models import Track, Playlist, User
from app.schemas import SearchResponse, TrackResponse, PlaylistResponse, UserResponse

router = APIRouter()


@router.get("/", response_model=SearchResponse)
async def search(
    q: str = Query(..., min_length=1),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db)
):
    search_term = f"%{q}%"
    
    # Search tracks
    tracks = db.query(Track).filter(
        or_(
            Track.title.ilike(search_term),
            Track.artist.ilike(search_term),
            Track.album.ilike(search_term)
        )
    ).limit(limit).all()
    
    # Search playlists
    playlists = db.query(Playlist).filter(
        or_(
            Playlist.name.ilike(search_term),
            Playlist.description.ilike(search_term)
        )
    ).filter(Playlist.is_public == True).limit(limit).all()
    
    # Search users
    users = db.query(User).filter(
        or_(
            User.username.ilike(search_term),
            User.full_name.ilike(search_term)
        )
    ).filter(User.is_active == True).limit(limit).all()
    
    return SearchResponse(
        tracks=[TrackResponse.model_validate(t) for t in tracks],
        playlists=[PlaylistResponse.model_validate(p) for p in playlists],
        users=[UserResponse.model_validate(u) for u in users]
    )
