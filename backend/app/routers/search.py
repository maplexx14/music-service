from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from sqlalchemy import and_, case, or_
from app.database import get_db
from app.cache import get_cache, set_cache
from app.models import Track, Playlist, User
from app.schemas import SearchResponse, TrackResponse, PlaylistSummaryResponse, UserResponse
from app.dependencies import get_current_user_optional

router = APIRouter()

_SEARCH_TTL = 180
# Плейлистов и пользователей в выдаче нужно немного: лимит поднимают ради
# треков артиста, а не ради полусотни плейлистов и тёзок в юзернеймах.
_SECONDARY_LIMIT = 20


def _like_pattern(token: str) -> str:
    """Экранирует спецсимволы LIKE: '%' и '_' из запроса — это литералы."""
    escaped = token.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _all_tokens_match(tokens: list[str], columns: tuple):
    """Каждое слово запроса должно найтись хотя бы в одной из колонок.

    Раньше вся строка искалась одним LIKE по каждой колонке по отдельности,
    поэтому 'linkin park numb' не находил ничего: целиком эта строка не
    встречается ни в title, ни в artist, ни в album.
    """
    return and_(
        *[
            or_(*[col.ilike(_like_pattern(token), escape="\\") for col in columns])
            for token in tokens
        ]
    )


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

    tokens = normalized_q.split()
    if not tokens:
        # q из одних пробелов: min_length=1 такое пропускает, а пустой and_()
        # выродился бы в TRUE и отдал всю библиотеку.
        return SearchResponse(tracks=[], playlists=[], users=[])

    secondary_limit = min(limit, _SECONDARY_LIMIT)

    tracks = (
        db.query(Track)
        .filter(_all_tokens_match(tokens, (Track.title, Track.artist, Track.album)))
        # Треки самого артиста — выше тех, где запрос лишь мелькнул в названии
        # или альбоме. Иначе при поиске по имени артиста лимит выдачи съедали
        # чужие треки с большим play_count, и до его собственных дело не доходило.
        .order_by(
            case((_all_tokens_match(tokens, (Track.artist,)), 0), else_=1),
            Track.play_count.desc(),
            Track.created_at.desc(),
        )
        .limit(limit)
        .all()
    )

    # Search playlists (summary-схема без треков — выдача их не рендерит).
    # Публичные — всем; приватные — только их владельцу.
    visibility = Playlist.is_public == True
    if current_user is not None:
        visibility = or_(visibility, Playlist.owner_id == current_user.id)
    playlists = (
        db.query(Playlist)
        .filter(_all_tokens_match(tokens, (Playlist.name, Playlist.description)))
        .filter(visibility)
        .limit(secondary_limit)
        .all()
    )

    # Search users
    users = (
        db.query(User)
        .filter(_all_tokens_match(tokens, (User.username, User.full_name)))
        .filter(User.is_active == True)
        .limit(secondary_limit)
        .all()
    )

    response = SearchResponse(
        tracks=[TrackResponse.model_validate(t) for t in tracks],
        playlists=[PlaylistSummaryResponse.model_validate(p) for p in playlists],
        users=[UserResponse.model_validate(u) for u in users]
    )
    set_cache(cache_key, response.model_dump(mode="json"), expire=_SEARCH_TTL)
    return response
