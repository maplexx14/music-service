"""Страница исполнителя: все его треки одним плейлистом.

Порядок источников тот же, что в поиске: сначала библиотека (эти треки уже в
БД — у них есть id, лайк и добавление в плейлист работают без материализации),
затем каталог YouTube Music, затем SoundCloud. Дубли между источниками
схлопываются, причём библиотека имеет приоритет: если трек уже сохранён,
внешняя копия в списке не повторяется.
"""
import asyncio
import logging
from typing import List

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import case, func, or_
from sqlalchemy.orm import Session

from app.artist_utils import artist_key, query_names_artist, split_artists
from app.database import get_db
from app.models import Track
from app.routers import soundcloud, ytdlp
from app.routers.aggregate import dedup_key, dedup_sequential
from app.schemas import ArtistPageResponse, ExternalTrackResponse, TrackResponse

logger = logging.getLogger(__name__)

router = APIRouter()


def _like_pattern(token: str) -> str:
    """Экранирует спецсимволы LIKE: '%' и '_' из имени — это литералы."""
    escaped = token.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _local_tracks(db: Session, name: str, limit: int) -> List[Track]:
    """Треки исполнителя из библиотеки.

    Точное совпадение имени — вперёд, но берём и вхождение подстрокой: в БД
    исполнитель совместного трека записан склеенной строкой («A, B», «A feat.
    B»), и на странице B такой трек тоже должен быть.
    """
    key = artist_key(name)
    exact = func.lower(func.trim(Track.artist)) == key
    return (
        db.query(Track)
        .filter(or_(exact, Track.artist.ilike(_like_pattern(name), escape="\\")))
        .order_by(
            case((exact, 0), else_=1),
            Track.play_count.desc(),
            Track.created_at.desc(),
        )
        .limit(limit)
        .all()
    )


def _by_this_artist(track: ExternalTrackResponse, name: str) -> bool:
    """Трек действительно этого исполнителя, а не просто нашёлся по строке.

    SoundCloud ищет по всему тексту, поэтому на «Nirvana» он отдаёт и каверы, и
    чужие треки со словом в названии. На странице артиста такому не место.
    Строку исполнителя разбираем на участников: у совместного трека («A, B»)
    имя искомого артиста — только одна из частей.
    """
    return any(query_names_artist(name, part) for part in split_artists(track.artist))


@router.get("", response_model=ArtistPageResponse)
async def artist_page(
    request: Request,
    name: str = Query(..., min_length=1),
    limit: int = Query(60, ge=1, le=100),
    db: Session = Depends(get_db),
):
    """Всё, что у нас есть по этому исполнителю.

    Имя приходит параметром запроса, а не куском пути: в именах встречаются и
    «/», и точки, и знаки, которые прокси нормализует по-своему — с query
    экранирование одно и работает везде.

    Внешние источники опрашиваются параллельно и их падение не фатально:
    страница должна открываться даже когда провайдер недоступен — библиотека
    всё равно покажется.
    """
    display = name.strip()

    local = _local_tracks(db, display, limit)

    profile, sc = await asyncio.gather(
        ytdlp.ytmusic_artist_profile(request, display, limit=limit),
        soundcloud.search_soundcloud(request, display, limit=limit),
        return_exceptions=True,
    )

    if isinstance(profile, Exception):
        logger.warning("ytmusic artist profile failed for %s: %s", display, profile)
        profile = {"name": display, "cover_url": None, "tracks": []}
    if isinstance(sc, Exception):
        logger.warning("soundcloud artist search failed for %s: %s", display, sc)
        sc = []

    # Библиотека занимает ключи первой — внешний дубль уже сохранённого трека
    # в список не попадёт.
    seen = {dedup_key(t) for t in local}
    external = dedup_sequential(profile.get("tracks") or [], limit, seen)
    external += dedup_sequential(
        [t for t in sc if _by_this_artist(t, display)], limit, seen
    )

    tracks = [TrackResponse.model_validate(t) for t in local]

    # Обложка: аватар с YouTube Music, иначе первая непустая обложка трека —
    # шапка страницы не должна оставаться пустым квадратом. Берём уже
    # сериализованные треки: TrackResponse чинит legacy-ссылки на MinIO.
    cover = profile.get("cover_url") or next(
        (t.cover_url for t in [*tracks, *external] if t.cover_url), None
    )

    return ArtistPageResponse(
        name=profile.get("name") or display,
        cover_url=cover,
        tracks=tracks,
        external=external,
    )
