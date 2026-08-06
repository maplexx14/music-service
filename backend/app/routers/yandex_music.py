"""Нативная интеграция с Yandex Music (только метаданные).

Аудио Yandex Music мы не стримим — играбельными треки делает матчинг в
YouTube Music (см. importer.py). Отсюда нужны названия, артисты, обложки и
длительности.

Два источника, в порядке предпочтения:

1. Пакет yandex-music по OAuth-токену (YANDEX_MUSIC_TOKEN). Даёт всё, включая
   собственную библиотеку пользователя и приватные плейлисты.
   Токен: https://github.com/MarshalX/yandex-music/blob/main/docs/authentication.md

2. Публичные веб-хендлеры music.yandex.ru/handlers/*.jsx — БЕЗ токена. Это те
   же запросы, которые делает сам сайт из браузера: публичные плейлисты,
   альбомы, артисты, треки и открытое «Мне нравится» отдаются без авторизации.
   Приватные коллекции этим путём недоступны, и Yandex может ответить капчей
   или геоблокировкой (451 / страница «This page is no longer available» — так
   выглядит запрос из-за пределов РФ/РБ).

Если оба пути не сработали, вызывающий (importer) откатывается на yt-dlp с
пользовательскими cookies.
"""

import asyncio
import logging
import os
import re
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter()

# Конфигурация Yandex Music
YANDEX_MUSIC_TOKEN = os.getenv("YANDEX_MUSIC_TOKEN", "")

# Глобальный клиент (ленивая инициализация)
_client = None

# ─── Публичные веб-хендлеры ───

_WEB_BASE = "https://music.yandex.ru"
_WEB_TIMEOUT = httpx.Timeout(10.0, read=25.0)
# Хендлеры отвечают JSON только «браузеру»: без этих заголовков прилетает HTML.
_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
_HANDLER_PARAMS = {
    "lang": "ru",
    "external-domain": "music.yandex.ru",
    "overembed": "false",
}
# Предохранитель на размер коллекции.
_MAX_TRACKS = 10_000
# Сколько id зараз просим у track-entries.jsx (длинный GET/POST режут).
_ID_CHUNK = 200

_UNAVAILABLE_DETAIL = (
    "Yandex Music не отвечает. Возможные причины и решения:\n"
    "1. Сервис недоступен с IP сервера (геоблокировка вне РФ/РБ) — нужен прокси\n"
    "2. Yandex показал капчу — загрузите cookies через /api/import/cookies\n"
    "3. Коллекция приватная — задайте YANDEX_MUSIC_TOKEN в .env"
)


class YandexMusicTrack(BaseModel):
    """Модель трека из Yandex Music."""
    id: str
    title: str
    artist: str
    album: Optional[str] = None
    duration: int = 0
    cover_url: Optional[str] = None
    stream_url: Optional[str] = None


def _cover_url(uri: Optional[str], size: str = "400x400") -> Optional[str]:
    """URI обложки Yandex → готовый URL.

    Yandex отдаёт шаблон вида `avatars.yandex.net/get-music-content/…/%%`, где
    `%%` — место под размер; пакет yandex-music иногда отдаёт `{size}`.
    Неподставленный шаблон отдаёт 404, поэтому подставляем оба варианта.
    """
    if not uri:
        return None
    url = uri if uri.startswith("http") else f"https://{uri}"
    return url.replace("%%", size).replace("{size}", size)


def _get_client():
    """Получает или создаёт клиент Yandex Music."""
    global _client

    if _client is not None:
        return _client

    if not YANDEX_MUSIC_TOKEN:
        # Не предупреждаем: без токена работает публичный путь (см. docstring).
        logger.debug("YANDEX_MUSIC_TOKEN не задан — используем публичные хендлеры")
        return None

    try:
        from yandex_music import Client

        _client = Client(token=YANDEX_MUSIC_TOKEN)
        _client.init()
        logger.info("Yandex Music клиент инициализирован")
        return _client
    except Exception as e:
        logger.error("Ошибка инициализации Yandex Music клиента: %s", e)
        _client = None
        return None


