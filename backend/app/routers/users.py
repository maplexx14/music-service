import asyncio

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_
from sqlalchemy.orm import Session
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
import json
import logging
from pydantic import BaseModel, Field
from app.database import get_db
from app.cache import get_cache, set_cache, delete_cache, redis_client
from app.models import User, Track, UserPlayerState
from app.schemas import UserResponse, UserPreferencesUpdate, GenreOption, ArtistCard
from app import artist_cards
from app import lastfm_genres
from app.genre_keywords import GENRE_KEYWORDS, resolve_internal_key
from app.dependencies import get_current_active_user, get_current_admin_user
from app.routers.flow import _taste_profile
from app.routers.ytdlp import search_ytmusic_artists
from app.artist_utils import artist_key
from app.recommendation_cache import invalidate_recommendation_cache

router = APIRouter()

logger = logging.getLogger(__name__)


@router.get("/me", response_model=UserResponse)
async def get_current_user_info(current_user: User = Depends(get_current_active_user)):
    return current_user


# --- Музыкальные предпочтения (онбординг / настройки) ---
# NB: эти GET-маршруты обязаны идти ДО /{user_id}, иначе "genres"
# будет попадать в параметр user_id: int и давать 422.
@router.get("/genres", response_model=List[GenreOption])
async def list_genres():
    """Список жанров для выбора — теги Last.fm плюс наши ключи.

    Каталог собирает lastfm_genres (кэш в Redis, фолбэк на встроенный словарь,
    если Last.fm недоступен), поэтому здесь только отдача.
    """
    return [GenreOption(**option) for option in await lastfm_genres.genre_catalog_async()]


def _genre_filter(wanted: List[str]):
    """Условие «трек одного из жанров»: по Track.genre и по ключевым словам
    нашей ветки («hip-hop» ловит и «Rap», и «Хип-хоп»)."""
    patterns = set()
    for tag in wanted:
        patterns.add(tag.lower())
        key = resolve_internal_key(tag)
        if key:
            patterns.update(word.lower() for word in GENRE_KEYWORDS.get(key, []))
    return or_(*(Track.genre.ilike(f"%{p}%") for p in sorted(patterns)))


# Глубже подгрузка не ходит: дальше хвосты тегов Last.fm уже мимо жанра.
_ARTISTS_BY_GENRES_MAX = 300


