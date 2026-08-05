from pydantic import BaseModel, EmailStr, field_validator
from typing import Optional, List
from datetime import datetime

from app import storage


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
    preferred_genres: List[str] = []
    preferred_artists: List[str] = []
    created_at: datetime

    class Config:
        from_attributes = True


class UserPreferencesUpdate(BaseModel):
    """Обновление явных музыкальных предпочтений (онбординг/настройки)."""
    preferred_genres: List[str] = []
    preferred_artists: List[str] = []


class GenreOption(BaseModel):
    """Пункт списка жанров для выбора: технический ключ + подпись."""
    key: str
    label: str


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

    @field_validator("cover_url")
    @classmethod
    def _normalize_cover(cls, v: Optional[str]) -> Optional[str]:
        # Приводим обложки из MinIO к относительному прокси-пути (тот же
        # origin, что и app). Чинит и уже сохранённые legacy-записи со старым
        # http://localhost:9000/covers/… без миграции БД.
        return storage.normalize_cover_url(v)

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
    genre: Optional[str] = None


class PlaylistBase(BaseModel):
    name: str
    description: Optional[str] = None
    cover_url: Optional[str] = None
    is_public: bool = True


class PlaylistCreate(PlaylistBase):
    pass


class PlaylistSummaryResponse(PlaylistBase):
    """Плейлист без треков — для списков и поиска. Отсутствие поля tracks
    важно: сериализация не трогает relationship и не тянет содержимое каждого
    плейлиста. track_count считается в том же SELECT (см. Playlist.track_count)."""
    id: int
    owner_id: int
    is_liked: bool = False
    created_at: datetime
    updated_at: Optional[datetime] = None
    track_count: int = 0

    class Config:
        from_attributes = True


class PlaylistResponse(PlaylistSummaryResponse):
    tracks: List[TrackResponse] = []


class PlaylistUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    cover_url: Optional[str] = None
    is_public: Optional[bool] = None


class SearchResponse(BaseModel):
    tracks: List[TrackResponse] = []
    playlists: List[PlaylistSummaryResponse] = []
    users: List[UserResponse] = []


class RecommendationResponse(BaseModel):
    tracks: List[TrackResponse] = []
    playlists: List[PlaylistResponse] = []


class ImportRequest(BaseModel):
    """Импорт коллекции/трека по ссылке из внешнего сервиса."""
    url: str
    playlist_name: Optional[str] = None
    cookies_file: Optional[str] = None  # путь к cookies файлу для обхода CAPTCHA


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
    genre: Optional[str] = None


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


class ExternalSearchGrouped(BaseModel):
    """Внешняя выдача, разложенная по источникам.

    Поиск рисует источники отдельными секциями в фиксированном порядке, так что
    склеивать их на бэке незачем — фронту пришлось бы разбирать список обратно.
    """
    ytmusic: List[ExternalTrackResponse] = []
    soundcloud: List[ExternalTrackResponse] = []


class ArtistPageResponse(BaseModel):
    """Страница исполнителя: его треки одним плейлистом.

    Два списка вместо одного — потому что типы разные: у треков из библиотеки
    числовой id (лайк и добавление в плейлист работают сразу), у внешних —
    строковый ("ytmusic:...", материализуются по действию пользователя).
    Порядок склейки на фронте: tracks, затем external.

    is_liked — исполнитель в избранном пользователя (User.preferred_artists,
    оттуда же его берёт волна). playlist_id — плейлист этого артиста, если он
    уже сохранён в медиатеку; по нему кнопка показывает «Открыть», а не
    «Добавить» повторно.
    """
    name: str
    cover_url: Optional[str] = None
    tracks: List[TrackResponse] = []
    external: List[ExternalTrackResponse] = []
    is_liked: bool = False
    playlist_id: Optional[int] = None


class ArtistSummary(BaseModel):
    """Карточка исполнителя в выдаче поиска — ведёт на его страницу."""
    name: str
    cover_url: Optional[str] = None
    # Есть ли треки этого артиста в медиатеке (карточка помечается «в медиатеке»).
    in_library: bool = False


class ArtistNameRequest(BaseModel):
    name: str


class ArtistLikeResponse(BaseModel):
    name: str
    liked: bool


class ArtistSaveResponse(BaseModel):
    """Итог сохранения плейлиста исполнителя в медиатеку."""
    playlist_id: int
    name: str
    created: bool  # плейлист создан (False — дополнили существующий)
    added: int     # сколько треков добавлено этим вызовом
    total: int     # сколько всего треков в плейлисте
