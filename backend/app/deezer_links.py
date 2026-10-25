"""Ссылки Deezer → метаданные треков (без аудио).

Аудио Deezer у нас — отдельный путь (routers/deezer.py: эквивалент
ytmusic-трека по ARL). Здесь только разбор ссылки и метаданные коллекции из
публичного api.deezer.com — он не требует ключей. Играбельными треки делает
матчинг в YouTube Music (importer.py), как у Spotify; а у подобранного
ytmusic-трека Deezer потом снова подхватывается как источник звука.
"""

import logging
import re
from typing import List, Optional, Tuple

import httpx
from fastapi import HTTPException
from pydantic import BaseModel

from app.schemas import ExternalPlaylistResponse

logger = logging.getLogger(__name__)

_API_URL = "https://api.deezer.com"
_TIMEOUT = httpx.Timeout(10.0, read=20.0)
_PAGE_LIMIT = 100
_MAX_ITEMS = 10_000
# Топ артиста: страница артиста в Deezer показывает столько же.
_ARTIST_TOP_LIMIT = 50

# deezer.com/track/1, deezer.com/ru/album/2, deezer.com/en-gb/playlist/3
_WEB_URL_RE = re.compile(
    r"deezer\.com/(?:[a-z]{2}(?:-[a-z]{2})?/)?(track|album|playlist|artist)/(\d+)",
    re.IGNORECASE,
)
# Мобильное «Поделиться»: link.deezer.com/s/..., deezer.page.link/... —
# тип и id видны только после редиректа.
_SHORT_HOSTS = ("link.deezer.com", "deezer.page.link", "dzr.page.link")


class DeezerTrack(BaseModel):
    """Трек Deezer — метаданные для матчинга (как SpotifyTrack)."""
    id: str
    title: str
    artist: str
    album: Optional[str] = None
    duration: int = 0
    cover_url: Optional[str] = None
    isrc: Optional[str] = None
    explicit: bool = False


def parse_url(url: str) -> Optional[Tuple[str, str]]:
    """Ссылка Deezer → (kind, id) или None. kind: track|album|playlist|artist."""
    match = _WEB_URL_RE.search(url or "")
    if not match:
        return None
    return match.group(1).lower(), match.group(2)


def is_short_link(url: str) -> bool:
    return any(host in (url or "").lower() for host in _SHORT_HOSTS)


async def resolve_short_link(url: str) -> str:
    """Короткая ссылка → полный deezer.com URL (или исходный при сбое)."""
    if not is_short_link(url):
        return url
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True) as client:
            resp = await client.get(url, headers={"User-Agent": "Mozilla/5.0"})
        final = str(resp.url)
        if parse_url(final):
            return final
        # page.link иногда отвечает HTML-страницей с deezer-ссылкой внутри.
        match = _WEB_URL_RE.search(resp.text or "")
        return f"https://www.deezer.com/{match.group(1)}/{match.group(2)}" if match else url
    except Exception as exc:  # noqa: BLE001 — сеть
        logger.warning("Deezer short link resolve failed for %s: %s", url, exc)
        return url


async def _get(client: httpx.AsyncClient, path: str, params: Optional[dict] = None) -> dict:
    try:
        resp = await client.get(f"{_API_URL}{path}", params=params)
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:  # noqa: BLE001 — сеть/не JSON
        logger.warning("Deezer API %s failed: %s", path, exc)
        raise HTTPException(status_code=502, detail="Deezer не ответил, попробуйте позже") from exc
    error = data.get("error") if isinstance(data, dict) else None
    if error:
        # {"error": {"type": "DataException", "code": 800}} — нет такой сущности
        # (или приватный плейлист); 4 — квота 50 запросов за 5 с.
        if error.get("code") == 800:
            raise HTTPException(status_code=404, detail="Не найдено в Deezer (или плейлист приватный)")
        logger.warning("Deezer API %s error: %s", path, error)
        raise HTTPException(status_code=502, detail="Deezer не ответил, попробуйте позже")
    return data


