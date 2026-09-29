"""Нативная интеграция с Yandex Music (только метаданные).

Аудио Yandex Music мы не стримим — играбельными треки делает матчинг в
YouTube Music (см. importer.py). Отсюда нужны названия, артисты, обложки и
длительности.

Два источника, в порядке предпочтения:

1. Пакет yandex-music по OAuth-токену (YANDEX_MUSIC_TOKEN). Даёт всё, включая
   собственную библиотеку пользователя и приватные плейлисты.
   Токен: https://github.com/MarshalX/yandex-music/blob/main/docs/authentication.md

2. Анонимный api.music.yandex.net — БЕЗ токена. Тот же API, что у приложений
   и нового сайта: публичные плейлисты, профили (список плейлистов владельца),
   альбомы, артисты, треки и открытое «Мне нравится» отдаются без авторизации.
   Приватные коллекции этим путём недоступны. Старые веб-хендлеры
   music.yandex.ru/handlers/*.jsx после переезда сайта отвечают редиректом на
   HTML — ими больше не пользуемся.

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

# ─── Публичный API (без токена) ───

_API_BASE = "https://api.music.yandex.net"
_API_TIMEOUT = httpx.Timeout(10.0, read=30.0)
# Необязательный HTTP-прокси для запросов к Yandex (http://user:pass@host:port).
# Метаданные api.music.yandex.net отдаются и зарубежным IP; прокси нужен, только
# если адрес сервера всё же отрезали — тогда хватит выхода из РФ/СНГ.
_API_PROXY = os.getenv("YANDEX_MUSIC_PROXY", "").strip() or None
_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
# Предохранитель на размер коллекции.
_MAX_TRACKS = 10_000
# Сколько id зараз просим у POST /tracks (длинные запросы режут).
_ID_CHUNK = 200
# Страница треков артиста.
_ARTIST_PAGE = 100
# Сколько плейлистов профиля отдаём в импорт: у редакционных аккаунтов их
# тысячи, а импорт каждого — это матчинг всех треков в YouTube Music.
MAX_PROFILE_PLAYLISTS = 100

_UNAVAILABLE_DETAIL = (
    "Yandex Music не отдал данные. Возможные причины:\n"
    "1. Коллекция или профиль приватные — откройте их в настройках Yandex Music\n"
    "2. Ссылка неверная или коллекция удалена\n"
    "3. Сервис недоступен с IP сервера (геоблокировка) — задайте YANDEX_MUSIC_PROXY"
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


async def _api(
    path: str,
    params: Optional[Dict[str, Any]] = None,
    data: Optional[Dict[str, Any]] = None,
) -> Optional[Any]:
    """Анонимный запрос к api.music.yandex.net. Возвращает `result` или None.

    Не бросает: любой отказ (сеть, 4xx/5xx, приватность, смена формата) — это
    сигнал вызывающему попробовать следующий источник, а не ошибка запроса юзера.
    """
    url = f"{_API_BASE}/{path.lstrip('/')}"
    headers = {
        "User-Agent": _BROWSER_UA,
        "Accept": "application/json",
        "Accept-Language": "ru",
    }
    try:
        async with httpx.AsyncClient(
            timeout=_API_TIMEOUT, follow_redirects=True, proxy=_API_PROXY
        ) as client:
            if data is None:
                resp = await client.get(url, params=params, headers=headers)
            else:
                resp = await client.post(url, params=params, data=data, headers=headers)
    except Exception as exc:  # noqa: BLE001 — сеть
        logger.warning("Yandex API %s недоступен: %s", path, exc)
        return None

    try:
        payload = resp.json()
    except ValueError:
        logger.warning("Yandex API %s → HTTP %s, не JSON", path, resp.status_code)
        return None

    if resp.status_code != 200 or not isinstance(payload, dict) or "result" not in payload:
        # 404 playlist-not-found, 401 для несуществующего логина, 403 приватное.
        error = payload.get("error") if isinstance(payload, dict) else None
        logger.warning("Yandex API %s → HTTP %s %s", path, resp.status_code, error)
        return None
    return payload["result"]


def _track_from_web(obj: dict) -> Optional[YandexMusicTrack]:
    """Объект трека из API → YandexMusicTrack."""
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


def _entry_id(item: Any) -> Optional[str]:
    """Короткая запись трека → id вида `trackId:albumId` для POST /tracks."""
    if not isinstance(item, dict) or not item.get("id"):
        return None
    album_id = item.get("albumId")
    return f"{item['id']}:{album_id}" if album_id else str(item["id"])


async def _public_tracks_by_ids(entries: List[str]) -> List[YandexMusicTrack]:
    """Полные треки по id вида `trackId:albumId` (так их отдаёт библиотека)."""
    tracks: List[YandexMusicTrack] = []
    for start in range(0, min(len(entries), _MAX_TRACKS), _ID_CHUNK):
        chunk = entries[start:start + _ID_CHUNK]
        data = await _api("tracks", data={"track-ids": ",".join(chunk), "with-positions": "false"})
        if not isinstance(data, list):
            break
        tracks.extend(_tracks_from_web(data))
    return tracks


async def _playlist_tracks(playlist: dict) -> List[YandexMusicTrack]:
    """Треки плейлиста: полные объекты, а короткие записи дотягиваем по id."""
    items = playlist.get("tracks") or []
    if items and all(isinstance(i, dict) and isinstance(i.get("track"), dict) for i in items):
        return _tracks_from_web(items)
    ids = [e for e in (_entry_id(i) for i in items) if e]
    return await _public_tracks_by_ids(ids)


async def _public_album(album_id: str) -> Optional[Tuple[Optional[str], Optional[str], List[YandexMusicTrack]]]:
    data = await _api(f"albums/{album_id}/with-tracks")
    if not isinstance(data, dict) or not data.get("title"):
        return None
    # Треки альбома разложены по дискам (volumes).
    tracks: List[YandexMusicTrack] = []
    for volume in data.get("volumes") or []:
        tracks.extend(_tracks_from_web(volume))
    return data.get("title"), _web_cover(data), tracks


async def _public_artist(artist_id: str) -> Optional[Tuple[Optional[str], Optional[str], List[YandexMusicTrack]]]:
    info = await _api(f"artists/{artist_id}/brief-info")
    artist = (info or {}).get("artist") if isinstance(info, dict) else None
    if not isinstance(artist, dict) or not artist.get("name"):
        return None

    tracks: List[YandexMusicTrack] = []
    page = 0
    while len(tracks) < _MAX_TRACKS:
        data = await _api(
            f"artists/{artist_id}/tracks", {"page": page, "page-size": _ARTIST_PAGE}
        )
        if not isinstance(data, dict):
            break
        batch = data.get("tracks") or []
        tracks.extend(_tracks_from_web(batch))
        total = int((data.get("pager") or {}).get("total") or 0)
        page += 1
        if not batch or page * _ARTIST_PAGE >= total:
            break
    return artist["name"], _web_cover(artist), tracks


async def _public_playlist(owner: str, kind: str) -> Optional[Tuple[Optional[str], Optional[str], List[YandexMusicTrack]]]:
    playlist = await _api(f"users/{owner}/playlists/{kind}")
    if not isinstance(playlist, dict) or not playlist.get("title"):
        return None
    return playlist["title"], _web_cover(playlist), await _playlist_tracks(playlist)


async def _public_playlist_uuid(uuid: str) -> Optional[Tuple[Optional[str], Optional[str], List[YandexMusicTrack]]]:
    """Плейлист по uuid — формат ссылок нового сайта (/playlists/<uuid>).

    Так же открывается и «Мне нравится» (uuid вида `lk.…`).
    """
    playlist = await _api(f"playlist/{uuid}")
    if not isinstance(playlist, dict) or not playlist.get("title"):
        return None
    return playlist["title"], _web_cover(playlist), await _playlist_tracks(playlist)


async def _public_track(track_id: str, album_id: Optional[str] = None) -> Optional[Tuple[Optional[str], Optional[str], List[YandexMusicTrack]]]:
    entry = f"{track_id}:{album_id}" if album_id else str(track_id)
    data = await _api(f"tracks/{entry}")
    track = _track_from_web(data[0]) if isinstance(data, list) and data else None
    if not track:
        return None
    return track.title, track.cover_url, [track]


async def _likes_ids(owner: str) -> Optional[List[str]]:
    """id треков открытого «Мне нравится». None — закрыто или не нашлось."""
    data = await _api(f"users/{owner}/likes/tracks")
    library = (data or {}).get("library") if isinstance(data, dict) else None
    if not isinstance(library, dict):
        return None
    return [e for e in (_entry_id(i) for i in library.get("tracks") or []) if e]


async def _public_likes(owner: str) -> Optional[Tuple[Optional[str], Optional[str], List[YandexMusicTrack]]]:
    """Открытое «Мне нравится» пользователя. Приватное отдаётся ошибкой."""
    ids = await _likes_ids(owner)
    if not ids:
        return None
    tracks = await _public_tracks_by_ids(ids)
    return f"Мне нравится — {owner} (Yandex Music)", None, tracks


class YandexCollection(BaseModel):
    """Коллекция в профиле: плейлист или «Мне нравится»."""
    key: str                    # likes | playlist:<kind> — выбор в UI
    kind: str                   # likes | playlist (как у parse_url)
    params: Dict[str, str]
    title: str
    cover_url: Optional[str] = None
    track_count: int = 0


async def fetch_profile(owner: str) -> Optional[Tuple[str, List[YandexCollection]]]:
    """Профиль → (имя владельца, коллекции). Без токена — только публичное.

    Сначала «Мне нравится» (если открыто), затем плейлисты владельца
    (не больше MAX_PROFILE_PLAYLISTS). None — профиль не найден или всё закрыто.
    """
    playlists, like_ids = await asyncio.gather(
        _api(f"users/{owner}/playlists/list"),
        _likes_ids(owner),
    )

    name = owner
    collections: List[YandexCollection] = []
    if like_ids:
        collections.append(YandexCollection(
            key="likes",
            kind="likes",
            params={"owner": owner},
            title="Мне нравится",
            track_count=len(like_ids),
        ))

    for item in (playlists if isinstance(playlists, list) else [])[:MAX_PROFILE_PLAYLISTS]:
        if not isinstance(item, dict) or item.get("kind") is None or not item.get("title"):
            continue
        name = ((item.get("owner") or {}).get("name")) or name
        if not item.get("trackCount"):
            continue
        kind = str(item["kind"])
        collections.append(YandexCollection(
            key=f"playlist:{kind}",
            kind="playlist",
            params={"owner": owner, "kind": kind},
            title=item["title"],
            cover_url=_web_cover(item),
            track_count=int(item["trackCount"]),
        ))

    if not collections:
        return None
    return name, collections


async def _public_search(query: str, limit: int) -> List[YandexMusicTrack]:
    data = await _api("search", {"text": query, "type": "track", "page": 0})
    if not isinstance(data, dict):
        return []
    items = ((data.get("tracks") or {}).get("results")) or []
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
# Новый сайт: /playlists/<uuid>, «Мне нравится» — /playlists/lk.<uuid>.
_UUID_PLAYLIST_RE = re.compile(r"^/playlists/((?:lk\.)?[0-9a-f]{8}-[0-9a-f-]{27})$", re.I)
# Профиль: /users/<login> или /users/<login>/playlists (без номера плейлиста).
_PROFILE_RE = re.compile(r"^/users/([^/]+)(?:/playlists)?$")


def parse_url(url: str) -> Optional[Tuple[str, Dict[str, str]]]:
    """Ссылка Yandex Music → (kind, параметры) или None, если это не Yandex.

    kind: track | album | artist | playlist | likes | profile.
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
    match = _UUID_PLAYLIST_RE.search(path)
    if match:
        return "playlist", {"uuid": match.group(1)}
    match = _USER_PLAYLIST_RE.search(path) or _SHORT_PLAYLIST_RE.search(path)
    if match:
        return "playlist", {"owner": match.group(1), "kind": match.group(2)}
    match = _PROFILE_RE.search(path)
    if match:
        return "profile", {"owner": match.group(1)}
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
        if kind == "playlist" and "uuid" not in params:
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
    """Забирает коллекцию через анонимный API (без токена)."""
    try:
        if kind == "album":
            return await _public_album(params["album_id"])
        if kind == "artist":
            return await _public_artist(params["artist_id"])
        if kind == "playlist" and "uuid" in params:
            return await _public_playlist_uuid(params["uuid"])
        if kind == "playlist":
            return await _public_playlist(params["owner"], params["kind"])
        if kind == "likes":
            return await _public_likes(params["owner"])
        if kind == "track":
            return await _public_track(params["track_id"], params.get("album_id"))
    except Exception as exc:  # noqa: BLE001 — смена формата ответа
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


@router.get("/profile/{user_id}")
async def get_profile(user_id: str):
    """Публичные коллекции профиля: «Мне нравится» и плейлисты."""
    result = await fetch_profile(user_id)
    if result is None:
        raise HTTPException(status_code=502, detail=_UNAVAILABLE_DETAIL)
    name, collections = result
    return {"name": name, "collections": collections}


@router.get("/status")
async def check_status():
    """Статус интеграции.

    Импорт работает и без токена (анонимный API), поэтому
    connected=false здесь не означает «Yandex Music недоступен».
    """
    client = await _get_client_async()
    return {
        "configured": bool(YANDEX_MUSIC_TOKEN),
        "connected": client is not None,
        "token_set": bool(YANDEX_MUSIC_TOKEN),
        "keyless": True,
    }
