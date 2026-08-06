"""Нативная интеграция со Spotify (только метаданные).

Аудио Spotify закрыто DRM и через API не отдаётся — поэтому здесь мы забираем
ТОЛЬКО метаданные (плейлисты, альбомы, треки, топ артиста), а играбельными
треки делает матчинг в YouTube Music (см. importer.py), тем же путём, что уже
используется для Yandex Music.

Два источника метаданных, в порядке предпочтения:

1. Web API (нужны SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET из
   https://developer.spotify.com/dashboard). Авторизация Client Credentials:
   публичные плейлисты, альбомы, артисты, треки — с полной пагинацией и ISRC.
   Приватные плейлисты и библиотека пользователя требуют OAuth с его согласия и
   здесь не поддерживаются; алгоритмические/редакционные подборки (Discover
   Weekly, Radio, «Made For You») новым приложениям недоступны — API отдаёт 404.

2. Страница встроенного плеера open.spotify.com/embed/... — БЕЗ ключей. Это
   публичный HTML со сервер-рендеренным JSON (`__NEXT_DATA__`), тот же, что
   отдаётся любому сайту со вставленным виджетом Spotify. Работает без всякой
   авторизации и вытягивает в том числе редакционные подборки, на которые Web
   API отвечает 404. Ограничение: не больше _EMBED_TRACK_LIMIT треков коллекции
   и нет ISRC — за длинными плейлистами нужен путь (1).

Если ключей нет, используется только (2); если есть — (1), а (2) остаётся
фолбэком на случай, когда Web API отказал.
"""

import asyncio
import json
import logging
import os
import re
import time
from typing import Any, Dict, List, Optional, Tuple

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter()

SPOTIFY_CLIENT_ID = os.getenv("SPOTIFY_CLIENT_ID", "")
SPOTIFY_CLIENT_SECRET = os.getenv("SPOTIFY_CLIENT_SECRET", "")
# Рынок для эндпоинтов, где он обязателен (топ-треки артиста) и где влияет на
# доступность треков. ISO 3166-1 alpha-2.
SPOTIFY_MARKET = os.getenv("SPOTIFY_MARKET", "US")

_TOKEN_URL = "https://accounts.spotify.com/api/token"
_API_BASE = "https://api.spotify.com/v1"
_EMBED_BASE = "https://open.spotify.com/embed"

_TIMEOUT = httpx.Timeout(10.0, read=20.0)
# Предохранители на размер коллекции: страницы по 50-100 элементов.
_PAGE_LIMIT = 100
_MAX_ITEMS = 10_000
# Сколько треков коллекции отдаёт страница встроенного плеера. Это её потолок,
# пагинации там нет — за остальным нужен Web API с ключами.
_EMBED_TRACK_LIMIT = 100

# Страница embed отдаётся только «браузеру»: с curl-подобным UA прилетает 403.
_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
_NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', re.DOTALL
)

# Кэш access-токена процесса: (token, expires_at_monotonic).
_token: Optional[str] = None
_token_expires_at: float = 0.0
_token_lock = asyncio.Lock()


class SpotifyTrack(BaseModel):
    """Трек Spotify — метаданные без стрима (stream_url всегда пуст)."""
    id: str
    title: str
    artist: str
    album: Optional[str] = None
    duration: int = 0
    cover_url: Optional[str] = None
    isrc: Optional[str] = None


def is_configured() -> bool:
    return bool(SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET)