async def _get_client_async():
    """Асинхронное получение клиента (через to_thread)."""
    return await asyncio.to_thread(_get_client)


def _extract_track_info(track) -> Optional[YandexMusicTrack]:
    """Извлекает информацию о треке из объекта пакета yandex-music."""
    try:
        # Получаем артистов
        artists = []
        if hasattr(track, 'artists') and track.artists:
            artists = [a.name for a in track.artists if hasattr(a, 'name')]
        artist_str = ", ".join(artists) if artists else "Unknown Artist"

        # Получаем альбом
        album = None
        if hasattr(track, 'albums') and track.albums:
            album = track.albums[0].title if hasattr(track.albums[0], 'title') else None

        # Получаем длительность (в миллисекундах)
        duration = 0
        if hasattr(track, 'duration_ms') and track.duration_ms:
            duration = track.duration_ms // 1000

        return YandexMusicTrack(
            id=str(track.id),
            title=track.title or "Unknown",
            artist=artist_str,
            album=album,
            duration=duration,
            cover_url=_cover_url(getattr(track, "cover_uri", None)),
        )
    except Exception as e:
        logger.error("Ошибка извлечения информации о треке: %s", e)
        return None


# ─── Публичный путь: без токена ───


async def _handler(
    name: str,
    params: Dict[str, Any],
    referer_path: str = "/",
    data: Optional[Dict[str, Any]] = None,
) -> Optional[Any]:
    """Запрос к music.yandex.ru/handlers/{name}. None — если ответ не JSON.

    Не бросает: любой отказ (сеть, капча, геоблок, смена формата) — это сигнал
    вызывающему попробовать следующий источник, а не ошибка запроса юзера.
    """
    url = f"{_WEB_BASE}/handlers/{name}"
    referer = f"{_WEB_BASE}{referer_path}"
    headers = {
        "User-Agent": _BROWSER_UA,
        "X-Requested-With": "XMLHttpRequest",
        "X-Retpath-Y": referer,
        "Referer": referer,
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "ru,en;q=0.9",
    }
    query = {**_HANDLER_PARAMS, **params}

    try:
        async with httpx.AsyncClient(timeout=_WEB_TIMEOUT, follow_redirects=True) as client:
            if data is None:
                resp = await client.get(url, params=query, headers=headers)
            else:
                resp = await client.post(url, params=query, data=data, headers=headers)
    except Exception as exc:  # noqa: BLE001 — сеть
        logger.warning("Yandex handler %s недоступен: %s", name, exc)
        return None

    if resp.status_code != 200:
        # 451 — геоблокировка, 404 — та же заглушка «page is no longer available».
        logger.warning("Yandex handler %s → HTTP %s", name, resp.status_code)
        return None

    if "json" not in (resp.headers.get("content-type") or "").lower():
        # Капча и страницы-заглушки приходят как HTML с кодом 200.
        logger.warning("Yandex handler %s вернул не JSON (капча или заглушка)", name)
        return None

    try:
        return resp.json()
    except ValueError:
        logger.warning("Yandex handler %s вернул битый JSON", name)
        return None


def _track_from_web(obj: dict) -> Optional[YandexMusicTrack]:
    """Объект трека из веб-хендлера → YandexMusicTrack."""
    if not isinstance(obj, dict):
        return None
    track_id = obj.get("id") or obj.get("realId")
    title = obj.get("title")
    if not track_id or not title:
        # Недоступные в регионе треки приходят огрызком без названия.
        return None

    version = obj.get("version")
    if version:
        title = f"{title} ({version})"

    artists = [a.get("name") for a in (obj.get("artists") or []) if a.get("name")]
    albums = obj.get("albums") or []
    album = albums[0].get("title") if albums else None
    cover = obj.get("coverUri") or (albums[0].get("coverUri") if albums else None)
    if not cover and (obj.get("ogImage")):
        cover = obj.get("ogImage")

    return YandexMusicTrack(
        id=str(track_id),
        title=title,
        artist=", ".join(artists) or "Unknown Artist",
        album=album,
        duration=int(obj.get("durationMs") or 0) // 1000,
        cover_url=_cover_url(cover),
    )


