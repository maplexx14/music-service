from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import func, desc, or_
from sqlalchemy.orm import selectinload
from typing import List
from app.database import get_db
from app.models import Track, Playlist, User, user_track_plays, user_liked_tracks
from app.schemas import RecommendationResponse, TrackResponse, PlaylistResponse
from app.dependencies import get_current_active_user

router = APIRouter()


@router.get("/", response_model=RecommendationResponse)
async def get_recommendations(
    limit: int = 20,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db)
):
    # Get user's liked tracks directly from db to avoid lazy load issues
    liked_res = await db.execute(
        select(Track).join(user_liked_tracks).filter(user_liked_tracks.c.user_id == current_user.id)
    )
    liked_track_ids = [track.id for track in liked_res.scalars().all()]
    
    # Get frequently played tracks by this user
    played_res = await db.execute(
        select(user_track_plays.c.track_id).filter(
            user_track_plays.c.user_id == current_user.id
        ).order_by(desc(user_track_plays.c.play_count)).limit(10)
    )
    played_track_ids = [row[0] for row in played_res.all()]
    
    # Combine liked and played track IDs
    user_track_ids = list(set(liked_track_ids + played_track_ids))
    
    recommended_tracks = []
    
    if user_track_ids:
        # Find tracks with similar genres or artists
        user_tracks_res = await db.execute(select(Track).filter(Track.id.in_(user_track_ids)))
        user_tracks = user_tracks_res.scalars().all()
        
        # Extract genres and artists
        genres = [t.genre for t in user_tracks if t.genre]
        artists = [t.artist for t in user_tracks]
        
        # Find similar tracks
        similar_res = await db.execute(
            select(Track).filter(
                or_(
                    Track.genre.in_(genres),
                    Track.artist.in_(artists)
                )
            ).filter(~Track.id.in_(user_track_ids)).order_by(desc(Track.play_count)).limit(limit)
        )
        
        recommended_tracks = list(similar_res.scalars().all())
    
    # If not enough recommendations, add popular tracks
    if len(recommended_tracks) < limit:
        pop_res = await db.execute(
            select(Track).filter(
                ~Track.id.in_(user_track_ids + [t.id for t in recommended_tracks])
            ).order_by(desc(Track.play_count)).limit(limit - len(recommended_tracks))
        )
        recommended_tracks.extend(pop_res.scalars().all())
    
    # Get popular playlists
    pl_res = await db.execute(
        select(Playlist).options(selectinload(Playlist.tracks)).filter(
            Playlist.is_public == True
        ).order_by(desc(Playlist.created_at)).limit(10)
    )
    popular_playlists = pl_res.scalars().all()
    
    return RecommendationResponse(
        tracks=[TrackResponse.model_validate(t) for t in recommended_tracks[:limit]],
        playlists=[PlaylistResponse.model_validate(p) for p in popular_playlists]
    )


@router.get("/tracks", response_model=List[TrackResponse])
async def get_recommended_tracks(
    limit: int = 20,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db)
):
    recommendations = await get_recommendations(limit=limit, current_user=current_user, db=db)
    return recommendations.tracks


@router.get("/playlists", response_model=List[PlaylistResponse])
async def get_recommended_playlists(
    limit: int = 10,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db)
):
    recommendations = await get_recommendations(limit=limit, current_user=current_user, db=db)
    return recommendations.playlists
