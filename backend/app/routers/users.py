from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session
from typing import List
from app.database import get_db
from app.cache import get_cache, set_cache
from app.models import User, Track
from app.schemas import UserResponse, UserPreferencesUpdate, GenreOption
from app.genre_keywords import GENRE_KEYWORDS, GENRE_LABELS
from app.dependencies import get_current_active_user, get_current_admin_user
from app.routers.flow import _taste_profile
from app.routers.ytdlp import search_ytmusic_artists
from app.artist_utils import artist_key

router = APIRouter()


@router.get("/me", response_model=UserResponse)
async def get_current_user_info(current_user: User = Depends(get_current_active_user)):
    return current_user


# --- Музыкальные предпочтения (онбординг / настройки) ---
# NB: эти GET-маршруты обязаны идти ДО /{user_id}, иначе "genres"
# будет попадать в параметр user_id: int и давать 422.
@router.get("/genres", response_model=List[GenreOption])
def list_genres():
    """Список доступных жанров из встроенного словаря."""
    return [
        GenreOption(key=key, label=GENRE_LABELS.get(key, key.title()))
        for key in GENRE_KEYWORDS.keys()
    ]


@router.get("/artists/suggest", response_model=List[str])
async def suggest_artists(
    q: str = "",
    limit: int = 20,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Подсказки артистов: локальный каталог + YouTube Music."""
    term = (q or "").strip()
    local_names: List[str] = []
    yt_names: List[str] = []

    query = db.query(Track.artist).filter(Track.artist.isnot(None))
    if term:
        query = query.filter(Track.artist.ilike(f"%{term}%"))
    rows = (
        query.group_by(Track.artist)
        .order_by(func.coalesce(func.sum(Track.play_count), 0).desc())
        .limit(min(max(limit, 1), 50))
        .all()
    )
    local_names = [r[0] for r in rows if r[0]]

    if term:
        yt_names = await search_ytmusic_artists(term, limit=limit)

    merged: List[str] = list(local_names)
    existing_keys = {artist_key(n) for n in merged}
    for name in yt_names:
        if artist_key(name) not in existing_keys:
            existing_keys.add(artist_key(name))
            merged.append(name)

    return merged[:limit]


@router.get("/me/taste")
def get_detected_taste(
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db),
):
    """Предпочтения, ВЫВЕДЕННЫЕ из прослушиваний (лайки, плейлисты, история).

    Тот же профиль, по которому строится волна (flow._taste_profile), — чтобы
    в настройках юзер видел, что сервис о нём понял, и мог перенести это в
    свой явный выбор. Жанры фильтруем по словарю: в Track.genre встречаются
    произвольные строки от провайдеров, а в предпочтениях храним только ключи.
    """
    profile = _taste_profile(db, current_user.id)
    counts = profile.get("genre_counts") or {}
    genres = sorted(
        (g for g in counts if g in GENRE_KEYWORDS), key=lambda g: -counts[g]
    )
    return {"genres": genres[:12], "artists": (profile.get("artists") or [])[:12]}


@router.put("/me/preferences", response_model=UserResponse)
def update_preferences(
    prefs: UserPreferencesUpdate,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db),
):
    """Обновляет явные предпочтения пользователя.

    Жанры валидируются по словарю (храним только известные ключи),
    артисты — чистятся от пустых/дублей и ограничиваются.
    """
    valid_genres = [
        g for g in dict.fromkeys(prefs.preferred_genres) if g in GENRE_KEYWORDS
    ]
    artists: List[str] = []
    seen = set()
    for raw in prefs.preferred_artists:
        name = (raw or "").strip()
        key = name.lower()
        if name and key not in seen:
            seen.add(key)
            artists.append(name)
    current_user.preferred_genres = valid_genres[:20]
    current_user.preferred_artists = artists[:50]
    db.commit()
    db.refresh(current_user)
    return current_user


@router.get("/stats/count")
def get_user_count(
    current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db)
):
    cached = get_cache("users:count")
    if cached is not None:
        return cached
    total = db.query(User).count()
    result = {"total": total}
    set_cache("users:count", result, expire=300)
    return result


@router.get("/{user_id}", response_model=UserResponse)
def get_user(user_id: int, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user