def _tracks_from_web(items: Any) -> List[YandexMusicTrack]:
    """Список объектов (или обёрток `{"track": {...}}`) → треки."""
    tracks: List[YandexMusicTrack] = []
    for item in (items or [])[:_MAX_TRACKS]:
        if isinstance(item, dict) and "track" in item and isinstance(item["track"], dict):
            item = item["track"]
        track = _track_from_web(item)
        if track:
            tracks.append(track)
    return tracks


def _web_cover(obj: dict) -> Optional[str]:
    """Обложка коллекции: одиночная картинка или первая плитка мозаики."""
    if not isinstance(obj, dict):
        return None
    cover = obj.get("cover")
    if isinstance(cover, dict):
        if cover.get("uri"):
            return _cover_url(cover["uri"])
        items = cover.get("itemsUri") or []
        if items:
            return _cover_url(items[0])
    return _cover_url(obj.get("coverUri") or obj.get("ogImage"))


async def _public_tracks_by_ids(entries: List[str]) -> List[YandexMusicTrack]:
    """Полные треки по id вида `trackId:albumId` (так их отдаёт библиотека)."""
    tracks: List[YandexMusicTrack] = []
    for start in range(0, min(len(entries), _MAX_TRACKS), _ID_CHUNK):
        chunk = entries[start:start + _ID_CHUNK]
        data = await _handler(
            "track-entries.jsx",
            {},
            "/",
            data={"entries": ",".join(chunk), "strict": "true"},
        )
        if not isinstance(data, list):
            break
        tracks.extend(_tracks_from_web(data))
    return tracks


async def _public_album(album_id: str) -> Optional[Tuple[Optional[str], Optional[str], List[YandexMusicTrack]]]:
    data = await _handler("album.jsx", {"album": album_id}, f"/album/{album_id}")
    if not isinstance(data, dict) or not data.get("title"):
        return None
    # Треки альбома разложены по дискам (volumes).
    tracks: List[YandexMusicTrack] = []
    for volume in data.get("volumes") or []:
        tracks.extend(_tracks_from_web(volume))
    return data.get("title"), _web_cover(data), tracks


async def _public_artist(artist_id: str) -> Optional[Tuple[Optional[str], Optional[str], List[YandexMusicTrack]]]:
    data = await _handler(
        "artist.jsx",
        {"artist": artist_id, "what": "tracks", "sort": "", "dir": ""},
        f"/artist/{artist_id}/tracks",
    )
    if not isinstance(data, dict):
        return None
    artist = data.get("artist") or {}
    name = artist.get("name")
    if not name:
        return None
    tracks = _tracks_from_web(data.get("tracks") or [])
    if not tracks:
        ids = [str(i) for i in (data.get("trackIds") or []) if i]
        tracks = await _public_tracks_by_ids(ids)
    return name, _web_cover(artist), tracks


async def _public_playlist(owner: str, kind: str) -> Optional[Tuple[Optional[str], Optional[str], List[YandexMusicTrack]]]:
    data = await _handler(
        "playlist.jsx",
        {
            "owner": owner,
            "kinds": kind,
            "light": "false",
            "madeFor": "",
            "withLikesCount": "true",
            "forceLogin": "true",
        },
        f"/users/{owner}/playlists/{kind}",
    )
    if not isinstance(data, dict):
        return None
    playlist = data.get("playlist") or {}
    if not playlist.get("title"):
        return None
    tracks = _tracks_from_web(playlist.get("tracks") or [])
    if not tracks:
        ids = [str(i) for i in (playlist.get("trackIds") or []) if i]
        tracks = await _public_tracks_by_ids(ids)
    return playlist.get("title"), _web_cover(playlist), tracks