async def _get_token() -> Optional[str]:
    """Access-токен Client Credentials с кэшем на время жизни.

    None — если приложение не настроено или Spotify отказал (интеграция тогда
    просто выключена, вызывающий падает на другой источник).
    """
    global _token, _token_expires_at

    if not is_configured():
        return None

    async with _token_lock:
        if _token and time.monotonic() < _token_expires_at:
            return _token
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                resp = await client.post(
                    _TOKEN_URL,
                    data={"grant_type": "client_credentials"},
                    auth=(SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET),
                )
            if resp.status_code != 200:
                logger.error(
                    "Spotify token request failed: %s %s", resp.status_code, resp.text[:200]
                )
                return None
            payload = resp.json()
            _token = payload.get("access_token")
            # Обновляем чуть раньше истечения, чтобы не поймать 401 в полёте.
            _token_expires_at = time.monotonic() + max(30, int(payload.get("expires_in", 3600)) - 60)
            return _token
        except Exception as exc:  # noqa: BLE001 — сеть/недоступность
            logger.error("Spotify token request error: %s", exc)
            _token = None
            _token_expires_at = 0.0
            return None


def _invalidate_token() -> None:
    global _token, _token_expires_at
    _token = None
    _token_expires_at = 0.0


def _require_configured() -> None:
    if not is_configured():
        raise HTTPException(
            status_code=503,
            detail="Spotify API не настроен. Задайте SPOTIFY_CLIENT_ID и "
                   "SPOTIFY_CLIENT_SECRET в .env "
                   "(https://developer.spotify.com/dashboard).",
        )


