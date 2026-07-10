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
    created_at: datetime

    class Config:
        from_attributes = True


class Token(BaseModel):
    access_token: str
    token_type: str


class TokenData(BaseModel):
    username: Optional[str] = None


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
    cover_url: Optional[str] = None
    play_count: int
    release_date: Optional[datetime] = None
    created_at: datetime
    source: str = "local"
    external_id: Optional[str] = None
    stream_url: Optional[str] = None

    class Config:
        from_attributes = True


class ExternalTrackImport(BaseModel):
    """Payload для материализации внешнего трека (ytmusic/soulseek) в БД."""
    source: str
    external_id: str
    title: str
    artist: str
    album: Optional[str] = None
    duration: int = 0
    cover_url: Optional[str] = None
    stream_url: Optional[str] = None


class PlaylistBase(BaseModel):
    name: str
    description: Optional[str] = None
    cover_url: Optional[str] = None
    is_public: bool = True


class PlaylistCreate(PlaylistBase):
    pass


class PlaylistResponse(PlaylistBase):
    id: int
    owner_id: int
    created_at: datetime
    updated_at: Optional[datetime] = None
    tracks: List[TrackResponse] = []

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


class ImportRequest(BaseModel):
    """Импорт коллекции/трека по ссылке из внешнего сервиса."""
    url: str
    playlist_name: Optional[str] = None


class ImportPreviewTrack(BaseModel):
    title: str
    artist: str
    duration: int = 0
    cover_url: Optional[str] = None
    source: str  # исходный сервис (soundcloud/yandex)


class ImportPreviewResponse(BaseModel):
    source: str          # soundcloud | yandex
    kind: str            # playlist | user | track
    title: Optional[str] = None
    cover_url: Optional[str] = None
    track_count: int
    tracks: List[ImportPreviewTrack] = []


class ImportResult(BaseModel):
    playlist: Optional[PlaylistResponse] = None
    imported: int    # сколько треков добавлено в плейлист
    matched: int     # из них подобрано матчингом (не нативных)
    skipped: int     # не удалось сделать играбельными


class ExternalTrackResponse(BaseModel):
    id: str
    source: str
    external_id: str
    title: str
    artist: str
    album: Optional[str] = None
    duration: int
    cover_url: Optional[str] = None
    stream_url: str
    download_url: Optional[str] = None
    download_allowed: bool = False


class ExternalPlaylistResponse(BaseModel):
    id: str
    source: str
    external_id: str
    title: str
    owner: Optional[str] = None
    cover_url: Optional[str] = None
    permalink_url: str  # ссылка для импорта через /api/import
    track_count: int = 0


class ExternalPlaylistDetail(BaseModel):
    playlist: ExternalPlaylistResponse
    tracks: List[ExternalTrackResponse] = []
