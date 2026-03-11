from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import desc, or_, func, case
from sqlalchemy.orm import selectinload
from typing import List
import random
from collections import defaultdict, deque
from app.database import get_db
from app.models import (
    Track,
    Playlist,
    User,
    LikedArtist,
    UserGenrePreference,
    user_track_plays,
    user_liked_tracks,
)
from app.schemas import RecommendationResponse, TrackResponse, PlaylistResponse
from app.dependencies import get_current_active_user

router = APIRouter()


def _diversify_tracks(tracks: List[Track], limit: int) -> List[Track]:
    """
    Shuffle and interleave tracks to avoid long runs from the same artist.
    """
    if len(tracks) <= 1:
        return tracks[:limit]

    buckets = defaultdict(list)
    for track in tracks:
        artist_key = (track.artist or "").strip().lower() or f"track-{track.id}"
        buckets[artist_key].append(track)

    rng = random.SystemRandom()
    for group in buckets.values():
        rng.shuffle(group)

    bucket_keys = list(buckets.keys())
    rng.shuffle(bucket_keys)
    bucket_queues = {key: deque(items) for key, items in buckets.items()}

    mixed = []
    while bucket_keys and len(mixed) < limit:
        next_round = []
        for key in bucket_keys:
            queue = bucket_queues[key]
            if queue:
                mixed.append(queue.popleft())
                if len(mixed) >= limit:
                    break
            if queue:
                next_round.append(key)
        rng.shuffle(next_round)
        bucket_keys = next_round

    return mixed