async def _api_get(path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """GET к Spotify Web API. path — либо '/playlists/{id}', либо полный URL.

    Полный URL нужен для пагинации: Spotify отдаёт готовую ссылку в поле `next`.
    Кидает HTTPException: 503 (не настроен/нет токена), 404, 429, 502.
    """
    _require_configured()

    url = path if path.startswith("http") else f"{_API_BASE}{path}"
    # 401 — истёкший токен (перевыпускаем и повторяем один раз);
    # 429 — рейт-лимит (ждём Retry-After, максимум пара попыток).
    attempts = 0
    while True:
        attempts += 1
        token = await _get_token()
        if not token:
            raise HTTPException(
                status_code=503,
                detail="Не удалось авторизоваться в Spotify API. Проверьте "
                       "SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET.",
            )
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                resp = await client.get(
                    url,
                    params=params,
                    headers={"Authorization": f"Bearer {token}"},
                )
        except Exception as exc:  # noqa: BLE001 — сеть
            logger.warning("Spotify request failed for %s: %s", url, exc)
            raise HTTPException(status_code=502, detail="Spotify API недоступен") from exc

        if resp.status_code == 200:
            try:
                return resp.json() or {}
            except ValueError as exc:
                raise HTTPException(status_code=502, detail="Некорректный ответ Spotify API") from exc

        if resp.status_code == 401 and attempts <= 2:
            _invalidate_token()
            continue

        if resp.status_code == 429 and attempts <= 3:
            delay = min(10, max(1, int(resp.headers.get("Retry-After") or 1)))
            logger.info("Spotify rate limit, retry in %ss (%s)", delay, url)
            await asyncio.sleep(delay)
            continue

        if resp.status_code == 404:
            raise HTTPException(
                status_code=404,
                detail="Ресурс Spotify не найден или недоступен приложению "
                       "(приватные и алгоритмические подборки не поддерживаются)",
            )

        logger.warning("Spotify API %s for %s: %s", resp.status_code, url, resp.text[:200])
        raise HTTPException(status_code=502, detail="Ошибка Spotify API")


async def _paged_items(path: str, params: Optional[Dict[str, Any]] = None) -> List[dict]:
    """Собирает все элементы постранично (items + next), до _MAX_ITEMS."""
    items: List[dict] = []
    page = await _api_get(path, params)
    while True:
        items.extend(i for i in (page.get("items") or []) if i)
        next_url = page.get("next")
        if not next_url or len(items) >= _MAX_ITEMS:
            break
        page = await _api_get(next_url)
    return items[:_MAX_ITEMS]


def _biggest_image(images: Optional[List[dict]]) -> Optional[str]:
    """Самая большая обложка из списка images.

    Spotify обычно отдаёт их по убыванию, но width иногда null (плейлисты с
    мозаичной обложкой) — тогда просто берём первую с url.
    """
    best_url: Optional[str] = None
    best_width = -1
    for image in images or []:
        url = image.get("url")
        if not url:
            continue
        width = image.get("width") or 0
        if best_url is None or width > best_width:
            best_url, best_width = url, width
    return best_url


def _track_from_object(obj: Optional[dict], fallback_album: Optional[dict] = None) -> Optional[SpotifyTrack]:
    """Объект трека Spotify → SpotifyTrack. None — если это не играбельный трек.

    fallback_album нужен для треков внутри альбома: в /albums/{id}/tracks у
    элементов нет ни поля album, ни обложек — они лежат на самом альбоме.
    """
    if not obj or obj.get("type") == "episode":
        return None  # подкаст-эпизоды в плейлисте — не музыка, пропускаем

    track_id = obj.get("id")
    title = obj.get("name")
    if not track_id or not title:
        # Локальные файлы пользователя в плейлисте (is_local) приходят без id.
        return None

    artists = [a.get("name") for a in (obj.get("artists") or []) if a.get("name")]
    album_obj = obj.get("album") or fallback_album or {}

    return SpotifyTrack(
        id=str(track_id),
        title=title,
        artist=", ".join(artists) or "Unknown Artist",
        album=album_obj.get("name"),
        duration=int((obj.get("duration_ms") or 0) // 1000),
        cover_url=_biggest_image(album_obj.get("images")),
        isrc=(obj.get("external_ids") or {}).get("isrc"),
    )


async def search_spotify(query: str, limit: int = 20) -> List[SpotifyTrack]:
    """Поиск треков в Spotify. Пустой список — если интеграция не настроена."""
    if not is_configured():
        return []

    try:
        data = await _api_get(
            "/search",
            {"q": query, "type": "track", "limit": min(50, max(1, limit)), "market": SPOTIFY_MARKET},
        )
    except HTTPException as exc:
        logger.warning("Spotify search failed for %r: %s", query, exc.detail)
        return []

    tracks: List[SpotifyTrack] = []
    for item in (data.get("tracks") or {}).get("items") or []:
        track = _track_from_object(item)
        if track:
            tracks.append(track)
    return tracks[:limit]


async def get_playlist_tracks(playlist_id: str) -> Tuple[Optional[str], Optional[str], List[SpotifyTrack]]:
    """Треки публичного плейлиста Spotify → (название, обложка, треки)."""
    meta = await _api_get(f"/playlists/{playlist_id}", {"market": SPOTIFY_MARKET})
    items = await _paged_items(
        f"/playlists/{playlist_id}/tracks",
        {"limit": _PAGE_LIMIT, "market": SPOTIFY_MARKET},
    )

    tracks: List[SpotifyTrack] = []
    for item in items:
        track = _track_from_object(item.get("track"))
        if track:
            tracks.append(track)

    return meta.get("name"), _biggest_image(meta.get("images")), tracks


async def get_album_tracks(album_id: str) -> Tuple[Optional[str], Optional[str], List[SpotifyTrack]]:
    """Треки альбома Spotify → (название, обложка, треки)."""
    album = await _api_get(f"/albums/{album_id}", {"market": SPOTIFY_MARKET})

    tracks: List[SpotifyTrack] = []
    # Первая страница треков уже вложена в объект альбома — не тратим на неё
    # отдельный запрос, дальше идём по next.
    page = album.get("tracks") or {}
    while True:
        for item in page.get("items") or []:
            track = _track_from_object(item, fallback_album=album)
            if track:
                tracks.append(track)
        next_url = page.get("next")
        if not next_url or len(tracks) >= _MAX_ITEMS:
            break
        page = await _api_get(next_url)

    return album.get("name"), _biggest_image(album.get("images")), tracks[:_MAX_ITEMS]


async def get_artist_tracks(artist_id: str) -> Tuple[Optional[str], Optional[str], List[SpotifyTrack]]:
    """Топ-треки артиста Spotify → (имя, фото, треки).

    Spotify не отдаёт «все треки артиста» одним эндпоинтом; top-tracks — это
    10 самых популярных в заданном рынке.
    """
    artist = await _api_get(f"/artists/{artist_id}")
    data = await _api_get(f"/artists/{artist_id}/top-tracks", {"market": SPOTIFY_MARKET})

    tracks: List[SpotifyTrack] = []
    for item in data.get("tracks") or []:
        track = _track_from_object(item)
        if track:
            tracks.append(track)

    return artist.get("name"), _biggest_image(artist.get("images")), tracks


async def get_track(track_id: str) -> Tuple[Optional[str], Optional[str], List[SpotifyTrack]]:
    """Одиночный трек Spotify → (название, обложка, [трек])."""
    data = await _api_get(f"/tracks/{track_id}", {"market": SPOTIFY_MARKET})
    track = _track_from_object(data)
    if not track:
        raise HTTPException(status_code=404, detail="Трек Spotify не найден")
    return track.title, track.cover_url, [track]


# ─── Без ключей: страница встроенного плеера ───


async def _fetch_embed_html(kind: str, entity_id: str) -> str:
    """HTML страницы open.spotify.com/embed/{kind}/{id}. 404 — нет такой сущности."""
    url = f"{_EMBED_BASE}/{kind}/{entity_id}"
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True) as client:
            resp = await client.get(
                url,
                headers={"User-Agent": _BROWSER_UA, "Accept-Language": "en"},
            )
    except Exception as exc:  # noqa: BLE001 — сеть
        logger.warning("Spotify embed request failed for %s: %s", url, exc)
        raise HTTPException(status_code=502, detail="Spotify недоступен") from exc

    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail="Ресурс Spotify не найден или скрыт")
    if resp.status_code != 200:
        logger.warning("Spotify embed %s for %s", resp.status_code, url)
        raise HTTPException(status_code=502, detail="Ошибка Spotify")
    return resp.text


