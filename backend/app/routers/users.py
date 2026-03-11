from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from typing import List
from app.database import get_db
from app.models import User, LikedArtist, UserGenrePreference, Track
from app.schemas import (
    UserResponse,
    LikedArtistResponse,
    LikedArtistCreate,
    OnboardingOptionsResponse,
    UserPreferencesResponse,
    UserPreferencesUpdate,
)
from app.dependencies import get_current_active_user
from sqlalchemy import delete, func, desc

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


@router.get("/me/onboarding-options", response_model=OnboardingOptionsResponse)
async def get_onboarding_options(
    genres: List[str] = Query(default=[]),
    genre_limit: int = 20,
    artist_limit: int = 50,
    db: AsyncSession = Depends(get_db)
):
    genre_limit = max(1, min(genre_limit, 100))
    artist_limit = max(1, min(artist_limit, 200))

    genres_query = (
        select(Track.genre, func.count(Track.id).label("tracks_count"))
        .filter(Track.genre.isnot(None))
        .filter(Track.genre != "")
        .group_by(Track.genre)
        .order_by(desc("tracks_count"), Track.genre.asc())
        .limit(genre_limit)
    )
    genre_result = await db.execute(genres_query)
    available_genres = [row[0] for row in genre_result.all() if row[0]]

    artists_query = (
        select(Track.artist, func.count(Track.id).label("tracks_count"))
        .filter(Track.artist.isnot(None))
        .filter(Track.artist != "")
    )
    if genres:
        artists_query = artists_query.filter(Track.genre.in_(genres))
    artists_query = (
        artists_query
        .group_by(Track.artist)
        .order_by(desc("tracks_count"), Track.artist.asc())
        .limit(artist_limit)
    )
    artist_result = await db.execute(artists_query)
    available_artists = [row[0] for row in artist_result.all() if row[0]]

    return OnboardingOptionsResponse(genres=available_genres, artists=available_artists)


@router.get("/me/preferences", response_model=UserPreferencesResponse)
async def get_user_preferences(
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db)
):
    genres_res = await db.execute(
        select(UserGenrePreference.genre).filter(UserGenrePreference.user_id == current_user.id)
    )
    genres = [row[0].strip() for row in genres_res.all() if row[0] and row[0].strip()]
    artists_res = await db.execute(
        select(LikedArtist.artist_name).filter(LikedArtist.user_id == current_user.id)
    )
    artists = [row[0].strip() for row in artists_res.all() if row[0] and row[0].strip()]
    return UserPreferencesResponse(genres=genres, artists=artists)


@router.put("/me/preferences", status_code=200)
async def update_user_preferences(
    preferences: UserPreferencesUpdate,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db)
):
    # Normalize and deduplicate while preserving order
    clean_genres = []
    seen_genres = set()
    for genre in preferences.genres:
        normalized = genre.strip()
        if normalized and normalized not in seen_genres:
            seen_genres.add(normalized)
            clean_genres.append(normalized)

    clean_artists = []
    seen_artists = set()
    for artist in preferences.artists:
        normalized = artist.strip()
        key = normalized.lower()
        if normalized and key not in seen_artists:
            seen_artists.add(key)
            clean_artists.append(normalized)

    if not clean_genres:
        raise HTTPException(status_code=400, detail="Нужно выбрать хотя бы один жанр")

    if not clean_artists:
        raise HTTPException(status_code=400, detail="Нужно выбрать хотя бы одного исполнителя")

    await db.execute(
        delete(UserGenrePreference).where(UserGenrePreference.user_id == current_user.id)
    )
    await db.execute(
        delete(LikedArtist).where(LikedArtist.user_id == current_user.id)
    )

    for genre in clean_genres:
        db.add(UserGenrePreference(user_id=current_user.id, genre=genre))

    for artist_name in clean_artists:
        db.add(
            LikedArtist(
                user_id=current_user.id,
                artist_id=artist_name.lower(),
                artist_name=artist_name,
                avatar_url=None,
            )
        )

    await db.commit()
    return {"message": "Preferences saved successfully"}
