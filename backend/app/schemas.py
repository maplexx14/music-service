from pydantic import BaseModel, EmailStr, Field, field_validator
from typing import Optional, List
from datetime import datetime

from app import storage


class UserBase(BaseModel):
    username: str
    email: EmailStr
    full_name: Optional[str] = None


class UserCreate(BaseModel):
    """Регистрация.

    full_name НЕ спрашиваем: поле осталось в профиле (сайдбар показывает его
    вместо username, поиск ищет и по нему), но заполнять его на входе незачем —
    лишний шаг в форме ради необязательных данных.

    captcha_token — одноразовый токен виджета Turnstile. None допустим ровно
    тогда, когда каптча на сервере не настроена (см. app.captcha).
    """
    username: str
    email: EmailStr
    password: str
    captcha_token: Optional[str] = None


class CaptchaConfig(BaseModel):
    """Что фронту рисовать на форме регистрации.

    required=false — каптча на сервере не настроена: виджета нет, регистрация
    принимается без токена.
    """
    required: bool = False
    provider: str = "turnstile"
    site_key: Optional[str] = None


class UserResponse(UserBase):
    id: int
    avatar_url: Optional[str] = None
    is_active: bool
    is_admin: bool = False
    email_verified: bool = False
    totp_enabled: bool = False
    email_2fa_enabled: bool = False
    preferred_genres: List[str] = []
    preferred_artists: List[str] = []
    excluded_artists: List[str] = []
    discovery_ratio: float = 0.2
    created_at: datetime

    class Config:
        from_attributes = True


class PendingRegistrationResponse(UserBase):
    """Заявка принята, но строки в users до подтверждения ещё нет."""
    email_verified: bool = False


class UserPreferencesUpdate(BaseModel):
    """Обновление явных предпочтений и исключений авто-профиля."""
    preferred_genres: List[str] = []
    preferred_artists: List[str] = []
    excluded_artists: List[str] = []
    # Мягкий prior на открытие новых артистов. None (поле не прислали) означает
    # «не менять»: клиент, который сохраняет только жанры, не сбрасывает его.
    discovery_ratio: Optional[float] = Field(None, ge=0.0, le=1.0)


class GenreOption(BaseModel):
    """Пункт списка жанров для выбора: технический ключ + подпись."""
    key: str
    label: str


class Token(BaseModel):
    access_token: str
    token_type: str
    # Токен доверенного устройства — приходит после успешного второго фактора.
    # Клиент кладёт его в localStorage и присылает заголовком X-Device-Token,
    # чтобы следующий вход с этого устройства не требовал код заново.
    device_token: Optional[str] = None


class LoginResult(BaseModel):
    """Ответ /auth/login.

    access_token/token_type приходят, когда второй фактор не нужен (2FA
    выключена И устройство знакомое). mfa_token — промежуточный: пароль
    верный, теперь нужен код. Ровно одно из этих полей заполнено.
    """
    access_token: Optional[str] = None
    token_type: Optional[str] = None
    mfa_token: Optional[str] = None
    mfa_required: bool = False
    # Какие факторы у юзера включены: "totp", "email" или оба. Фронт по этому
    # списку решает, показать поле кода сразу или дать выбор способа.
    mfa_methods: List[str] = []
    # Код на почту уже отправлен этим ответом — фронту не надо звать /send.
    email_code_sent: bool = False
    # Код требуется не потому, что юзер включил 2FA, а потому что устройство
    # незнакомое. Фронт по этому флагу объясняет причину: иначе человек, не
    # включавший 2FA, не понимает, откуда взялся запрос кода.
    new_device: bool = False
    # Куда ушёл код (маскированный адрес) — для текста на экране ввода.
    email_masked: Optional[str] = None


class TrustedDeviceResponse(BaseModel):
    """Устройство в списке настроек."""
    id: int
    label: str
    created_at: datetime
    last_seen_at: datetime
    # Запрос пришёл именно с этого устройства — фронт помечает его и не
    # предлагает отзыв «под собой».
    current: bool = False


class RevokeAllDevicesResponse(BaseModel):
    revoked: int


class MfaLoginRequest(BaseModel):
    """Второй шаг входа: TOTP-код, код из письма или резервный код.

    method задаёт, какой фактор проверять ("totp" / "email"). Без него
    проверяются все включённые по очереди — так работает вход, когда способ
    один и выбирать нечего.
    """
    mfa_token: str
    code: str
    method: Optional[str] = None


class MfaEmailCodeRequest(BaseModel):
    """Выслать (или переслать) код на почту на втором шаге входа. Пароль здесь
    не нужен: mfa_token сам по себе доказывает, что пароль уже проверен."""
    mfa_token: str


class MfaEmailCodeResponse(BaseModel):
    """sent=false бывает и в норме: SMTP не настроен либо код уже выслан и
    действует cooldown. cooldown_seconds — сколько ждать до следующего письма."""
    sent: bool
    email_masked: str
    cooldown_seconds: int = 0


class TwoFactorStatus(BaseModel):
    """Статус 2FA в профиле. totp_secret и otpauth_url заполнены только во
    время незавершённого включения (между setup и enable) — они нужны фронту,
    чтобы показать QR, и не должны светиться после."""
    totp_enabled: bool
    totp_secret: Optional[str] = None
    otpauth_url: Optional[str] = None
    email_2fa_enabled: bool = False
    # Адрес в маскированном виде: на экране настроек надо показать, КУДА
    # уйдёт код, но полный адрес там уже и так виден в профиле.
    email_masked: Optional[str] = None