def _entity_from_embed_html(html: str) -> dict:
    """`__NEXT_DATA__` из HTML embed → объект сущности (плейлист/альбом/трек).

    Страница может отрендериться и с 200, но без сущности — тогда в pageProps
    лежит страница-ошибка со своим status (так отвечает Spotify на скрытые и
    несуществующие id).
    """
    match = _NEXT_DATA_RE.search(html or "")
    if not match:
        logger.warning("Spotify embed: __NEXT_DATA__ не найден (разметка изменилась)")
        raise HTTPException(status_code=502, detail="Не удалось разобрать ответ Spotify")

    try:
        page = json.loads(match.group(1))["props"]["pageProps"]
    except (ValueError, KeyError, TypeError) as exc:
        logger.warning("Spotify embed: неожиданная структура __NEXT_DATA__: %s", exc)
        raise HTTPException(status_code=502, detail="Не удалось разобрать ответ Spotify") from exc

    entity = ((page.get("state") or {}).get("data") or {}).get("entity") or {}
    if not entity:
        if int(page.get("status") or 0) == 404:
            raise HTTPException(status_code=404, detail="Ресурс Spotify не найден или скрыт")
        raise HTTPException(status_code=502, detail="Spotify не отдал содержимое")
    return entity


def _embed_cover(obj: dict) -> Optional[str]:
    """Обложка сущности embed.

    У плейлистов она лежит в coverArt.sources, у альбомов/треков/артистов —
    в visualIdentity.image (там ширина называется maxWidth).
    """
    cover = _biggest_image((obj.get("coverArt") or {}).get("sources"))
    if cover:
        return cover
    images = (obj.get("visualIdentity") or {}).get("image") or []
    return _biggest_image(
        [{"url": i.get("url"), "width": i.get("maxWidth")} for i in images if i]
    )


def _embed_artist(obj: dict) -> str:
    """Артисты элемента embed.

    В списке треков они склеены в subtitle через запятую с неразрывным пробелом
    (U+00A0) — его надо развернуть, иначе строка поедет в матчинг как есть.
    У одиночного трека вместо subtitle приходит массив artists.
    """
    names = [a.get("name") for a in (obj.get("artists") or []) if a.get("name")]
    if names:
        return ", ".join(names)
    #   — тот самый неразрывный пробел после запятой.
    subtitle = (obj.get("subtitle") or "").replace(" ", " ").strip()
    return subtitle or "Unknown Artist"