async def _public_track(track_id: str, album_id: Optional[str] = None) -> Optional[Tuple[Optional[str], Optional[str], List[YandexMusicTrack]]]:
    entry = f"{track_id}:{album_id}" if album_id else str(track_id)
    data = await _handler("track.jsx", {"track": entry}, f"/track/{track_id}")
    obj = (data or {}).get("track") if isinstance(data, dict) else None
    track = _track_from_web(obj) if obj else None
    if not track:
        return None
    return track.title, track.cover_url, [track]


async def _public_likes(owner: str) -> Optional[Tuple[Optional[str], Optional[str], List[YandexMusicTrack]]]:
    """Открытое «Мне нравится» пользователя. Приватное отдаётся пустым."""
    data = await _handler(
        "library.jsx",
        {"owner": owner, "filter": "tracks", "likeFilter": "favorite"},
        f"/users/{owner}/likes/tracks",
    )
    if not isinstance(data, dict):
        return None
    library = data.get("library") if isinstance(data.get("library"), dict) else data

    tracks = _tracks_from_web(library.get("tracks") or [])
    if not tracks:
        # library.jsx часто отдаёт только id — дотягиваем метаданные батчами.
        ids = [str(i) for i in (library.get("trackIds") or []) if i]
        if not ids:
            return None
        tracks = await _public_tracks_by_ids(ids)
    return f"Избранное {owner} (Yandex Music)", None, tracks


async def _public_search(query: str, limit: int) -> List[YandexMusicTrack]:
    data = await _handler(
        "music-search.jsx",
        {"text": query, "type": "tracks", "page": "0"},
        "/search",
    )
    if not isinstance(data, dict):
        return []
    items = ((data.get("tracks") or {}).get("items")) or []
    return _tracks_from_web(items)[:limit]


# ─── Разбор ссылок ───

_ALBUM_TRACK_RE = re.compile(r"/album/(\d+)/track/(\d+)")
_TRACK_RE = re.compile(r"/track/(\d+)")
_ALBUM_RE = re.compile(r"/album/(\d+)")
_ARTIST_RE = re.compile(r"/artist/(\d+)")
_LIKES_RE = re.compile(r"/users/([^/]+)/likes")
# Владелец плейлиста — это логин, а не число: /users/music-blog/playlists/2136.
_USER_PLAYLIST_RE = re.compile(r"/users/([^/]+)/playlists/([\w.-]+)")
_SHORT_PLAYLIST_RE = re.compile(r"/playlists/([^/]+)/([\w.-]+)")


def parse_url(url: str) -> Optional[Tuple[str, Dict[str, str]]]:
    """Ссылка Yandex Music → (kind, параметры) или None, если это не Yandex.

    kind: track | album | artist | playlist | likes.
    """
    parsed = urlparse((url or "").strip())
    if "music.yandex." not in (parsed.netloc or "").lower():
        return None
    path = parsed.path.rstrip("/")

    match = _ALBUM_TRACK_RE.search(path)
    if match:
        return "track", {"track_id": match.group(2), "album_id": match.group(1)}
    match = _TRACK_RE.search(path)
    if match:
        return "track", {"track_id": match.group(1)}
    match = _ALBUM_RE.search(path)
    if match:
        return "album", {"album_id": match.group(1)}
    match = _ARTIST_RE.search(path)
    if match:
        return "artist", {"artist_id": match.group(1)}
    match = _LIKES_RE.search(path)
    if match:
        return "likes", {"owner": match.group(1)}
    match = _USER_PLAYLIST_RE.search(path) or _SHORT_PLAYLIST_RE.search(path)
    if match:
        return "playlist", {"owner": match.group(1), "kind": match.group(2)}
    return None


# ─── Единая точка входа: токен, затем публичный путь ───


