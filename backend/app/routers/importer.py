"""Импорт треков и плейлистов из внешних сервисов (SoundCloud, Yandex Music).

Разбирает ссылку через yt-dlp (extract_flat — только метаданные, быстро), затем
делает каждый трек играбельным и складывает в новый плейлист пользователя:

* SoundCloud — материализуем нативно (свой стрим-движок, см. soundcloud.py).
* Yandex Music (и всё не-нативное) — стриминг требует токен/регион, поэтому
  подбираем аналог в YouTube Music поиском по «артист + название».
"""

import asyncio
import logging
import re
from typing import List, Optional, Tuple
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import insert
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies import get_current_active_user
from app.models import Playlist, playlist_tracks
from app.routers import soundcloud, ytdlp
from app.routers.tracks import get_or_create_external_track
from app.schemas import (
    ExternalTrackImport,
    ImportPreviewResponse,
    ImportPreviewTrack,
    ImportRequest,
    ImportResult,
    PlaylistResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter()

# Защита от абьюза: сколько треков максимум тянем из одной коллекции/профиля.
_MAX_TRACKS = 200
# Одновременных резолвов/матчей — чтобы большой плейлист не завалил yt-dlp/ytmusic.
_CONCURRENCY = 8


def _detect(url: str) -> Tuple[str, str]:
    """Ссылка → (source, kind). Кидает 400 на нераспознанный URL.

    source: soundcloud | yandex; kind: playlist | user | track.
    """
    host = (urlparse(url).netloc or "").lower()
    path = urlparse(url).path.rstrip("/")

    if "soundcloud.com" in host:
        if "/sets/" in path:
            return "soundcloud", "playlist"
        # /{user}/{track} — трек; /{user} — профиль (все загрузки);
        # /{user}/tracks|/likes — тоже профильные коллекции.
        segments = [s for s in path.split("/") if s]
        if len(segments) <= 1:
            return "soundcloud", "user"
        if segments[-1] in ("tracks", "likes", "reposts", "albums", "sets"):
            return "soundcloud", "user"
        return "soundcloud", "track"

    if "music.yandex." in host:
        if "/playlists/" in path or "/album/" in path:
            # /album/x/track/y — одиночный трек внутри альбома
            if "/track/" in path:
                return "yandex", "track"
            return "yandex", "playlist"
        if "/track/" in path:
            return "yandex", "track"
        if "/artist/" in path:
            return "yandex", "playlist"  # треки артиста как коллекция
        return "yandex", "playlist"

    raise HTTPException(
        status_code=400,
        detail="Поддерживаются только ссылки SoundCloud и Yandex Music",
    )


def _artist_of(entry: dict) -> str:
    artists = entry.get("artists") or []
    name = ", ".join(a for a in artists if a).strip()
    return name or (entry.get("uploader") or entry.get("artist") or "Unknown Artist")


def _cover_of(entry: dict) -> Optional[str]:
    thumbs = entry.get("thumbnails") or []
    if thumbs:
        return thumbs[-1].get("url")
    return entry.get("thumbnail")


def _extract_blocking(url: str) -> dict:
    """yt-dlp extract_flat по ссылке. Блокирующая — звать через to_thread."""
    import yt_dlp

    opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": True,
        "skip_download": True,
        "playlistend": _MAX_TRACKS,
        "socket_timeout": 20,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        return ydl.extract_info(url, download=False) or {}


def _user_fallback_artist(url: str, info: dict) -> Optional[str]:
    """Имя автора для профиля: из заголовка «Tycho (Tracks)» → «Tycho», иначе слуг."""
    title = info.get("title") or ""
    stripped = re.sub(r"\s*\([^)]*\)\s*$", "", title).strip()
    if stripped:
        return stripped
    segments = [s for s in urlparse(url).path.split("/") if s]
    return segments[0] if segments else None


async def _extract_collection(
    request: Request, url: str, source: str, kind: str
) -> Tuple[Optional[str], Optional[str], List[dict]]:
    """(title, cover, entries) коллекции/трека. Кидает 502 при сбое извлечения."""
    try:
        info = await asyncio.to_thread(_extract_blocking, url)
    except Exception as exc:  # noqa: BLE001 — сеть/капча/недоступно
        logger.warning("import extract failed for %s: %s", url, exc)
        raise HTTPException(
            status_code=502,
            detail="Не удалось прочитать ссылку (сервис недоступен, регион или капча)",
        ) from exc

    entries = info.get("entries")
    if entries is None:
        # Одиночный трек — сам info является «треком».
        entries = [info]
    entries = [e for e in entries if e][:_MAX_TRACKS]

    # Плоский yt-dlp по SoundCloud-плейлисту отдаёт лишь id/url (без названия,
    # артиста, длительности) — из-за этого треки импортировались как
    # Unknown/Unknown Artist/0. Дотягиваем полные метаданные батчами через
    # api-v2 по числовым id и проставляем их прямо в entry.
    if source == "soundcloud":
        full = await soundcloud.tracks_by_ids(request, [e.get("id") for e in entries])
        for e in entries:
            tr = full.get(str(e.get("id")))
            if not tr:
                continue
            e["title"] = tr.title
            e["artists"] = [tr.artist]
            e["duration"] = tr.duration
            e["webpage_url"] = e.get("url") or e.get("webpage_url")
            if tr.cover_url:
                e["thumbnails"] = [{"url": tr.cover_url}]
            if tr.genre:
                e["genre"] = tr.genre

    # Плоские entries плейлиста/профиля несут лишь id/title/url — без артиста.
    # Для профиля автор = сам владелец страницы; для остального пытаемся вытащить
    # «Артист - Название» из заголовка трека, иначе останется Unknown Artist.
    coll_artist = _user_fallback_artist(url, info) if kind == "user" else None
    for e in entries:
        if e.get("artists") or e.get("uploader") or e.get("artist"):
            continue
        title = e.get("title") or ""
        if " - " in title:
            artist, _, rest = title.partition(" - ")
            # artists читают и _artist_of, и soundcloud._artist.
            e["artists"] = [artist.strip()]
            e["title"] = rest.strip() or title
        elif coll_artist:
            e["artists"] = [coll_artist]

    return info.get("title"), _cover_of(info), entries


async def _entry_to_import(
    request: Request, source: str, entry: dict
) -> Tuple[Optional[ExternalTrackImport], bool]:
    """Entry → играбельный ExternalTrackImport.

    Возвращает (payload, matched): matched=True, если трек подобран матчингом в
    YouTube Music (не нативный). payload=None — не удалось сделать играбельным.
    """
    if source == "soundcloud":
        payload = soundcloud.entry_to_import(request, entry)
        return payload, False

    # Yandex и прочее: матчим по «артист + название» в YouTube Music.
    title = entry.get("title") or entry.get("track") or ""
    artist = _artist_of(entry)
    if not title:
        return None, False
    query = f"{artist} {title}".strip()
    try:
        found = await ytdlp.search_ytmusic(request, query, limit=1)
    except Exception:  # noqa: BLE001
        logger.exception("ytmusic match failed for %s", query)
        return None, False
    if not found:
        return None, True  # искали, но не нашли — считается как «matched-попытка»
    t = found[0]
    payload = ExternalTrackImport(
        source=t.source,
        external_id=t.external_id,
        title=t.title,
        artist=t.artist,
        album=t.album,
        duration=t.duration,
        cover_url=t.cover_url,
        stream_url=t.stream_url,
    )
    return payload, True


async def _soundcloud_playlist_native(
    request: Request, url: str
) -> Optional[Tuple[Optional[str], Optional[str], List[ExternalTrackImport]]]:
    """SoundCloud-плейлист через api-v2: полные метаданные треков и обложка.

    Плоский yt-dlp extract_flat отдаёт только id/title (без артиста, обложек и
    длительностей) — api-v2 даёт всё сразу. None → падать в общий yt-dlp путь.
    """
    try:
        meta, sc_tracks = await soundcloud.resolve_playlist_url(request, url)
    except Exception:  # noqa: BLE001
        logger.exception("soundcloud api-v2 playlist resolve failed for %s", url)
        return None
    if meta is None or not sc_tracks:
        return None
    imports = [
        ExternalTrackImport(
            source=t.source,
            external_id=t.external_id,
            title=t.title,
            artist=t.artist,
            album=t.album,
            duration=t.duration,
            cover_url=t.cover_url,
            stream_url=t.stream_url,
        )
        for t in sc_tracks[:_MAX_TRACKS]
    ]
    return meta.title, meta.cover_url, imports


@router.post("/preview", response_model=ImportPreviewResponse)
async def import_preview(
    payload: ImportRequest,
    request: Request,
    current_user=Depends(get_current_active_user),
):
    """Разбирает ссылку и возвращает метаданные без материализации (для UI)."""
    source, kind = _detect(payload.url)

    if source == "soundcloud" and kind == "playlist":
        native = await _soundcloud_playlist_native(request, payload.url)
        if native:
            title, cover, imports = native
            tracks = [
                ImportPreviewTrack(
                    title=i.title,
                    artist=i.artist,
                    duration=i.duration,
                    cover_url=i.cover_url,
                    source=source,
                )
                for i in imports
            ]
            return ImportPreviewResponse(
                source=source,
                kind=kind,
                title=title,
                cover_url=cover,
                track_count=len(tracks),
                tracks=tracks,
            )

    title, cover, entries = await _extract_collection(request, payload.url, source, kind)

    tracks = [
        ImportPreviewTrack(
            title=e.get("title") or e.get("track") or "Unknown",
            artist=_artist_of(e),
            duration=int(e.get("duration") or 0),
            cover_url=_cover_of(e),
            source=source,
        )
        for e in entries
    ]
    return ImportPreviewResponse(
        source=source,
        kind=kind,
        title=title,
        cover_url=cover,
        track_count=len(tracks),
        tracks=tracks,
    )


@router.post("", response_model=ImportResult)
@router.post("/", response_model=ImportResult)
async def import_collection(
    payload: ImportRequest,
    request: Request,
    current_user=Depends(get_current_active_user),
    db: Session = Depends(get_db),
):
    """Импортирует коллекцию/трек в новый плейлист пользователя."""
    source, kind = _detect(payload.url)

    imports: List[ExternalTrackImport] = []
    matched = 0
    skipped = 0
    title = cover = None

    native = None
    if source == "soundcloud" and kind == "playlist":
        native = await _soundcloud_playlist_native(request, payload.url)

    if native:
        title, cover, imports = native
    else:
        title, cover, entries = await _extract_collection(request, payload.url, source, kind)
        if not entries:
            raise HTTPException(status_code=404, detail="По ссылке не найдено треков")

        # Резолвим все треки конкурентно (с ограничением), сохраняя исходный порядок.
        sem = asyncio.Semaphore(_CONCURRENCY)

        async def resolve(entry: dict):
            async with sem:
                return await _entry_to_import(request, source, entry)

        resolved = await asyncio.gather(*(resolve(e) for e in entries))

        for imp, was_matched in resolved:
            if imp is None:
                skipped += 1  # нативно не резолвится или матч в ytmusic не нашёлся
                continue
            imports.append(imp)
            if was_matched:
                matched += 1

    if not imports:
        raise HTTPException(
            status_code=422,
            detail="Не удалось сделать играбельным ни один трек из коллекции",
        )

    # Сначала материализуем ВСЕ треки (get_or_create_external_track идемпотентен
    # по (source, external_id) и коммитит сам, в т.ч. с откатом при гонке —
    # поэтому делаем это ДО создания плейлиста, чтобы его вставку не откатило).
    track_ids: List[int] = []
    seen: set = set()
    for imp in imports:
        track = get_or_create_external_track(db, imp)
        if track.id in seen:
            continue  # дубли внутри коллекции (напр. матч в один и тот же трек)
        seen.add(track.id)
        track_ids.append(track.id)

    # Теперь собираем плейлист и связи одной транзакцией.
    name = payload.playlist_name or title or "Импортированный плейлист"
    new_playlist = Playlist(
        name=name,
        description=f"Импортировано из {source}",
        cover_url=cover if (cover and cover.startswith("http")) else None,
        is_public=False,
        owner_id=current_user.id,
    )
    db.add(new_playlist)
    db.flush()  # получить new_playlist.id до вставки связей

    for position, track_id in enumerate(track_ids):
        db.execute(
            insert(playlist_tracks).values(
                playlist_id=new_playlist.id,
                track_id=track_id,
                position=position,
            )
        )

    db.commit()
    db.refresh(new_playlist)
    position = len(track_ids)

    return ImportResult(
        playlist=PlaylistResponse.model_validate(new_playlist),
        imported=position,
        matched=matched,
        skipped=skipped,
    )