def _track_from_embed(
    obj: dict, fallback_cover: Optional[str] = None, album: Optional[str] = None
) -> Optional[SpotifyTrack]:
    """Элемент trackList (или сам трек) → SpotifyTrack. None — если это не трек."""
    if not obj:
        return None
    uri = obj.get("uri") or ""
    track_id = obj.get("id")
    if not track_id and uri.startswith("spotify:track:"):
        track_id = uri.rsplit(":", 1)[-1]
    title = obj.get("title") or obj.get("name")
    if not track_id or not title:
        # Эпизоды подкастов и локальные файлы — не музыка, пропускаем.
        return None
    if obj.get("entityType") not in (None, "track") or obj.get("type") not in (None, "track"):
        return None

    return SpotifyTrack(
        id=str(track_id),
        title=title,
        artist=_embed_artist(obj),
        album=album,
        # duration тут в миллисекундах, как и в Web API.
        duration=int(obj.get("duration") or 0) // 1000,
        cover_url=_embed_cover(obj) or fallback_cover,
    )


async def fetch_embed(kind: str, entity_id: str) -> Tuple[Optional[str], Optional[str], List[SpotifyTrack]]:
    """Метаданные коллекции/трека без ключей → (название, обложка, треки)."""
    entity = _entity_from_embed_html(await _fetch_embed_html(kind, entity_id))

    name = entity.get("name") or entity.get("title")
    cover = _embed_cover(entity)
    items = entity.get("trackList") or []

    if not items:
        # Одиночный трек: сущность и есть трек, списка нет.
        track = _track_from_embed(entity, cover)
        if not track:
            raise HTTPException(status_code=404, detail="По ссылке Spotify не найдено треков")
        return name, cover, [track]

    # У элементов списка нет ни своей обложки, ни альбома: для альбома название
    # известно, для плейлиста — нет (там треки из разных альбомов).
    album = name if kind == "album" else None
    tracks = [t for t in (_track_from_embed(i, cover, album) for i in items) if t]

    if len(items) >= _EMBED_TRACK_LIMIT:
        logger.info(
            "Spotify embed отдал %s треков (%s/%s) — это его потолок, "
            "хвост коллекции доступен только с SPOTIFY_CLIENT_ID/SECRET",
            len(items), kind, entity_id,
        )
    return name, cover, tracks


# ─── Разбор ссылок ───

# https://open.spotify.com/playlist/{id}, с необязательным локальным префиксом
# (/intl-ru/) и любым query (?si=...).
_WEB_URL_RE = re.compile(
    r"open\.spotify\.com/(?:intl-[a-z]{2}/)?(track|album|playlist|artist)/([A-Za-z0-9]+)",
    re.IGNORECASE,
)
# spotify:playlist:{id} — URI из десктопного клиента («Копировать Spotify URI»).
_URI_RE = re.compile(r"^spotify:(track|album|playlist|artist):([A-Za-z0-9]+)", re.IGNORECASE)
# Короткие ссылки из мобильного «Поделиться» — резолвятся редиректом.
_SHORT_HOSTS = ("spotify.link", "spotify.app.link")


def parse_url(url: str) -> Optional[Tuple[str, str]]:
    """Ссылка/URI Spotify → (kind, id) или None, если это не Spotify.

    kind: track | album | playlist | artist.
    """
    if not url:
        return None
    match = _URI_RE.match(url.strip()) or _WEB_URL_RE.search(url)
    if not match:
        return None
    return match.group(1).lower(), match.group(2)


def is_short_link(url: str) -> bool:
    return any(host in (url or "").lower() for host in _SHORT_HOSTS)


