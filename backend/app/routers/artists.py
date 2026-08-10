"""Страница исполнителя: все его треки одним плейлистом.

Порядок источников тот же, что в поиске: сначала библиотека (эти треки уже в
БД — у них есть id, лайк и добавление в плейлист работают без материализации),
затем каталог YouTube Music, затем SoundCloud. Дубли между источниками
схлопываются, причём библиотека имеет приоритет: если трек уже сохранён,
внешняя копия в списке не повторяется.

Здесь же действия над исполнителем: лайк (кладём в User.preferred_artists,
откуда его читает волна) и сохранение его плейлиста в медиатеку.
"""
import asyncio
import logging
from typing import List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import case, false, func, insert, or_
from sqlalchemy.orm import Session

from app.artist_utils import (
    query_names_artist,
    same_artist,
    split_artists,
    translit_key,
)
from app.database import get_db
from app.dependencies import get_current_active_user, get_current_user_optional
from app.models import Playlist, Track, User, playlist_tracks
from app.routers import soundcloud, ytdlp
from app.routers.aggregate import dedup_key, dedup_sequential
from app.routers.tracks import get_or_create_external_track
from app.schemas import (
    ArtistLikeResponse,
    ArtistNameRequest,
    ArtistPageResponse,
    ArtistSaveResponse,
    ArtistSummary,
    ExternalTrackImport,
    ExternalTrackResponse,
    TrackResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter()

# Столько же, сколько влезает в явные предпочтения через настройки
# (users.update_preferences) — лимит один на оба пути записи.
_MAX_PREFERRED_ARTISTS = 50


def _like_pattern(token: str) -> str:
    """Экранирует спецсимволы LIKE: '%' и '_' из имени — это литералы."""
    escaped = token.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _library_spellings(db: Session, name: str) -> Tuple[List[str], List[str]]:
    """Написания этого артиста в Track.artist: (сольные, в коллаборациях).

    Один артист лежит в БД под разными именами: «Zemfira» приехала из
    SoundCloud, «Земфира» — из YouTube Music. Сопоставить их в SQL нечем,
    транслитерация живёт в Python, поэтому берём список исполнителей (DISTINCT
    по одной колонке, а не выгрузка таблицы) и сверяем ключи здесь.

    Разделение на две группы нужно порядку выдачи: сольный трек стоит выше
    совместного, как и было при точном сравнении имён.
    """
    key = translit_key(name)
    if not key:
        return [], []

    solo: List[str] = []
    collab: List[str] = []
    for (value,) in db.query(Track.artist).distinct():
        parts = split_artists(value or "")
        if not any(translit_key(p) == key for p in parts):
            continue
        (solo if len(parts) == 1 else collab).append(value)
    return solo, collab


def _local_tracks(db: Session, name: str, limit: int) -> List[Track]:
    """Треки исполнителя из библиотеки.

    Сольные треки — вперёд, но берём и совместные: у коллаборации исполнитель
    записан склеенной строкой («A, B», «A feat. B»), и на странице B такой трек
    тоже должен быть.

    Три условия отбора, а не одно: первые два — известные написания имени (см.
    _library_spellings), третье — вхождение подстрокой, которое ловит то, что
    разделителями не разбирается («Земфира и друзья»).
    """
    solo, collab = _library_spellings(db, name)

    exact = Track.artist.in_(solo) if solo else false()
    return (
        db.query(Track)
        .filter(
            or_(
                exact,
                Track.artist.in_(collab) if collab else false(),
                Track.artist.ilike(_like_pattern(name), escape="\\"),
            )
        )
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


async def _collect_tracks(
    request: Request, db: Session, name: str, limit: int
) -> Tuple[dict, List[Track], List[ExternalTrackResponse]]:
    """Треки исполнителя из всех источников: (профиль, библиотека, внешние).

    Общая часть страницы артиста и сохранения его плейлиста в медиатеку —
    оба должны собирать один и тот же список, иначе сохранится не то, что
    пользователь видел.

    Внешние источники опрашиваются параллельно, и их падение не фатально:
    страница обязана открываться даже когда провайдер недоступен — библиотека
    всё равно покажется.
    """
    local = _local_tracks(db, name, limit)

    profile, sc = await asyncio.gather(
        ytdlp.ytmusic_artist_profile(request, name, limit=limit),
        soundcloud.search_soundcloud(request, name, limit=limit),
        return_exceptions=True,
    )

    if isinstance(profile, Exception):
        logger.warning("ytmusic artist profile failed for %s: %s", name, profile)
        profile = {"name": name, "cover_url": None, "tracks": []}
    if isinstance(sc, Exception):
        logger.warning("soundcloud artist search failed for %s: %s", name, sc)
        sc = []

    # Библиотека занимает ключи первой — внешний дубль уже сохранённого трека
    # в список не попадёт.
    seen = {dedup_key(t) for t in local}
    external = dedup_sequential(profile.get("tracks") or [], limit, seen)
    external += dedup_sequential(
        [t for t in sc if _by_this_artist(t, name)], limit, seen
    )

    return profile, local, external


def _saved_playlist(db: Session, user: User, name: str) -> Optional[Playlist]:
    """Плейлист этого исполнителя в медиатеке пользователя (если сохранён).

    Имя сверяется через same_artist, а не равенством: подборка могла быть
    сохранена под «Zemfira», а страница теперь зовётся «Земфира» — по точному
    совпадению повторное сохранение завело бы второй плейлист на того же
    артиста. Плейлистов у пользователя десятки, так что сверка в Python
    дешевле, чем попытка выразить транслитерацию в SQL.
    """
    return next(
        (
            p
            for p in db.query(Playlist).filter(Playlist.owner_id == user.id)
            if same_artist(p.name, name)
        ),
        None,
    )


def _is_liked(user: Optional[User], name: str) -> bool:
    """Артист в избранном — под любым из своих написаний.

    Лайк ставился со страницы «Земфира», а открыта «Zemfira» — сердце должно
    гореть на обеих: страница одна и та же, разошлось только написание имени.
    """
    if user is None:
        return False
    return any(same_artist(a, name) for a in (user.preferred_artists or []))


@router.get("", response_model=ArtistPageResponse)
async def artist_page(
    request: Request,
    name: str = Query(..., min_length=1),
    limit: int = Query(60, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User | None = Depends(get_current_user_optional),
):
    """Всё, что у нас есть по этому исполнителю.

    Имя приходит параметром запроса, а не куском пути: в именах встречаются и
    «/», и точки, и знаки, которые прокси нормализует по-своему — с query
    экранирование одно и работает везде.
    """
    display = name.strip()
    profile, local, external = await _collect_tracks(request, db, display, limit)

    tracks = [TrackResponse.model_validate(t) for t in local]

    # Обложка: аватар с YouTube Music, иначе первая непустая обложка трека —
    # шапка страницы не должна оставаться пустым квадратом. Берём уже
    # сериализованные треки: TrackResponse чинит legacy-ссылки на MinIO.
    cover = profile.get("cover_url") or next(
        (t.cover_url for t in [*tracks, *external] if t.cover_url), None
    )

    canonical = profile.get("name") or display
    saved = _saved_playlist(db, current_user, canonical) if current_user else None

    return ArtistPageResponse(
        name=canonical,
        cover_url=cover,
        tracks=tracks,
        external=external,
        is_liked=_is_liked(current_user, canonical) or _is_liked(current_user, display),
        playlist_id=saved.id if saved else None,
    )


@router.get("/search", response_model=List[ArtistSummary])
async def search_artists(
    q: str = Query(..., min_length=1),
    limit: int = Query(6, ge=1, le=20),
    db: Session = Depends(get_db),
):
    """Исполнители по строке поиска — карточки для секции «Исполнители».

    Сначала свои (у кого в медиатеке есть треки — их пользователь ищет чаще),
    затем YouTube Music. Обложка локального артиста — обложка его самого
    слушаемого трека: отдельной картинки артиста в БД нет.
    """
    term = q.strip()

    # Берём верхушку по прослушиваниям и группируем в Python: нужен не только
    # список имён, но и обложка, а тянуть её отдельным запросом на каждого
    # артиста — лишние round-trip'ы на каждое нажатие клавиши в поиске.
    #
    # Кроме вхождения подстрокой берём и написания из другого алфавита: на
    # запрос «Земфира» пометка «в медиатеке» должна появиться и тогда, когда
    # треки лежат под именем «Zemfira». Для куска слова («зем») список
    # написаний пуст — там работает один ilike.
    solo, collab = _library_spellings(db, term)
    spellings = solo + collab
    rows = (
        db.query(Track)
        .filter(
            or_(
                Track.artist.ilike(_like_pattern(term), escape="\\"),
                Track.artist.in_(spellings) if spellings else false(),
            )
        )
        .order_by(Track.play_count.desc(), Track.created_at.desc())
        .limit(60)
        .all()
    )

    out: List[ArtistSummary] = []
    # Ключ карточки — translit_key, а не имя: «Земфира» из медиатеки и
    # «Zemfira» из YouTube Music это один артист, и двумя карточками на один
    # и тот же каталог выдача выглядит сломанной.
    by_key: dict = {}
    for track in rows:
        for part in split_artists(track.artist):
            # Часть склеенной строки, не совпавшая с запросом, — чужой артист
            # из коллаборации: в выдаче по «Nirvana» ему не место.
            if not query_names_artist(term, part) and term.lower() not in part.lower():
                continue
            key = translit_key(part)
            if key in by_key:
                continue
            card = ArtistSummary(name=part, cover_url=track.cover_url, in_library=True)
            by_key[key] = card
            out.append(card)
            if len(out) >= limit:
                return out

    for card in await ytdlp.search_ytmusic_artist_cards(term, limit=limit):
        key = translit_key(card["name"])
        known = by_key.get(key)
        if known is not None:
            # Тот же артист под другим написанием. Имя берём отсюда: у
            # YouTube Music оно каноническое, а в медиатеке лежит то, как
            # артиста назвал источник импорта. Пометку «в медиатеке» и уже
            # найденную обложку сохраняем — карточка та же, сменилась подпись.
            known.name = card["name"]
            known.cover_url = known.cover_url or card.get("cover_url")
            continue
        summary = ArtistSummary(name=card["name"], cover_url=card.get("cover_url"))
        by_key[key] = summary
        out.append(summary)
        if len(out) >= limit:
            break

    return out


@router.post("/like", response_model=ArtistLikeResponse)
def toggle_artist_like(
    payload: ArtistNameRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Переключает исполнителя в избранном (User.preferred_artists).

    Отдельного «лайка артиста» в схеме нет, и заводить его незачем: явные
    предпочтения уже есть и уже читаются волной и рекомендациями — лайк со
    страницы артиста пишет ровно туда же, куда выбор в онбординге.
    """
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Имя исполнителя не может быть пустым")

    current = list(current_user.preferred_artists or [])
    kept = [a for a in current if not same_artist(a, name)]
    liked = len(kept) == len(current)  # ничего не выкинули → артиста не было
    if liked:
        kept.append(name)

    # JSON-колонка: список нужно ПЕРЕПРИСВОИТЬ, мутация на месте не помечает
    # объект грязным и commit молча ничего не сохранит.
    # При переполнении вытесняем самых старых, а не только что добавленного.
    current_user.preferred_artists = kept[-_MAX_PREFERRED_ARTISTS:]
    db.commit()

    return ArtistLikeResponse(name=name, liked=liked)


@router.post("/library", response_model=ArtistSaveResponse)
async def save_artist_playlist(
    payload: ArtistNameRequest,
    request: Request,
    limit: int = Query(60, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Сохраняет плейлист исполнителя в медиатеку пользователя.

    Внешние треки при этом материализуются в БД (get_or_create_external_track):
    в плейлист можно положить только запись с числовым id, а без сохранения
    подборка развалилась бы при следующем перезапуске выдачи провайдера.

    Повторный вызов не плодит копии: плейлист с этим именем дополняется теми
    треками, которых в нём ещё нет (у артиста мог выйти новый релиз).
    """
    display = payload.name.strip()
    if not display:
        raise HTTPException(status_code=400, detail="Имя исполнителя не может быть пустым")

    profile, local, external = await _collect_tracks(request, db, display, limit)
    canonical = profile.get("name") or display

    if not local and not external:
        raise HTTPException(status_code=404, detail="Треков этого исполнителя не нашлось")

    cover = profile.get("cover_url") or next(
        (t.cover_url for t in [*local, *external] if t.cover_url), None
    )

    playlist = _saved_playlist(db, current_user, canonical)
    created = playlist is None
    if created:
        playlist = Playlist(
            name=canonical,
            description=f"Все треки исполнителя {canonical}",
            cover_url=cover,
            is_public=False,  # личная подборка, а не публикация
            owner_id=current_user.id,
        )
        db.add(playlist)
        db.commit()
        db.refresh(playlist)

    existing_ids = {t.id for t in playlist.tracks}

    track_ids: List[int] = [t.id for t in local]
    for ext in external:
        try:
            saved = get_or_create_external_track(
                db,
                ExternalTrackImport(
                    source=ext.source,
                    external_id=ext.external_id,
                    title=ext.title,
                    artist=ext.artist,
                    album=ext.album,
                    duration=ext.duration,
                    cover_url=ext.cover_url,
                    # stream_url НЕ сохраняем: в нём зашит текущий хост, а он
                    # меняется при переносе деплоя (см. resolveRawUrl на фронте
                    # — для записи с числовым id поток строится заново).
                    genre=ext.genre,
                ),
            )
        except Exception:  # noqa: BLE001 — один битый трек не должен ронять всё
            logger.warning("failed to materialize %s for artist %s", ext.id, canonical)
            continue
        track_ids.append(saved.id)

    # Позиции продолжают существующие: плейлист отдаётся отсортированным по
    # position (см. Playlist.tracks), и дырки/нули перемешали бы порядок.
    position = (
        db.query(func.max(playlist_tracks.c.position))
        .filter(playlist_tracks.c.playlist_id == playlist.id)
        .scalar()
    )
    position = -1 if position is None else position

    rows = []
    for track_id in track_ids:
        if track_id in existing_ids:
            continue
        existing_ids.add(track_id)
        position += 1
        rows.append(
            {"playlist_id": playlist.id, "track_id": track_id, "position": position}
        )

    if rows:
        db.execute(insert(playlist_tracks), rows)
        db.commit()

    return ArtistSaveResponse(
        playlist_id=playlist.id,
        name=playlist.name,
        created=created,
        added=len(rows),
        total=len(existing_ids),
    )