async def _fetch_with_token(
    request: Optional[Request], kind: str, params: Dict[str, str]
) -> Optional[Tuple[Optional[str], Optional[str], List[YandexMusicTrack]]]:
    """Забирает коллекцию по OAuth-токену. None — если токена нет или не вышло."""
    if await _get_client_async() is None:
        return None
    try:
        if kind == "album":
            return await get_album_tracks(request, params["album_id"])
        if kind == "artist":
            return await get_artist_tracks(request, params["artist_id"])
        if kind == "playlist":
            return await get_playlist_tracks(request, params["owner"], params["kind"])
        if kind == "likes":
            return await get_user_likes(request, params["owner"])
        if kind == "track":
            return await get_track_by_id(request, params["track_id"])
    except Exception as exc:  # noqa: BLE001 — сеть/капча/приватность
        logger.warning("Yandex Music по токену не отдал %s %s: %s", kind, params, exc)
    return None


async def _fetch_public(
    kind: str, params: Dict[str, str]
) -> Optional[Tuple[Optional[str], Optional[str], List[YandexMusicTrack]]]:
    """Забирает коллекцию через публичные веб-хендлеры (без токена)."""
    try:
        if kind == "album":
            return await _public_album(params["album_id"])
        if kind == "artist":
            return await _public_artist(params["artist_id"])
        if kind == "playlist":
            return await _public_playlist(params["owner"], params["kind"])
        if kind == "likes":
            return await _public_likes(params["owner"])
        if kind == "track":
            return await _public_track(params["track_id"], params.get("album_id"))
    except Exception as exc:  # noqa: BLE001 — смена формата хендлера
        logger.warning("Публичный Yandex Music не отдал %s %s: %s", kind, params, exc)
    return None


async def fetch_entity(
    request: Optional[Request], kind: str, params: Dict[str, str]
) -> Optional[Tuple[Optional[str], Optional[str], List[YandexMusicTrack]]]:
    """(kind, параметры) → (название, обложка, треки). None — оба пути отказали."""
    result = await _fetch_with_token(request, kind, params)
    if result and result[2]:
        return result
    return await _fetch_public(kind, params)


async def fetch_by_url(
    request: Optional[Request], url: str
) -> Optional[Tuple[Optional[str], Optional[str], List[YandexMusicTrack]]]:
    """Ссылка Yandex Music → (название, обложка, треки).

    None — ссылка не разобрана либо сервис недоступен: вызывающий откатывается
    на yt-dlp.
    """
    parsed = parse_url(url)
    if not parsed:
        return None
    return await fetch_entity(request, *parsed)


async def search_yandex_music(
    request: Request,
    query: str,
    limit: int = 20,
) -> List[YandexMusicTrack]:
    """Поиск треков в Yandex Music: по токену, иначе через публичный хендлер."""
    client = await _get_client_async()
    if client is None:
        return await _public_search(query, limit)

    try:
        # Выполняем поиск в отдельном потоке
        result = await asyncio.to_thread(
            client.search,
            query,
            page=0,
            nococrrect=False,
        )

        if not result or not hasattr(result, 'tracks') or not result.tracks:
            return []

        tracks = []
        for track in result.tracks.results[:limit]:
            track_info = _extract_track_info(track)
            if track_info:
                tracks.append(track_info)

        return tracks
    except Exception as e:
        logger.error("Ошибка поиска в Yandex Music: %s", e)
        return await _public_search(query, limit)


# ─── Путь по токену ───