async def _paged(client: httpx.AsyncClient, path: str) -> List[dict]:
    items: List[dict] = []
    index = 0
    while len(items) < _MAX_ITEMS:
        page = await _get(client, path, {"index": index, "limit": _PAGE_LIMIT})
        batch = page.get("data") or []
        items.extend(batch)
        if not batch or not page.get("next"):
            break
        index += len(batch)
    return items[:_MAX_ITEMS]


def _track(obj: dict, album: Optional[dict] = None) -> Optional[DeezerTrack]:
    if not obj or not obj.get("id") or not obj.get("title"):
        return None
    # readable=false — трек снят с каталога в регионе: метаданные всё равно
    # годятся для матчинга, поэтому не отбрасываем.
    album = obj.get("album") or album or {}
    return DeezerTrack(
        id=str(obj["id"]),
        title=obj.get("title") or "",
        artist=(obj.get("artist") or {}).get("name") or "",
        album=album.get("title"),
        duration=int(obj.get("duration") or 0),
        cover_url=album.get("cover_xl") or album.get("cover_big"),
        isrc=obj.get("isrc"),
        explicit=bool(obj.get("explicit_lyrics")),
    )


def _tracks(items: List[dict], album: Optional[dict] = None) -> List[DeezerTrack]:
    return [t for t in (_track(i, album) for i in items) if t]


async def fetch_entity(kind: str, entity_id: str) -> Tuple[Optional[str], Optional[str], List[DeezerTrack]]:
    """(kind, id) → (название, обложка, треки)."""
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        if kind == "track":
            obj = await _get(client, f"/track/{entity_id}")
            track = _track(obj)
            return (track.title if track else None), (track.cover_url if track else None), ([track] if track else [])
        if kind == "album":
            album = await _get(client, f"/album/{entity_id}")
            items = await _paged(client, f"/album/{entity_id}/tracks")
            return album.get("title"), album.get("cover_xl") or album.get("cover_big"), _tracks(items, album)
        if kind == "playlist":
            playlist = await _get(client, f"/playlist/{entity_id}")
            items = await _paged(client, f"/playlist/{entity_id}/tracks")
            return playlist.get("title"), playlist.get("picture_xl") or playlist.get("picture_big"), _tracks(items)
        if kind == "artist":
            artist = await _get(client, f"/artist/{entity_id}")
            top = await _get(client, f"/artist/{entity_id}/top", {"limit": _ARTIST_TOP_LIMIT})
            return artist.get("name"), artist.get("picture_xl") or artist.get("picture_big"), _tracks(top.get("data") or [])
    raise HTTPException(status_code=400, detail="Не распознана ссылка Deezer")


async def search(query: str, limit: int = 20) -> List[DeezerTrack]:
    """Поиск треков в публичном каталоге Deezer (метаданные, без звука)."""
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        data = await _get(client, "/search", {"q": query, "limit": limit})
    return _tracks(data.get("data") or [])


async def fetch_by_url(url: str) -> Tuple[Optional[str], Optional[str], List[DeezerTrack]]:
    """Ссылка Deezer → (название, обложка, треки). 400 на нераспознанную."""
    parsed = parse_url(url)
    if not parsed:
        raise HTTPException(status_code=400, detail="Не распознана ссылка Deezer")
    return await fetch_entity(*parsed)


async def search_playlists(query: str, limit: int = 10) -> List[ExternalPlaylistResponse]:
    """Поиск публичных плейлистов Deezer."""
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        data = await _get(client, "/search/playlist", {"q": query, "limit": limit})
    results: List[ExternalPlaylistResponse] = []
    for item in data.get("data") or []:
        if not item.get("id") or not item.get("title"):
            continue
        results.append(
            ExternalPlaylistResponse(
                id=f"deezer:playlist:{item['id']}",
                source="deezer",
                external_id=str(item["id"]),
                title=item["title"],
                owner=(item.get("user") or {}).get("name"),
                cover_url=item.get("picture_xl") or item.get("picture_big"),
                permalink_url=f"https://www.deezer.com/playlist/{item['id']}",
                track_count=int(item.get("nb_tracks") or 0),
            )
        )
    return results[:limit]