class EmailTwoFactorSetupResponse(BaseModel):
    """Первый шаг включения почтовой 2FA: код ушёл на подтверждённый адрес."""
    sent: bool
    email_masked: str
    cooldown_seconds: int = 0


class EmailTwoFactorEnableRequest(BaseModel):
    """Подтверждение включения: код из письма + пароль (переподтверждение
    опасной операции, как и у TOTP)."""
    code: str
    password: str


class TwoFactorSetupResponse(BaseModel):
    totp_secret: str
    otpauth_url: str
    qr_png: Optional[str] = None  # data:image/png;base64 — для десктопов без нативного QR


class TwoFactorEnableRequest(BaseModel):
    """Подтверждение включения: код с приложения-аутентификатора + пароль
    (переподтверждение опасной операции)."""
    code: str
    password: str


class TwoFactorEnableResponse(BaseModel):
    """Коды показываются ровно один раз, поэтому приходят в открытом виде —
    дальше в БД только их bcrypt-хэши."""
    recovery_codes: List[str] = []


class TwoFactorDisableRequest(BaseModel):
    password: str


class EmailVerifyRequest(BaseModel):
    """Переход по ссылке из письма: /verify-email?token=…"""
    token: str


class EmailVerifyResponse(BaseModel):
    email_verified: bool = True
    # New registrations can continue directly into onboarding after the
    # verification link has authenticated the email owner.
    access_token: Optional[str] = None
    token_type: Optional[str] = None


class EmailResendRequest(BaseModel):
    """Повторная отправка письма. Пароль обязателен: без него любой перебором
    username засыпал бы чужой ящик письмами. На экране «проверьте почту»
    пароль уже введён, так что на UX это не влияет."""
    username: str
    password: str


class PasswordResetRequest(BaseModel):
    """Запрос всегда получает нейтральный ответ, чтобы не раскрывать email."""
    email: EmailStr


class PasswordResetConfirm(BaseModel):
    token: str
    new_password: str


class MessageResponse(BaseModel):
    message: str


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
    recommendation_id: Optional[str] = None
    recommendation_surface: Optional[str] = None
    recommendation_position: Optional[int] = None
    recommendation_score: Optional[float] = None
    recommendation_model_version: Optional[str] = None

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
    origin: str = "manual"
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
    # Provider-side popularity when the source exposes it (YT views,
    # SoundCloud playback_count).  Defaults keep older cached payloads valid.
    play_count: int = 0
    unique_listener_count: int = 0
    recommendation_id: Optional[str] = None
    recommendation_surface: Optional[str] = None
    recommendation_position: Optional[int] = None
    recommendation_score: Optional[float] = None
    recommendation_model_version: Optional[str] = None


class RecommendationResponse(BaseModel):
    # The home recommender may return a local ORM-backed item or a provider
    # candidate. Restricting this field to TrackResponse made the surface
    # inherently bounded by the materialized database catalogue.
    tracks: List[TrackResponse | ExternalTrackResponse] = []
    playlists: List[PlaylistResponse] = []


class RecommendationEventPayload(BaseModel):
    """Client feedback for local or provider-backed recommendation items."""
    event_type: str = Field(..., min_length=2, max_length=32)
    track_id: Optional[int] = Field(None, ge=1)
    source: Optional[str] = Field(None, max_length=32)
    external_id: Optional[str] = Field(None, max_length=512)
    title: Optional[str] = Field(None, max_length=512)
    artist: Optional[str] = Field(None, max_length=512)
    value: Optional[float] = None
    surface: Optional[str] = Field(None, max_length=64)
    position: Optional[int] = Field(None, ge=0, le=10000)
    request_id: Optional[str] = Field(None, max_length=128)
    algorithm_version: Optional[str] = Field(None, max_length=64)
    client_hour: Optional[int] = Field(None, ge=0, le=23)
    metadata: Optional[dict] = None


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


class ExternalAlbumResponse(BaseModel):
    """Релиз исполнителя (альбом/сингл/EP) — карточка в карусели на его странице.

    Отдельный тип, а не ExternalPlaylistResponse: у альбома нет владельца и
    ссылки для импорта, зато есть год и тип релиза — по ним карусель делится на
    «Альбомы» и «Синглы и EP».
    """
    id: str            # "ytmusic:MPREb_..." — стабильный key для фронта
    source: str
    external_id: str   # browseId альбома у провайдера
    title: str
    artist: Optional[str] = None
    year: Optional[str] = None
    cover_url: Optional[str] = None
    track_count: int = 0
    # "Album" | "Single" | "EP" — как отдаёт провайдер.
    album_type: Optional[str] = None


class ExternalAlbumDetail(BaseModel):
    album: ExternalAlbumResponse
    tracks: List[ExternalTrackResponse] = []


class AlbumSaveRequest(BaseModel):
    """Какой альбом положить в медиатеку (source + id релиза у провайдера)."""
    source: str
    external_id: str


class AlbumSaveResponse(BaseModel):
    """Итог сохранения альбома в медиатеку (поля те же, что у ArtistSaveResponse)."""
    playlist_id: int
    name: str
    created: bool  # плейлист создан (False — дополнили существующий)
    added: int     # сколько треков добавлено этим вызовом
    total: int     # сколько всего треков в плейлисте


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

    albums — дискография с YouTube Music (карусель над списком треков). Пустой
    список — обычное дело: у провайдера релизов может не быть, а сам он мог и
    не ответить.
    """
    name: str
    cover_url: Optional[str] = None
    tracks: List[TrackResponse] = []
    external: List[ExternalTrackResponse] = []
    albums: List[ExternalAlbumResponse] = []
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
