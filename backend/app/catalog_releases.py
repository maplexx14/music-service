"""Supplement artist releases with Yandex metadata and playable recordings."""
import asyncio
import logging
import re
from datetime import datetime, timezone
from typing import List, Optional

import httpx
from fastapi import Request

from app.artist_utils import is_derivative_title, query_names_artist, same_artist, split_artists, translit_key
from app.cache import get_cache_async, set_cache_async
from app.provider_work import provider_call
from app.routers import soundcloud, yandex_music, ytdlp
from app.schemas import ExternalAlbumDetail, ExternalAlbumResponse, ExternalTrackResponse

logger = logging.getLogger(__name__)

_RELEASE_TTL = 15 * 60
_LAST_GOOD_TTL = 7 * 24 * 3600
_MISS_TTL = 60
_MAX_RELEASES = 100
_ALBUM_PAGE_SIZE = 50
_MATCH_CONCURRENCY = 4
_CATALOG_BUDGET = 6
_CATALOG_TIMEOUT = httpx.Timeout(2.5, connect=1.5)
_RECENT_TRACK_BUDGET = 5
_FEATURE_SUFFIX = re.compile(r"\s*[([](?:feat\.?|ft\.?|featuring)\s+[^)\]]*[)\]]", re.I)


def _album(item: dict, artist: str = "") -> Optional[ExternalAlbumResponse]:
    album_id = str(item.get("id") or "")
    title = (item.get("title") or "").strip()
    if not album_id.isdecimal() or not title:
        return None
    names = ", ".join(a.get("name") or "" for a in item.get("artists") or [])
    kind = (item.get("type") or "album").lower()
    return ExternalAlbumResponse(
        id=f"yandex:{album_id}", source="yandex", external_id=album_id,
        title=title, artist=names or artist or None,
        year=str(item["year"]) if item.get("year") else None,
        cover_url=yandex_music._web_cover(item),
        track_count=int(item.get("trackCount") or 0),
        album_type={"single": "Single", "ep": "EP"}.get(kind, "Album"),
    )


async def yandex_artist_albums(name: str) -> List[ExternalAlbumResponse]:
    """Only releases of an exact artist match; keep the last good list on failure."""
    key = f"artist_releases:yandex:v1:{translit_key(name)}"
    cached = await get_cache_async(key)
    if cached is not None:
        return [ExternalAlbumResponse(**a) for a in cached]
    previous = await get_cache_async(f"{key}:last_good") or []

    def fallback():
        return [ExternalAlbumResponse(**a) for a in previous]

    try:
        albums, complete = await asyncio.wait_for(_fetch_artist_albums(name), timeout=_CATALOG_BUDGET)
        if not complete:
            return fallback() if previous else albums
        if not albums and previous:
            return fallback()
        payload = [a.model_dump() for a in albums]
        await set_cache_async(key, payload, expire=_RELEASE_TTL if albums else _MISS_TTL)
        if albums:
            await set_cache_async(f"{key}:last_good", payload, expire=_LAST_GOOD_TTL)
        return albums
    except Exception:
        logger.warning("Yandex artist releases failed for %s", name, exc_info=True)
        return fallback()


async def _catalog_api(path: str, params: Optional[dict] = None):
    return await asyncio.wait_for(
        yandex_music._api(path, params, timeout=_CATALOG_TIMEOUT),
        timeout=_CATALOG_BUDGET,
    )


