from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from sqlalchemy import or_
from app.database import get_db
from app.cache import get_cache, set_cache
from app.models import Track, Playlist, User
from app.schemas import SearchResponse, TrackResponse, PlaylistSummaryResponse, UserResponse
from app.dependencies import get_current_user_optional

router = APIRouter()

_SEARCH_TTL = 180


@router.get("/", response_model=SearchResponse)
def search(
    q: str = Query(..., min_length=1),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User | None = Depends(get_current_user_optional),
):
    # Кэш зависит от пользователя: в выдачу попадают его приватные плейлисты.
    user_key = current_user.id if current_user else "anon"
    normalized_q = " ".join(q.lower().split())
    cache_key = f"search:{normalized_q}:{limit}:{user_key}"
    cached = get_cache(cache_key)
    if cached is not None:
        return SearchResponse(**cached)

    search_term = f"%{normalized_q}%"
    
    tracks = db.query(Track).filter(
        or_(
            Track.title.ilike(search_term),
            Track.artist.ilike(search_term),
            Track.album.ilike(search_term)
        )
    ).order_by(Track.play_count.desc(), Track.created_at.desc()).limit(limit).all()
    
    # Search playlists (summary-схема без треков — выдача их не рендерит).
    # Публичные — всем; приватные — только их владельцу.
    visibility = Playlist.is_public == True
    if current_user is not None:
        visibility = or_(visibility, Playlist.owner_id == current_user.id)
    playlists = db.query(Playlist).filter(
        or_(
            Playlist.name.ilike(search_term),
            Playlist.description.ilike(search_term)
        )
    ).filter(visibility).limit(limit).all()
    
    # Search users
    users = db.query(User).filter(
        or_(
            User.username.ilike(search_term),
            User.full_name.ilike(search_term)
        )
    ).filter(User.is_active == True).limit(limit).all()
    
    response = SearchResponse(
        tracks=[TrackResponse.model_validate(t) for t in tracks],
        playlists=[PlaylistSummaryResponse.model_validate(p) for p in playlists],
        users=[UserResponse.model_validate(u) for u in users]
    )
    set_cache(cache_key, response.model_dump(mode="json"), expire=_SEARCH_TTL)
    return response