@router.get("/artists/by-genres", response_model=List[str])
async def artists_by_genres(
    genres: List[str] = Query(default=[]),
    limit: int = 24,
    offset: int = 0,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Артисты под выбранные жанры — второй шаг онбординга.

    Источник — топ артистов тега в Last.fm (`tag.getTopArtists`), по кругу из
    каждого выбранного жанра. Не хватает — добираем самыми слушаемыми
    артистами локального каталога, но при выбранных жанрах только теми, чьи
    треки этих жанров: общий топ каталога делал подсказки одинаковыми для
    любых жанров (а с подгрузкой при прокрутке — заполнял ими всю сетку).
    Без жанров — весь каталог: подсказки должны
    быть непустыми даже без сети.
    """
    wanted: List[str] = []
    for raw in genres:
        # Клиент может прислать и ?genres=a&genres=b, и ?genres=a,b.
        for part in str(raw or "").split(","):
            name = part.strip()
            if name and name.lower() not in {w.lower() for w in wanted}:
                wanted.append(name)

    limit = min(max(limit, 1), 60)
    # offset — подгрузка сетки при прокрутке. Список строится детерминированно
    # (кэш Last.fm, стабильная сортировка), так что страница — срез одного и
    # того же списка длины offset + limit.
    offset = min(max(offset, 0), _ARTISTS_BY_GENRES_MAX - limit)
    total = offset + limit
    names: List[str] = []
    if wanted:
        names = await lastfm_genres.artists_for_genres_async(wanted, limit=total)

    if len(names) < total:
        existing = {artist_key(n) for n in names}
        # GROUP BY по всей таблице треков — в тредпул: хендлер async, и
        # синхронный SQLAlchemy в event loop останавливал весь воркер.
        query = db.query(Track.artist).filter(Track.artist.isnot(None))
        if wanted:
            query = query.filter(_genre_filter(wanted))
        rows = await asyncio.to_thread(
            query.group_by(Track.artist)
            .order_by(func.coalesce(func.sum(Track.play_count), 0).desc())
            .limit(total * 2)
            .all
        )
        for (artist,) in rows:
            if not artist or artist_key(artist) in existing:
                continue
            existing.add(artist_key(artist))
            names.append(artist)
            if len(names) >= total:
                break

    return names[offset:total]


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
    # Локальный GROUP BY — в тредпул (не держать event loop на SQL), и
    # параллельно с YouTube Music: эндпоинт дёргается на каждый ввод символа,
    # и последовательно ответ ждал сумму двух задержек.
    local_rows = asyncio.to_thread(
        query.group_by(Track.artist)
        .order_by(func.coalesce(func.sum(Track.play_count), 0).desc())
        .limit(min(max(limit, 1), 50))
        .all
    )
    if term:
        rows, yt_names = await asyncio.gather(
            local_rows, search_ytmusic_artists(term, limit=limit)
        )
    else:
        rows = await local_rows
    local_names = [r[0] for r in rows if r[0]]

    merged: List[str] = list(local_names)
    existing_keys = {artist_key(n) for n in merged}
    for name in yt_names:
        if artist_key(name) not in existing_keys:
            existing_keys.add(artist_key(name))
            merged.append(name)

    return merged[:limit]


def _clean_names(raw: List[str], cap: int) -> List[str]:
    # Имена списком повторяющегося параметра (?names=a&names=b), не через
    # запятую: запятая бывает в самом имени («Tyler, The Creator»).
    return [name.strip() for name in raw if name and name.strip()][:cap]


@router.get("/artists/cards", response_model=List[ArtistCard])
async def artist_cards_for_names(
    names: List[str] = Query(default=[]),
    current_user: User = Depends(get_current_active_user),
):
    """Фото и число фанатов для имён из подсказок.

    Отдельно от /by-genres и /suggest: имена там приходят мгновенно из
    Last.fm/каталога, а карточки дозагружаются, не задерживая сетку.
    """
    return await artist_cards.artist_cards(_clean_names(names, 60))


@router.get("/artists/similar", response_model=List[ArtistCard])
async def similar_artist_cards(
    artist: str,
    limit: int = 3,
    exclude: List[str] = Query(default=[]),
    current_user: User = Depends(get_current_active_user),
):
    """Похожие на выбранного артиста — сетка онбординга вставляет их рядом
    с ним. exclude — имена, уже показанные в сетке."""
    return await artist_cards.similar_cards(
        artist, limit=min(max(limit, 1), 12), exclude=_clean_names(exclude, 200)
    )


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

    Жанры валидируются ОФФЛАЙН-данными (наши ключи + теги, которые узнаёт
    beets — см. lastfm_genres.is_known_genre): каталог для выбора приходит из
    Last.fm, поэтому сводить его к 12 ключам нельзя, а зависеть от сети при
    сохранении — нельзя тем более. Артисты чистятся от пустых/дублей.
    """
    valid_genres = [
        g
        for g in dict.fromkeys(
            str(raw).strip().lower() for raw in prefs.preferred_genres if raw
        )
        if lastfm_genres.is_known_genre(g)
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
    explicit_keys = {artist_key(name) for name in artists}
    excluded: List[str] = []
    seen_excluded = set()
    for raw in prefs.excluded_artists:
        name = (raw or "").strip()
        key = artist_key(name)
        if name and key and key not in explicit_keys and key not in seen_excluded:
            seen_excluded.add(key)
            excluded.append(name)
    current_user.excluded_artists = excluded[:50]
    # Мягкий prior на открытие новых артистов. Не прислали — не трогаем: клиент,
    # который сохраняет только жанры, не должен сбрасывать баланс в дефолт.
    if prefs.discovery_ratio is not None:
        current_user.discovery_ratio = round(float(prefs.discovery_ratio), 2)
    db.commit()
    db.refresh(current_user)
    # Следующий запрос должен сразу учитывать новый выбор, а не отдавать
    # пятиминутную выдачу, построенную до сохранения предпочтений.
    invalidate_recommendation_cache(current_user.id)
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


def _online_user_ids() -> set:
    """Id юзеров с живым presence-маркером в Redis (TTL 120 с, см. dependencies)."""
    try:
        return {
            int(key.rsplit(":", 1)[-1])
            for key in redis_client.scan_iter(match="users:online:*")
        }
    except Exception:
        logger.exception("failed to read online markers")
        return set()


# Профиль вкуса для карточки админки живёт в Redis: _taste_profile — это
# полдесятка запросов и проход по всей коллекции юзера, а панель открывают
# повторно (кнопка «Обновить», возврат на вкладку). Для админки хватает
# свежести в несколько минут — это справка, а не сигнал для волны.
_ADMIN_TASTE_TTL = 600


def _admin_taste(db: Session, user_id: int) -> dict:
    cache_key = f"admin:taste:{user_id}"
    cached = get_cache(cache_key)
    if cached is not None:
        return cached
    # Профиль вкуса — самая хрупкая часть дашборда (он читает лайки,
    # историю и плейлисты). Один пользователь с битыми данными не должен
    # ронять всю панель: его карточка просто едет без detected_*.
    try:
        detected = _taste_profile(db, user_id) or {}
    except Exception:
        logger.exception("taste profile failed for user %s", user_id)
        db.rollback()
        return {"detected_genres": [], "detected_artists": []}
    result = {
        "detected_genres": sorted((detected.get("genre_counts") or {}).keys())[:12],
        "detected_artists": (detected.get("artists") or [])[:12],
    }
    set_cache(cache_key, result, expire=_ADMIN_TASTE_TTL)
    return result


def _admin_profile(db: Session, user: User, online_ids: set, with_taste: bool = True) -> dict:
    profile = {
        "id": user.id,
        "username": user.username,
        "email": user.email,
        "preferred_genres": user.preferred_genres or [],
        "preferred_artists": user.preferred_artists or [],
        "created_at": user.created_at,
        "last_seen": user.last_seen,
        "is_online": user.id in online_ids,
        "is_active": user.is_active,
    }
    if with_taste:
        profile.update(_admin_taste(db, user.id))
    return profile


def _admin_users_page(
    db: Session, online_ids: set, limit: int, offset: int, with_taste: bool = True
) -> tuple:
    """Страница профилей, отсортированных по последнему онлайну.

    Онлайн-юзеры попадают наверх без отдельной сортировки: presence-маркер
    живёт 120 с, а last_seen пишется минимум раз в минуту, так что у всех
    кто в сети, он свежее, чем у остальных. NULL (никогда не заходил после
    появления колонки) — в конце.
    """
    query = db.query(User).order_by(
        User.last_seen.desc().nullslast(), User.created_at.desc()
    )
    total = query.count()
    users = query.limit(limit).offset(offset).all()
    return total, [_admin_profile(db, user, online_ids, with_taste) for user in users]


@router.get("/admin/dashboard")
def get_admin_dashboard(
    taste: bool = Query(default=True),
    current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """Dashboard metrics and safe user profiles for administrators.

    Профили приезжают первой страницей (USERS_PAGE_SIZE); остальное панель
    догружает по /admin/users — прогонять _taste_profile по всем юзерам
    сразу значило бы делать панель линейно дороже с каждым регистрацией.

    taste=false отдаёт профили без detected_* — панель показывается сразу, а
    профили вкуса догружает отдельно через /admin/users/taste.
    """
    online_ids = _online_user_ids()
    users_total, profiles = _admin_users_page(
        db, online_ids, limit=50, offset=0, with_taste=taste
    )
    # COUNT(DISTINCT artist) — полный проход по таблице треков; каталог за
    # минуты не меняется, поэтому счётчики кэшируются как users:count.
    catalog = get_cache("admin:catalog_counts")
    if catalog is None:
        catalog = {
            "tracks_count": db.query(Track).count(),
            "artists_count": db.query(func.count(func.distinct(Track.artist))).scalar() or 0,
        }
        set_cache("admin:catalog_counts", catalog, expire=120)
    return {
        "users_count": users_total,
        "online_users_count": len(online_ids),
        **catalog,
        "users": profiles,
        "users_total": users_total,
    }


@router.get("/admin/users")
def get_admin_users(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    taste: bool = Query(default=True),
    current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """Следующая страница профилей для ленивой загрузки админ-панели."""
    online_ids = _online_user_ids()
    total, profiles = _admin_users_page(db, online_ids, limit, offset, with_taste=taste)
    return {"total": total, "users": profiles}


@router.get("/admin/users/taste")
def get_admin_users_taste(
    ids: str = Query(..., description="id через запятую"),
    current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """Профили вкуса (detected_*) для уже показанных карточек админки."""
    try:
        user_ids = list(dict.fromkeys(int(raw) for raw in ids.split(",") if raw.strip()))
    except ValueError:
        raise HTTPException(status_code=422, detail="ids must be comma-separated integers")
    if len(user_ids) > 200:
        raise HTTPException(status_code=422, detail="too many ids")
    return {"profiles": {str(uid): _admin_taste(db, uid) for uid in user_ids}}


# «Что сейчас играет» — эфемерное состояние плеера, в БД ему не место: клиент
# шлёт его на смене трека/паузе и пульсом раз в NOW_PLAYING_HEARTBEAT с, ключ
# живёт NOW_PLAYING_TTL. Закрытая вкладка просто перестаёт пульсировать, и
# юзер пропадает из «сейчас слушает» без явного запроса на выход — как с
# presence-маркером users:online:*.
NOW_PLAYING_TTL = 90
_NOW_PLAYING_PREFIX = "users:now_playing:"


class NowPlayingPayload(BaseModel):
    # Внешние треки (ytmusic/soundcloud) ещё не в БД, поэтому id — строка,
    # а название/артист/обложка приходят от клиента, а не из Track.
    track_id: Optional[str] = Field(None, max_length=200)
    title: str = Field(..., max_length=300)
    artist: Optional[str] = Field(None, max_length=300)
    cover_url: Optional[str] = Field(None, max_length=1000)
    source: Optional[str] = Field(None, max_length=40)
    position: float = Field(0, ge=0)
    duration: float = Field(0, ge=0)
    is_playing: bool = True


@router.put("/me/now-playing")
def update_now_playing(
    payload: NowPlayingPayload,
    current_user: User = Depends(get_current_active_user),
):
    state = payload.model_dump()
    state["updated_at"] = datetime.now(timezone.utc).isoformat()
    set_cache(f"{_NOW_PLAYING_PREFIX}{current_user.id}", state, expire=NOW_PLAYING_TTL)
    return {"ok": True}


@router.delete("/me/now-playing")
def clear_now_playing(current_user: User = Depends(get_current_active_user)):
    delete_cache(f"{_NOW_PLAYING_PREFIX}{current_user.id}")
    return {"ok": True}


# --- Состояние плеера между устройствами (см. models.UserPlayerState) ---

# Снимок несёт окно очереди до ~300 треков с метаданными; потолок с запасом,
# чтобы один клиент не мог складывать в БД мегабайты.
PLAYER_STATE_MAX_BYTES = 1_000_000
# Снимок живёт двое суток: позже продолжать с того же места уже не ждут.
# Срок считаем по updated_at сервера — часам клиента (saved_at) не верим.
PLAYER_STATE_TTL = timedelta(hours=48)


class PlayerStatePayload(BaseModel):
    state: Dict[str, Any]
    saved_at: float = Field(..., ge=0)


@router.get("/me/player-state")
def get_player_state(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    row = db.get(UserPlayerState, current_user.id)
    if not row:
        return {"state": None, "saved_at": None}
    updated_at = row.updated_at
    if updated_at is not None and updated_at.tzinfo is None:
        # sqlite отдаёт func.now() без зоны, но это UTC.
        updated_at = updated_at.replace(tzinfo=timezone.utc)
    if updated_at is not None and datetime.now(timezone.utc) - updated_at > PLAYER_STATE_TTL:
        db.delete(row)
        db.commit()
        return {"state": None, "saved_at": None}
    return {"state": row.state, "saved_at": row.saved_at}


@router.put("/me/player-state")
def save_player_state(
    payload: PlayerStatePayload,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    if len(json.dumps(payload.state, ensure_ascii=False).encode()) > PLAYER_STATE_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Player state too large")
    row = db.get(UserPlayerState, current_user.id)
    if row is None:
        row = UserPlayerState(user_id=current_user.id)
        db.add(row)
    row.state = payload.state
    row.saved_at = payload.saved_at
    db.commit()
    return {"ok": True}


# Юзер выключил запоминание в настройках — забываем и серверную копию.
@router.delete("/me/player-state")
def delete_player_state(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    row = db.get(UserPlayerState, current_user.id)
    if row is not None:
        db.delete(row)
        db.commit()
    return {"ok": True}


@router.get("/admin/now-playing")
def get_admin_now_playing(current_user: User = Depends(get_current_admin_user)):
    """Текущее состояние плееров всех, у кого живой now-playing ключ.

    Ответ — {user_id: state}; панель опрашивает его часто и вливает в уже
    показанные карточки, поэтому здесь только Redis, без запросов в БД.
    """
    try:
        keys = list(redis_client.scan_iter(match=f"{_NOW_PLAYING_PREFIX}*", count=200))
        values = redis_client.mget(keys) if keys else []
    except Exception:
        logger.exception("failed to read now-playing states")
        return {"now_playing": {}}
    result = {}
    for key, raw in zip(keys, values):
        if not raw:
            continue
        try:
            result[key.rsplit(":", 1)[-1]] = json.loads(raw)
        except ValueError:
            continue
    return {"now_playing": result}


@router.get("/{user_id}", response_model=UserResponse)
def get_user(user_id: int, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user