@router.get("/", response_model=RecommendationResponse)
async def get_recommendations(
    limit: int = 20,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db)
):
    limit = max(1, min(limit, 100))

    # Explicit onboarding/user preferences
    pref_genres_res = await db.execute(
        select(UserGenrePreference.genre).filter(UserGenrePreference.user_id == current_user.id)
    )
    preferred_genres = [row[0].strip() for row in pref_genres_res.all() if row[0] and row[0].strip()]
    preferred_genres_lc = list(dict.fromkeys([genre.lower() for genre in preferred_genres]))

    pref_artists_res = await db.execute(
        select(LikedArtist.artist_name).filter(LikedArtist.user_id == current_user.id)
    )
    preferred_artists = [row[0].strip() for row in pref_artists_res.all() if row[0] and row[0].strip()]
    preferred_artists_lc = list(dict.fromkeys([artist.lower() for artist in preferred_artists]))

    # Include genres derived from newly liked artists
    liked_artist_genres_lc = []
    if preferred_artists_lc:
        liked_artist_genres_res = await db.execute(
            select(func.lower(Track.genre))
            .filter(Track.genre.isnot(None))
            .filter(Track.genre != "")
            .filter(func.lower(Track.artist).in_(preferred_artists_lc))
            .group_by(func.lower(Track.genre))
        )
        liked_artist_genres_lc = [row[0] for row in liked_artist_genres_res.all() if row[0]]
    preferred_genres_lc = list(dict.fromkeys(preferred_genres_lc + liked_artist_genres_lc))

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
        # Implicit preferences from user behavior
        user_tracks_res = await db.execute(select(Track).filter(Track.id.in_(user_track_ids)))
        user_tracks = user_tracks_res.scalars().all()
        implicit_genres_lc = list(dict.fromkeys([
            t.genre.strip().lower() for t in user_tracks if t.genre and t.genre.strip()
        ]))
        implicit_artists_lc = list(dict.fromkeys([
            t.artist.strip().lower() for t in user_tracks if t.artist and t.artist.strip()
        ]))
    else:
        implicit_genres_lc = []
        implicit_artists_lc = []

    related_genres_lc = list(dict.fromkeys(preferred_genres_lc + implicit_genres_lc))

    # Derive similar artists from user's preferred genres
    similar_artists_lc = []
    if related_genres_lc:
        similar_artists_res = await db.execute(
            select(func.lower(Track.artist).label("artist_key"), func.count(Track.id).label("tracks_count"))
            .filter(Track.artist.isnot(None))
            .filter(Track.artist != "")
            .filter(func.lower(Track.genre).in_(related_genres_lc))
            .group_by("artist_key")
            .order_by(desc("tracks_count"))
            .limit(60)
        )
        similar_artists_lc = [
            row[0] for row in similar_artists_res.all() if row[0] and row[0] not in preferred_artists_lc
        ]

    candidate_filters = []
    if preferred_genres_lc:
        candidate_filters.append(func.lower(Track.genre).in_(preferred_genres_lc))
    if preferred_artists_lc:
        candidate_filters.append(func.lower(Track.artist).in_(preferred_artists_lc))
    if similar_artists_lc:
        candidate_filters.append(func.lower(Track.artist).in_(similar_artists_lc))
    if implicit_genres_lc:
        candidate_filters.append(func.lower(Track.genre).in_(implicit_genres_lc))
    if implicit_artists_lc:
        candidate_filters.append(func.lower(Track.artist).in_(implicit_artists_lc))

    if candidate_filters:
        score = 0
        if preferred_artists_lc:
            score += case((func.lower(Track.artist).in_(preferred_artists_lc), 100), else_=0)
        if preferred_genres_lc:
            score += case((func.lower(Track.genre).in_(preferred_genres_lc), 60), else_=0)
        if similar_artists_lc:
            score += case((func.lower(Track.artist).in_(similar_artists_lc), 30), else_=0)
        if implicit_artists_lc:
            score += case((func.lower(Track.artist).in_(implicit_artists_lc), 20), else_=0)
        if implicit_genres_lc:
            score += case((func.lower(Track.genre).in_(implicit_genres_lc), 10), else_=0)

        personalized_pool_limit = min(max(limit * 4, 40), 300)
        personalized_query = select(Track).filter(or_(*candidate_filters))
        if user_track_ids:
            personalized_query = personalized_query.filter(~Track.id.in_(user_track_ids))

        personalized_query = personalized_query.order_by(desc(score), desc(Track.play_count), func.random()).limit(personalized_pool_limit)
        personalized_res = await db.execute(personalized_query)
        recommended_tracks = _diversify_tracks(list(personalized_res.scalars().all()), limit)

    has_personal_signals = bool(preferred_genres_lc or preferred_artists_lc or implicit_genres_lc or implicit_artists_lc)

    # When personalized tracks run out but user has preferences: fill with similar genres (not trends)
    if len(recommended_tracks) < limit and has_personal_signals:
        similar_genres_lc = []
        artists_for_similar = list(dict.fromkeys(preferred_artists_lc + similar_artists_lc))
        if artists_for_similar:
            similar_genres_q = (
                select(func.lower(Track.genre).label("g"), func.count(Track.id).label("c"))
                .filter(Track.genre.isnot(None))
                .filter(Track.genre != "")
                .filter(func.lower(Track.artist).in_(artists_for_similar))
                .group_by(func.lower(Track.genre))
            )
            if related_genres_lc:
                similar_genres_q = similar_genres_q.filter(~func.lower(Track.genre).in_(related_genres_lc))
            similar_genres_q = similar_genres_q.order_by(desc("c")).limit(15)
            similar_genres_res = await db.execute(similar_genres_q)
            similar_genres_lc = [row[0] for row in similar_genres_res.all() if row[0]]

        if not similar_genres_lc and related_genres_lc:
            similar_genres_lc = related_genres_lc

        if not similar_genres_lc and (related_genres_lc or preferred_genres_lc or implicit_genres_lc):
            similar_genres_lc = list(dict.fromkeys((related_genres_lc or []) + (preferred_genres_lc or []) + (implicit_genres_lc or [])))

        if similar_genres_lc:
            excluded_ids = [t.id for t in recommended_tracks]
            if user_track_ids:
                excluded_ids = list(set(excluded_ids + user_track_ids))
            need_count = limit - len(recommended_tracks)
            similar_query = (
                select(Track)
                .filter(func.lower(Track.genre).in_(similar_genres_lc))
                .filter(~Track.id.in_(excluded_ids))
                .order_by(desc(Track.play_count), func.random())
                .limit(need_count * 2)
            )
            similar_res = await db.execute(similar_query)
            extra_tracks = list(similar_res.scalars().all())
            recommended_tracks.extend(extra_tracks[:need_count])
            recommended_tracks = _diversify_tracks(recommended_tracks, limit)

    # Fallback to popular only when user has no personal signals yet
    if len(recommended_tracks) < limit and not has_personal_signals:
        excluded_ids = [t.id for t in recommended_tracks]
        popular_query = select(Track)
        if excluded_ids:
            popular_query = popular_query.filter(~Track.id.in_(excluded_ids))
        pop_res = await db.execute(
            popular_query.order_by(desc(Track.play_count), func.random()).limit(limit - len(recommended_tracks))
        )
        recommended_tracks.extend(pop_res.scalars().all())
        recommended_tracks = _diversify_tracks(recommended_tracks, limit)
    
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