async def get_album_tracks(
    request: Optional[Request],
    album_id: str,
) -> Tuple[Optional[str], Optional[str], List[YandexMusicTrack]]:
    """Получает треки альбома из Yandex Music (по токену)."""
    client = await _get_client_async()
    if client is None:
        raise HTTPException(
            status_code=503,
            detail="Yandex Music API недоступен. Задайте YANDEX_MUSIC_TOKEN."
        )

    try:
        # Получаем альбом
        album = await asyncio.to_thread(client.albums_with_tracks, album_id)
        if not album:
            raise HTTPException(status_code=404, detail="Альбом не найден")

        # Получаем треки альбома
        tracks = []
        if hasattr(album, 'volumes') and album.volumes:
            for volume in album.volumes:
                for track in volume:
                    track_info = _extract_track_info(track)
                    if track_info:
                        tracks.append(track_info)

        return album.title, _cover_url(getattr(album, "cover_uri", None)), tracks
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Ошибка получения альбома %s: %s", album_id, e)
        raise HTTPException(status_code=500, detail="Ошибка получения данных из Yandex Music")


async def get_artist_tracks(
    request: Optional[Request],
    artist_id: str,
) -> Tuple[Optional[str], Optional[str], List[YandexMusicTrack]]:
    """Получает треки артиста из Yandex Music (по токену)."""
    client = await _get_client_async()
    if client is None:
        raise HTTPException(
            status_code=503,
            detail="Yandex Music API недоступен. Задайте YANDEX_MUSIC_TOKEN."
        )

    try:
        # Получаем информацию об артисте
        artist = await asyncio.to_thread(client.artists, artist_id)
        if not artist:
            raise HTTPException(status_code=404, detail="Артист не найден")
        if isinstance(artist, list):
            artist = artist[0] if artist else None
        if artist is None:
            raise HTTPException(status_code=404, detail="Артист не найден")

        # Получаем треки артиста
        artist_tracks = await asyncio.to_thread(client.artists_tracks, artist_id)
        tracks = []
        if artist_tracks and hasattr(artist_tracks, 'tracks'):
            for track in artist_tracks.tracks[:100]:  # Ограничиваем 100 треками
                track_info = _extract_track_info(track)
                if track_info:
                    tracks.append(track_info)

        return artist.name, _cover_url(getattr(getattr(artist, "cover", None), "uri", None)), tracks
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Ошибка получения треков артиста %s: %s", artist_id, e)
        raise HTTPException(status_code=500, detail="Ошибка получения данных из Yandex Music")


async def get_playlist_tracks(
    request: Optional[Request],
    user_id: str,
    playlist_id: str,
) -> Tuple[Optional[str], Optional[str], List[YandexMusicTrack]]:
    """Получает треки плейлиста из Yandex Music (по токену)."""
    client = await _get_client_async()
    if client is None:
        raise HTTPException(
            status_code=503,
            detail="Yandex Music API недоступен. Задайте YANDEX_MUSIC_TOKEN."
        )

    try:
        # Получаем плейлист
        playlist = await asyncio.to_thread(
            client.users_playlists,
            playlist_id,
            user_id
        )
        if not playlist:
            raise HTTPException(status_code=404, detail="Плейлист не найден")

        # Получаем треки плейлиста
        playlist_tracks_result = await asyncio.to_thread(
            client.users_playlists_tracks,
            playlist_id,
            user_id
        )

        tracks = []
        if playlist_tracks_result:
            for track in playlist_tracks_result[:_MAX_TRACKS]:
                track_info = _extract_track_info(track)
                if track_info:
                    tracks.append(track_info)

        # Обложка плейлиста
        cover_url = None
        if hasattr(playlist, 'cover') and playlist.cover:
            cover_url = _cover_url(getattr(playlist.cover, "uri", None))

        return playlist.title, cover_url, tracks
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Ошибка получения плейлиста %s/%s: %s", user_id, playlist_id, e)
        raise HTTPException(status_code=500, detail="Ошибка получения данных из Yandex Music")