async def _fetch_artist_albums(name: str) -> tuple:
    found = await _catalog_api("search", {"text": name, "type": "artist", "page": 0})
    if not isinstance(found, dict):
        return [], False
    match = next((
        a for a in (found.get("artists") or {}).get("results") or []
        if a.get("id") and same_artist(a.get("name") or "", name)
    ), None)
    if match is None:
        return [], True

    albums = []
    seen = set()
    for page in range(_MAX_RELEASES // _ALBUM_PAGE_SIZE):
        response = await _catalog_api(
            f"artists/{match['id']}/direct-albums",
            {"page": page, "page-size": _ALBUM_PAGE_SIZE, "sort-by": "year"},
        )
        if not isinstance(response, dict) or "albums" not in response:
            # A failed later page must not replace a complete cached catalogue.
            return albums, False
        items = response.get("albums") or []
        for item in items:
            participants = [a.get("name") or "" for a in item.get("artists") or []]
            if participants and not any(same_artist(name, a) for a in participants):
                continue
            album = _album(item, match["name"])
            if album and album.external_id not in seen:
                seen.add(album.external_id)
                albums.append(album)
        total = (response.get("pager") or {}).get("total")
        if len(items) < _ALBUM_PAGE_SIZE or (total is not None and (page + 1) * _ALBUM_PAGE_SIZE >= int(total)):
            break
    return albums, True


def _release_key(album: ExternalAlbumResponse) -> tuple:
    title = _FEATURE_SUFFIX.sub("", album.title)
    return translit_key(title), (album.album_type or "Album").lower(), album.year or ""


def merge_artist_albums(
    primary: List[ExternalAlbumResponse], additional: List[ExternalAlbumResponse]
) -> List[ExternalAlbumResponse]:
    """Prefer directly playable releases, preserving the newer catalogue's order."""
    preferred = {_release_key(a): a for a in primary}
    albums = []
    seen = set()
    for album in [*additional, *primary]:
        key = _release_key(album)
        if key in seen:
            continue
        seen.add(key)
        albums.append(preferred.get(key, album))
    albums.sort(key=lambda a: (a.year or ""), reverse=True)
    return albums


async def _album_metadata(album_id: str) -> Optional[dict]:
    if not album_id.isdecimal():
        return None
    key = f"artist_releases:yandex_album:v1:{album_id}"
    cached = await get_cache_async(key)
    if cached is not None:
        return cached
    previous = await get_cache_async(f"{key}:last_good")
    try:
        data = await _catalog_api(f"albums/{album_id}/with-tracks")
    except Exception:
        logger.warning("Yandex album lookup failed for %s", album_id, exc_info=True)
        return previous
    if not isinstance(data, dict) or not _album(data):
        return previous
    await set_cache_async(key, data, expire=_RELEASE_TTL)
    await set_cache_async(f"{key}:last_good", data, expire=_LAST_GOOD_TTL)
    return data


def _same_recording(candidate: ExternalTrackResponse, wanted) -> bool:
    if is_derivative_title(candidate.title) and not is_derivative_title(wanted.title):
        return False
    if not all(
        any(same_artist(artist, part) for part in split_artists(candidate.artist))
        for artist in split_artists(wanted.artist)
    ):
        return False
    return soundcloud._is_exact_match(candidate, wanted.title, wanted.artist, wanted.duration)


async def _match_track(request: Request, item: dict) -> Optional[ExternalTrackResponse]:
    wanted = yandex_music._track_from_web(item)
    if wanted is None or ytdlp._ytmusic is None:
        return None
    key = f"artist_releases:yandex_track:v1:{wanted.id}"
    cached = await get_cache_async(key)
    if cached is not None:
        return ExternalTrackResponse(**cached["track"]) if cached.get("track") else None

    query = f"{wanted.artist} {wanted.title}"
    candidate = None
    try:
        songs = await provider_call(ytdlp._ytmusic.search, query, filter="songs", limit=5)
        for raw in songs or []:
            track = ytdlp._normalize(raw)
            if track and _same_recording(track, wanted):
                candidate = track
                break
        if candidate is None:
            # New releases can exist only as videos, under an arbitrary uploader.
            # Both names and the duration must identify the original recording.
            videos = await provider_call(ytdlp._ytmusic.search, query, filter="videos", limit=5)
            for raw in videos or []:
                entry = {
                    "title": raw.get("title"), "duration": ytdlp._duration_seconds(raw),
                    "uploader": ", ".join(a.get("name") or "" for a in raw.get("artists") or []),
                }
                if is_derivative_title(entry["title"] or "") and not is_derivative_title(wanted.title):
                    continue
                if not query_names_artist(wanted.artist, f"{entry['title']} {entry['uploader']}"):
                    continue
                if soundcloud._youtube_entry_matches(entry, wanted.title, wanted.artist, wanted.duration):
                    candidate = ytdlp._normalize(raw)
                    if candidate:
                        break
        if candidate is None:
            found = await soundcloud.search_soundcloud(request, query, limit=5)
            candidate = next((track for track in found if _same_recording(track, wanted)), None)
    except Exception:
        logger.warning("Release recording lookup failed for Yandex track %s", wanted.id, exc_info=True)
        return None

    if candidate:
        # Metadata comes from the release, rather than the video's uploader/title.
        candidate = candidate.model_copy(update={
            "title": wanted.title, "artist": wanted.artist, "album": wanted.album,
            "cover_url": wanted.cover_url or candidate.cover_url,
            "is_explicit": item.get("contentWarning") == "explicit",
            "stream_url": "",
        })
    await set_cache_async(key, {"track": candidate.model_dump() if candidate else None},
                          expire=6 * 3600 if candidate else _MISS_TTL)
    return candidate


async def yandex_album(request: Request, album_id: str) -> Optional[ExternalAlbumDetail]:
    data = await _album_metadata(album_id)
    if data is None:
        return None
    album = _album(data)
    items = [item for volume in data.get("volumes") or [] for item in volume][:_MAX_RELEASES]
    semaphore = asyncio.Semaphore(_MATCH_CONCURRENCY)

    async def match(item):
        item = {**item, "albums": item.get("albums") or [data]}
        if not item.get("coverUri"):
            item["coverUri"] = data.get("coverUri")
        async with semaphore:
            return await _match_track(request, item)

    results = await asyncio.gather(*(match(item) for item in items))
    tracks = [track for track in results if track]
    base_url = str(request.base_url).rstrip("/")
    for track in tracks:
        path = "soundcloud" if track.source == "soundcloud" else "ytdlp"
        track.stream_url = f"{base_url}/api/{path}/stream/{track.external_id}"
    return ExternalAlbumDetail(album=album, tracks=tracks)


async def recent_artist_tracks(
    request: Request, albums: List[ExternalAlbumResponse], known: list
) -> List[ExternalTrackResponse]:
    """Add at most three current-year singles missing from the track catalogue."""
    year = str(datetime.now(timezone.utc).year)
    candidates = [
        a for a in albums if a.source == "yandex" and a.year == year
        and (a.album_type or "").lower() == "single"
        and not any(
            translit_key(a.title) == translit_key(t.title)
            and any(same_artist(a.artist or "", p) for p in split_artists(t.artist))
            for t in known
        )
    ][:3]
    if not candidates:
        return []
    tasks = [asyncio.create_task(yandex_album(request, a.external_id)) for a in candidates]
    try:
        done, pending = await asyncio.wait(tasks, timeout=_RECENT_TRACK_BUDGET)
        for task in pending:
            task.cancel()
        results = [task.exception() or task.result() for task in tasks if task in done and not task.cancelled()]
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    tracks = []
    for result in results:
        if isinstance(result, Exception):
            logger.warning("Recent artist release failed: %s", result)
        elif result:
            tracks.extend(result.tracks)
    return tracks