async def resolve_short_link(url: str) -> str:
    """spotify.link/... → полный open.spotify.com URL (или исходный при сбое)."""
    if not is_short_link(url):
        return url
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True) as client:
            resp = await client.get(url, headers={"User-Agent": "Mozilla/5.0"})
        final = str(resp.url)
        return final if "open.spotify.com" in final else url
    except Exception as exc:  # noqa: BLE001 — сеть
        logger.warning("Spotify short link resolve failed for %s: %s", url, exc)
        return url


async def _fetch_via_api(kind: str, entity_id: str) -> Tuple[Optional[str], Optional[str], List[SpotifyTrack]]:
    """Ссылка → метаданные через Web API (нужны ключи)."""
    if kind == "playlist":
        return await get_playlist_tracks(entity_id)
    if kind == "album":
        return await get_album_tracks(entity_id)
    if kind == "artist":
        return await get_artist_tracks(entity_id)
    return await get_track(entity_id)


async def fetch_entity(kind: str, entity_id: str) -> Tuple[Optional[str], Optional[str], List[SpotifyTrack]]:
    """(kind, id) → (название, обложка, треки).

    С ключами идём в Web API (полная пагинация), без ключей — сразу на страницу
    встроенного плеера. Если Web API отказал (истёкшие ключи, недоступная
    приложению редакционная подборка), embed остаётся вторым шансом.
    """
    if is_configured():
        try:
            return await _fetch_via_api(kind, entity_id)
        except HTTPException as exc:
            logger.warning(
                "Spotify Web API отказал (%s: %s) для %s/%s — пробуем embed",
                exc.status_code, exc.detail, kind, entity_id,
            )
    return await fetch_embed(kind, entity_id)


async def fetch_by_url(url: str) -> Tuple[Optional[str], Optional[str], List[SpotifyTrack]]:
    """Ссылка Spotify → (название, обложка, треки). 400 на нераспознанную."""
    parsed = parse_url(url)
    if not parsed:
        raise HTTPException(status_code=400, detail="Не распознана ссылка Spotify")
    return await fetch_entity(*parsed)


# ─── HTTP-эндпоинты ───


@router.get("/search", response_model=List[SpotifyTrack])
async def search_endpoint(
    request: Request,
    q: str = Query(..., min_length=1),
    limit: int = Query(20, ge=1, le=50),
):
    """Поиск треков в Spotify (метаданные; играбельность — через импорт)."""
    return await search_spotify(q, limit)


@router.get("/playlist/{playlist_id}")
async def playlist_endpoint(playlist_id: str):
    """Плейлист Spotify и его треки."""
    title, cover, tracks = await fetch_entity("playlist", playlist_id)
    return {"title": title, "cover_url": cover, "tracks": tracks, "track_count": len(tracks)}


@router.get("/album/{album_id}")
async def album_endpoint(album_id: str):
    """Альбом Spotify и его треки."""
    title, cover, tracks = await fetch_entity("album", album_id)
    return {"title": title, "cover_url": cover, "tracks": tracks, "track_count": len(tracks)}


@router.get("/artist/{artist_id}")
async def artist_endpoint(artist_id: str):
    """Артист Spotify и его топ-треки."""
    name, cover, tracks = await fetch_entity("artist", artist_id)
    return {"title": name, "cover_url": cover, "tracks": tracks, "track_count": len(tracks)}


@router.get("/track/{track_id}")
async def track_endpoint(track_id: str):
    """Одиночный трек Spotify."""
    title, cover, tracks = await fetch_entity("track", track_id)
    return {"title": title, "cover_url": cover, "tracks": tracks, "track_count": len(tracks)}


@router.get("/status")
async def check_status():
    """Статус интеграции: есть ли ключи и выдаётся ли токен.

    Импорт работает и без ключей (через страницу встроенного плеера), поэтому
    connected=false здесь не означает «Spotify недоступен».
    """
    token = await _get_token() if is_configured() else None
    return {
        "configured": is_configured(),
        "connected": bool(token),
        "keyless": True,
        "keyless_track_limit": _EMBED_TRACK_LIMIT,
        "market": SPOTIFY_MARKET,
    }