async def get_user_likes(
    request: Optional[Request],
    user_id: Optional[str] = None,
) -> Tuple[Optional[str], Optional[str], List[YandexMusicTrack]]:
    """Получает избранное/лайки пользователя из Yandex Music (по токену)."""
    client = await _get_client_async()
    if client is None:
        raise HTTPException(
            status_code=503,
            detail="Yandex Music API недоступен. Задайте YANDEX_MUSIC_TOKEN."
        )

    try:
        # Без user_id библиотека вернёт лайки владельца токена.
        likes = await asyncio.to_thread(client.users_likes_tracks, user_id)
        if not likes or not hasattr(likes, 'library') or not likes.library:
            return "Избранное (Yandex Music)", None, []

        tracks = []
        # Получаем информацию о каждом треке
        track_ids = likes.library[:500]  # Ограничиваем

        if track_ids:
            # Получаем треки по ID
            full_tracks = await asyncio.to_thread(
                client.tracks,
                [str(t.track_id) for t in track_ids if hasattr(t, 'track_id')]
            )
            if full_tracks:
                for track in full_tracks:
                    track_info = _extract_track_info(track)
                    if track_info:
                        tracks.append(track_info)

        return "Избранное (Yandex Music)", None, tracks
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Ошибка получения лайков пользователя %s: %s", user_id, e)
        raise HTTPException(status_code=500, detail="Ошибка получения данных из Yandex Music")


async def get_track_by_id(
    request: Optional[Request],
    track_id: str,
) -> Tuple[Optional[str], Optional[str], List[YandexMusicTrack]]:
    """Получает одиночный трек из Yandex Music (по токену)."""
    client = await _get_client_async()
    if client is None:
        raise HTTPException(
            status_code=503,
            detail="Yandex Music API недоступен. Задайте YANDEX_MUSIC_TOKEN."
        )

    try:
        found = await asyncio.to_thread(client.tracks, [str(track_id)])
        track_info = _extract_track_info(found[0]) if found else None
        if not track_info:
            raise HTTPException(status_code=404, detail="Трек не найден")
        return track_info.title, track_info.cover_url, [track_info]
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Ошибка получения трека %s: %s", track_id, e)
        raise HTTPException(status_code=500, detail="Ошибка получения данных из Yandex Music")


# ─── HTTP-эндпоинты ───


async def _entity_response(
    request: Request, kind: str, params: Dict[str, str]
) -> Dict[str, Any]:
    result = await fetch_entity(request, kind, params)
    if result is None:
        raise HTTPException(status_code=502, detail=_UNAVAILABLE_DETAIL)
    title, cover, tracks = result
    return {
        "title": title,
        "cover_url": cover,
        "tracks": tracks,
        "track_count": len(tracks),
    }


@router.get("/search", response_model=List[YandexMusicTrack])
async def search_endpoint(
    request: Request,
    q: str = Query(..., min_length=1),
    limit: int = Query(20, ge=1, le=50),
):
    """Поиск треков в Yandex Music."""
    return await search_yandex_music(request, q, limit)


@router.get("/album/{album_id}")
async def get_album(request: Request, album_id: str):
    """Получает информацию об альбоме и его треках."""
    return await _entity_response(request, "album", {"album_id": album_id})


@router.get("/artist/{artist_id}")
async def get_artist(request: Request, artist_id: str):
    """Получает информацию об артисте и его треках."""
    return await _entity_response(request, "artist", {"artist_id": artist_id})


@router.get("/playlist/{user_id}/{playlist_id}")
async def get_playlist(request: Request, user_id: str, playlist_id: str):
    """Получает информацию о плейлисте и его треках."""
    return await _entity_response(request, "playlist", {"owner": user_id, "kind": playlist_id})


@router.get("/likes/{user_id}")
async def get_likes(request: Request, user_id: str):
    """Получает избранное/лайки пользователя."""
    return await _entity_response(request, "likes", {"owner": user_id})


@router.get("/status")
async def check_status():
    """Статус интеграции.

    Импорт работает и без токена (публичные веб-хендлеры), поэтому
    connected=false здесь не означает «Yandex Music недоступен».
    """
    client = await _get_client_async()
    return {
        "configured": bool(YANDEX_MUSIC_TOKEN),
        "connected": client is not None,
        "token_set": bool(YANDEX_MUSIC_TOKEN),
        "keyless": True,
    }
