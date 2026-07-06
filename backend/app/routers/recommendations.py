from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import func, desc
from typing import List
from app.database import get_db
from app.models import Track, Playlist, User, user_track_plays, user_liked_tracks
from app.schemas import RecommendationResponse, TrackResponse, PlaylistResponse
from app.dependencies import get_current_active_user

router = APIRouter()


@router.get("/", response_model=RecommendationResponse)
def get_recommendations(
    limit: int = 20,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    # Get user's liked tracks and frequently played tracks
    liked_track_ids = [track.id for track in current_user.liked_tracks]
    
    # Get frequently played tracks by this user
    played_tracks = db.query(user_track_plays.c.track_id).filter(
        user_track_plays.c.user_id == current_user.id
    ).order_by(desc(user_track_plays.c.play_count)).limit(10).all()
    played_track_ids = [t[0] for t in played_tracks]
    
    # Combine liked and played track IDs
    user_track_ids = list(set(liked_track_ids + played_track_ids))
    
    recommended_tracks = []
    
    if user_track_ids:
        # Find tracks with similar genres or artists
        user_tracks = db.query(Track).filter(Track.id.in_(user_track_ids)).all()
        
        # Extract genres and artists
        genres = [t.genre for t in user_tracks if t.genre]
        artists = [t.artist for t in user_tracks]
        
        # Find similar tracks
        from sqlalchemy import or_
        similar_tracks = db.query(Track).filter(
            or_(
                Track.genre.in_(genres),
                Track.artist.in_(artists)
            )
        ).filter(~Track.id.in_(user_track_ids)).order_by(desc(Track.play_count)).limit(limit).all()
        
        recommended_tracks = similar_tracks
    
    # If not enough recommendations, add popular tracks
    if len(recommended_tracks) < limit:
        popular_tracks = db.query(Track).filter(
            ~Track.id.in_(user_track_ids + [t.id for t in recommended_tracks])
        ).order_by(desc(Track.play_count)).limit(limit - len(recommended_tracks)).all()
        recommended_tracks.extend(popular_tracks)
    
    # Get popular playlists
    popular_playlists = db.query(Playlist).filter(
        Playlist.is_public == True
    ).order_by(desc(Playlist.created_at)).limit(10).all()
    
    return RecommendationResponse(
        tracks=[TrackResponse.model_validate(t) for t in recommended_tracks[:limit]],
        playlists=[PlaylistResponse.model_validate(p) for p in popular_playlists]
    )


@router.get("/tracks", response_model=List[TrackResponse])
def get_recommended_tracks(
    limit: int = 20,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    recommendations = get_recommendations(limit=limit, current_user=current_user, db=db)
    return recommendations.tracks


@router.get("/playlists", response_model=List[PlaylistResponse])
def get_recommended_playlists(
    limit: int = 10,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    recommendations = get_recommendations(limit=limit, current_user=current_user, db=db)
    return recommendations.playlists
