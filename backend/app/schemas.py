from pydantic import BaseModel, EmailStr
from typing import Optional, List
from datetime import datetime


class UserBase(BaseModel):
    username: str
    email: EmailStr
    full_name: Optional[str] = None


class UserCreate(UserBase):
    password: str


class UserResponse(UserBase):
    id: int
    avatar_url: Optional[str] = None
    is_active: bool
    is_admin: bool = False
    is_email_verified: bool = False
    created_at: datetime

    class Config:
        from_attributes = True

class LikedArtistCreate(BaseModel):
    artist_id: str
    artist_name: str
    avatar_url: Optional[str] = None

class LikedArtistResponse(BaseModel):
    id: int
    artist_id: str
    artist_name: str
    avatar_url: Optional[str] = None
    created_at: datetime
    
    class Config:
        from_attributes = True


class Token(BaseModel):
    access_token: str
    token_type: str


class TokenData(BaseModel):
    username: Optional[str] = None


class VerifyEmailRequest(BaseModel):
    email: str
    code: str


class ResendCodeRequest(BaseModel):
    email: str


class TrackBase(BaseModel):
    title: str
    artist: str
    album: Optional[str] = None
    duration: int
    genre: Optional[str] = None


class TrackCreate(TrackBase):
    file_path: str
    cover_url: Optional[str] = None


class TrackResponse(TrackBase):
    id: int
    file_path: str
    cover_url: Optional[str] = None
    play_count: int
    release_date: Optional[datetime] = None
    created_at: datetime

    class Config:
        from_attributes = True


class PlaylistBase(BaseModel):
    name: str
    description: Optional[str] = None
    cover_url: Optional[str] = None
    is_public: bool = True


class PlaylistCreate(PlaylistBase):
    pass


class PlaylistResponse(PlaylistBase):
    id: int
    uuid: Optional[str] = None
    owner_id: int
    created_at: datetime
    updated_at: Optional[datetime] = None
    tracks: List[TrackResponse] = []

    class Config:
        from_attributes = True


class LikedPlaylistResponse(BaseModel):
    id: int
    playlist_id: int
    playlist: Optional[PlaylistResponse] = None
    created_at: datetime

    class Config:
        from_attributes = True


class PlaylistUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    cover_url: Optional[str] = None
    is_public: Optional[bool] = None


class SearchResponse(BaseModel):
    tracks: List[TrackResponse] = []
    playlists: List[PlaylistResponse] = []
    users: List[UserResponse] = []


class RecommendationResponse(BaseModel):
    tracks: List[TrackResponse] = []
    playlists: List[PlaylistResponse] = []
