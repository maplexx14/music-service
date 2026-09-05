import asyncio
import glob
import logging
import os
import re
import tempfile
import threading
import time
from typing import List, Optional
from urllib.parse import urlsplit

import aiofiles
import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from app import storage
from app.artist_utils import norm_artist_name, query_names_artist, translit_key
from app.cache import get_cache_async, record_proxy_traffic, set_cache_async
from app.schemas import ExternalAlbumDetail, ExternalAlbumResponse, ExternalTrackResponse

logger = logging.getLogger(__name__)

router = APIRouter()

def _patch_watch_tab_parser() -> None:
    """Шим под ytmusicapi==1.8.2: get_watch_playlist(radio=True) падал ВСЕГДА.

    `parsers/watch.get_tab_browse_id` считает, что раз у вкладки нет флага
    "unselectable", значит у неё точно есть "endpoint". YouTube это правило
    больше не соблюдает и отдаёт вкладку без endpoint — функция валится
    `KeyError: 'endpoint'` на ЛЮБОМ videoId (проверено на проде: 7 сидов из 7).
    Наверх это выглядело как "радио просто не работает": _radio_pool глотает
    исключение и пишет негативный кэш, поэтому единственный в сервисе источник
    ПОХОЖИХ треков молча исчезал из волны, и в потоке оставались только уже
    знакомые артисты.

    browse_id нужен лишь для необязательного поля "related" в ответе, поэтому
    None вместо исключения — безопасная деградация.

    Апстрим это уже починил (функция переписана в get_tab_browse_ids с
    безопасным nav), поэтому патч ищет цель мягко и молча ничего не делает,
    когда её нет: обновление ytmusicapi до 1.12.1 идёт отдельной задачей и не
    должно ронять импорт этого модуля.
    """
    try:
        from ytmusicapi.mixins import watch as watch_mixin
        from ytmusicapi.parsers import watch as watch_parsers

        original = watch_parsers.get_tab_browse_id
    except (ImportError, AttributeError):
        return

    def safe_get_tab_browse_id(watchNextRenderer, tab_id):
        try:
            return original(watchNextRenderer, tab_id)
        except (KeyError, IndexError, TypeError):
            return None

    watch_parsers.get_tab_browse_id = safe_get_tab_browse_id
    # Миксин импортировал функцию ПО ИМЕНИ (`from ..parsers.watch import
    # get_tab_browse_id`), поэтому патч одного только парсера ни на что не
    # влияет — подменяем обе ссылки.
    if hasattr(watch_mixin, "get_tab_browse_id"):
        watch_mixin.get_tab_browse_id = safe_get_tab_browse_id


# ytmusicapi/yt-dlp — опциональные зависимости. Если их нет, провайдер тихо
# отключается (search вернёт []), чтобы не ронять весь агрегатор.
#
# Cookie-сессия YouTube — главный рычаг против bot-check: «Sign in to confirm
# you're not a bot» прилетает анонимному датацентровому трафику, и залогиненный
# запрос его обходит. YTMUSIC_AUTH — путь к oauth/browser-файлу ytmusicapi
# (см. .env.example); при сбое файлa откатываемся на анонимную сессию, а не
# отключаем провайдер целиком.
_YTMUSIC_AUTH = os.getenv("YTMUSIC_AUTH", "").strip()
try:
    from ytmusicapi import YTMusic

    _patch_watch_tab_parser()
    if _YTMUSIC_AUTH:
        try:
            _ytmusic: Optional["YTMusic"] = YTMusic(auth=_YTMUSIC_AUTH)
        except Exception:  # noqa: BLE001 — битый/протухший auth-файл
            logger.warning(
                "YTMUSIC_AUTH=%s не открылся — ytmusicapi работает анонимно",
                _YTMUSIC_AUTH,
                exc_info=True,
            )
            _ytmusic = YTMusic()
    else:
        _ytmusic = YTMusic()
except Exception:  # noqa: BLE001 — библиотека может быть не установлена / без сети
    _ytmusic = None
    logger.warning("ytmusicapi недоступен — провайдер YouTube Music отключён")

MEDIA_TYPES = {
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".mp3": "audio/mpeg",
    ".opus": "audio/ogg",
    ".ogg": "audio/ogg",
    ".webm": "audio/webm",
}

# Мусор в заголовках YouTube, который мешает и показу, и дедупу с Soulseek.
_JUNK = re.compile(
    r"\s*[\(\[]\s*(?:official\s*(?:music\s*)?video|official\s*audio|lyrics?|"
    r"lyric\s*video|audio|visualizer|hd|hq|4k|mv|m/v|remaster(?:ed)?"
    r"(?:\s*\d{4})?)\s*[\)\]]",
    re.IGNORECASE,
)


def clean_title(text: str) -> str:
    """Убирает '(Official Video)', '[Lyrics]' и т.п. из названия."""
    return _JUNK.sub("", text or "").strip(" -–—")


def _upscale_thumb(url: str) -> str:
    """Просит у CDN Google обложку в большем разрешении.

    YouTube Music отдаёт превью с размером, зашитым в URL. Google-CDN ресайзит
    по запросу, поэтому достаточно переписать параметры размера:
      * lh3.googleusercontent.com: '=w544-h544-l90-rj' → '=w1200-h1200-l90-rj'
      * i.ytimg.com/vi/<id>/hqdefault.jpg → '/maxresdefault.jpg'
    """
    if not url:
        return url
    if "googleusercontent.com" in url or "ggpht.com" in url:
        # '=w544-h544-...': поднимаем ширину и высоту до 1200, хвост сохраняем.
        return re.sub(r"=w\d+-h\d+", "=w1200-h1200", url, count=1)
    if "i.ytimg.com" in url or "ytimg.com" in url:
        return re.sub(
            r"/(?:default|mqdefault|hqdefault|sddefault)\.jpg",
            "/maxresdefault.jpg",
            url,
            count=1,
        )
    return url


def _thumb(thumbnails: list) -> Optional[str]:
    if not thumbnails:
        return None
    # ytmusicapi отдаёт список по возрастанию размера — берём самую крупную
    # и просим у CDN версию в большем разрешении.
    return _upscale_thumb(thumbnails[-1].get("url"))


def _duration_seconds(item: dict) -> int:
    secs = item.get("duration_seconds")
    if isinstance(secs, int) and secs > 0:
        return secs
    # Фолбэк: строка "3:45".
    dur = item.get("duration") or ""
    parts = [p for p in dur.split(":") if p.strip().isdigit()]
    total = 0
    for p in parts:
        total = total * 60 + int(p)
    return total


def _metric_count(value) -> int:
    if isinstance(value, str):
        raw = value.strip().lower().replace(",", "")
        match = re.search(r"([0-9]+(?:\.[0-9]+)?)\s*([kmb])?", raw)
        if match:
            try:
                multiplier = {"k": 1_000, "m": 1_000_000, "b": 1_000_000_000}.get(
                    match.group(2), 1
                )
                return max(0, int(float(match.group(1)) * multiplier))
            except (TypeError, ValueError, OverflowError):
                return 0
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _normalize(item: dict) -> Optional[ExternalTrackResponse]:
    video_id = item.get("videoId")
    if not video_id:
        return None

    title = clean_title(item.get("title") or "Unknown")
    artists = item.get("artists") or []
    artist = ", ".join(a.get("name", "") for a in artists if a.get("name")).strip()
    if not artist:
        artist = "Unknown Artist"

    album = None
    alb = item.get("album")
    if isinstance(alb, dict):
        album = alb.get("name")

    return ExternalTrackResponse(
        id=f"ytmusic:{video_id}",
        source="ytmusic",
        external_id=video_id,
        title=title,
        artist=artist,
        album=album,
        duration=_duration_seconds(item),
        cover_url=_thumb(item.get("thumbnails")),
        stream_url="",  # заполняется ниже, где доступен Request
        download_url=None,
        download_allowed=False,
        play_count=_metric_count(item.get("views")),
        # isExplicit есть у результатов поиска ytmusicapi (1.8.2): True у
        # оригинала, False у clean-версии. Отсутствует — считаем non-explicit.
        is_explicit=bool(item.get("isExplicit")),
    )


async def search_ytmusic(
    request: Request,
    q: str,
    limit: int = 20,
) -> List[ExternalTrackResponse]:
    """Поиск по YouTube Music. Возвращает ExternalTrackResponse (source=ytmusic)."""
    if _ytmusic is None:
        return []

    base_url = str(request.base_url).rstrip("/")
    try:
        # ytmusicapi синхронный — уводим в тредпул, чтобы не блокировать loop.
        raw = await asyncio.to_thread(
            _ytmusic.search, q, filter="songs", limit=limit
        )
    except Exception:  # noqa: BLE001
        logger.exception("YouTube Music search failed")
        return []

    results: List[ExternalTrackResponse] = []
    for item in raw or []:
        track = _normalize(item)
        if not track:
            continue
        track.stream_url = f"{base_url}/api/ytdlp/stream/{track.external_id}"
        results.append(track)
        if len(results) >= limit:
            break
    return results


async def search_ytmusic_artists(q: str, limit: int = 20) -> List[str]:
    if _ytmusic is None:
        return []

    try:
        raw = await asyncio.to_thread(
            _ytmusic.search, q, filter="artists", limit=limit
        )
    except Exception:
        logger.exception("YouTube Music artist search failed")
        return []

    results: List[str] = []
    seen = set()
    for item in raw or []:
        name = (item.get("artist") or item.get("name") or "").strip()
        if name and name.lower() not in seen:
            seen.add(name.lower())
            results.append(name)
        if len(results) >= limit:
            break
    return results


async def search_ytmusic_artist_cards(q: str, limit: int = 6) -> List[dict]:
    """То же, что search_ytmusic_artists, но с аватаром: [{name, cover_url}].

    Нужно секции «Исполнители» в поиске — карточка без картинки выглядит
    сломанной, а одних имён (как отдаёт search_ytmusic_artists для подсказок в
    настройках) для неё мало.
    """
    if _ytmusic is None or not (q or "").strip():
        return []

    try:
        raw = await asyncio.to_thread(
            _ytmusic.search, q, filter="artists", limit=limit
        )
    except Exception:  # noqa: BLE001 — провайдер, выдача поиска падать не должна
        logger.warning("YouTube Music artist cards search failed for %s", q)
        return []

    out: List[dict] = []
    seen: set = set()
    for item in raw or []:
        name = (item.get("artist") or item.get("title") or item.get("name") or "").strip()
        # Ключ транслитерированный: на «Земфира» YouTube Music отдаёт и
        # кириллический канал, и латинский — это один артист, и вторая
        # карточка съела бы слот в выдаче.
        key = translit_key(name)
        if not key or key in seen:
            continue
        seen.add(key)
        out.append({"name": name, "cover_url": _thumb(item.get("thumbnails"))})
        if len(out) >= limit:
            break
    return out


async def related_ytmusic_artists(artist: str, limit: int = 6) -> List[dict]:
    """Артисты, похожие на переданного, по графу YouTube Music.

    Возвращает [{"name": ..., "browse_id": ...}]. Это единственный источник
    «похожести», не завязанный на конкретный трек: радио (get_watch_playlist)
    строится от videoId, а у пользователя, чья библиотека целиком в SoundCloud,
    ни одного ytmusic-видео может не быть вовсе.
    """
    if _ytmusic is None or not (artist or "").strip():
        return []

    try:
        found = await asyncio.to_thread(
            _ytmusic.search, artist, filter="artists", limit=1
        )
        browse_id = (found or [{}])[0].get("browseId")
        if not browse_id:
            return []
        info = await asyncio.to_thread(_ytmusic.get_artist, browse_id)
    except Exception:  # noqa: BLE001 — провайдер/разметка, волна не должна падать
        logger.warning("YouTube Music related artists failed for %s", artist)
        return []

    related = ((info or {}).get("related") or {}).get("results") or []
    out: List[dict] = []
    for item in related:
        name = (item.get("title") or "").strip()
        rel_browse_id = item.get("browseId")
        if name and rel_browse_id:
            out.append({"name": name, "browse_id": rel_browse_id})
        if len(out) >= limit:
            break
    return out


async def _artist_info(browse_id: str) -> dict:
    """Страница артиста у провайдера (get_artist); {} при любом сбое.

    Вынесено из ytmusic_artist_songs: со страницы артиста нужны и треки, и
    дискография, а round-trip к YouTube на каждую секцию — лишний.
    """
    if _ytmusic is None or not browse_id:
        return {}
    try:
        return await asyncio.to_thread(_ytmusic.get_artist, browse_id) or {}
    except Exception:  # noqa: BLE001
        logger.warning("YouTube Music artist page failed for %s", browse_id)
        return {}


async def _songs_from_info(info: dict, limit: int) -> List[ExternalTrackResponse]:
    """Треки из уже полученной страницы артиста (см. ytmusic_artist_songs)."""
    section = ((info or {}).get("songs") or {})
    items = section.get("results") or []

    playlist_id = section.get("browseId")
    if limit and playlist_id and len(items) < limit:
        # Секция ссылается на плейлист как 'VL<playlistId>', get_playlist ждёт
        # сам playlistId. Ошибку глотаем — остаётся превью, а не пустая выдача.
        pid = playlist_id[2:] if playlist_id.startswith("VL") else playlist_id
        try:
            full = await asyncio.to_thread(_ytmusic.get_playlist, pid, limit)
            items = (full or {}).get("tracks") or items
        except Exception:  # noqa: BLE001
            logger.warning("YouTube Music artist playlist failed for %s", playlist_id)

    tracks = [t for t in (_normalize(item) for item in items) if t]
    return tracks[:limit] if limit else tracks


async def ytmusic_artist_songs(
    browse_id: str, limit: int = 0
) -> List[ExternalTrackResponse]:
    """Треки артиста по его browseId (stream_url проставляет вызывающий).

    По умолчанию — превью со страницы артиста (5-10 треков, этого хватает волне).
    При limit > 0 идём в полный плейлист «Songs», на который ссылается секция:
    для поиска по имени артиста превью слишком короткое, а ждут там всю выдачу.

    Формат items совпадает с выдачей search(filter="songs"), поэтому нормализуем
    тем же _normalize.
    """
    return await _songs_from_info(await _artist_info(browse_id), limit)


def _normalize_album(
    item: dict, artist: str, fallback_type: str
) -> Optional[ExternalAlbumResponse]:
    """Элемент секции albums/singles → карточка релиза.

    fallback_type — тип релиза, когда провайдер его не прислал: в секции
    «singles» лежат синглы и EP, в «albums» — альбомы.
    """
    browse_id = item.get("browseId")
    title = (item.get("title") or "").strip()
    if not browse_id or not title:
        return None

    year = item.get("year")
    return ExternalAlbumResponse(
        id=f"ytmusic:{browse_id}",
        source="ytmusic",
        external_id=browse_id,
        title=title,
        artist=artist or None,
        year=str(year) if year else None,
        cover_url=_thumb(item.get("thumbnails")),
        album_type=item.get("type") or fallback_type,
    )


def _albums_from_info(info: dict, artist: str) -> List[ExternalAlbumResponse]:
    """Дискография со страницы артиста: сначала альбомы, затем синглы и EP.

    Это витрина со страницы артиста (у провайдера в каждой секции ~10 релизов),
    а не полная дискография: за ней пришлось бы идти ещё одним запросом, а
    карусели столько и не нужно.

    Внутри группы — от новых к старым: порядок провайдера не обещан ничем, а
    карусель читают слева направо.
    """
    out: List[ExternalAlbumResponse] = []
    seen: set = set()
    for section, fallback_type in (("albums", "Album"), ("singles", "Single")):
        group: List[ExternalAlbumResponse] = []
        for item in ((info or {}).get(section) or {}).get("results") or []:
            album = _normalize_album(item, artist, fallback_type)
            # Один и тот же релиз попадает и в «albums», и в «singles» — по
            # browseId он один, и в карусели должен быть один.
            if album is None or album.external_id in seen:
                continue
            seen.add(album.external_id)
            group.append(album)
        group.sort(key=lambda a: a.year or "", reverse=True)
        out += group
    return out


def _norm_artist_name(name: str) -> str:
    """См. artist_utils.norm_artist_name (алиас ради обратной совместимости)."""
    return norm_artist_name(name)


def _query_names_artist(q: str, artist: str) -> bool:
    """См. artist_utils.query_names_artist (алиас ради обратной совместимости)."""
    return query_names_artist(q, artist)


_ARTIST_CATALOG_TTL = 6 * 3600


async def ytmusic_artist_catalog(
    request: Request, q: str, limit: int = 20
) -> List[ExternalTrackResponse]:
    """Треки со страницы артиста — если запрос и есть имя артиста.

    search(filter="songs") ранжирует по строке запроса: на имя артиста он отдаёт
    верхушку его популярного вперемешку с чужими треками, где это имя мелькает в
    названии. Страница артиста — его собственная выдача, и именно она отвечает
    на «покажи треки такого-то», из-за чего этот источник идёт в выдаче первым.

    Если найденный артист с запросом не совпал (искали название трека, а не имя),
    возвращаем [] — иначе в выдачу протёк бы каталог случайного артиста.
    """
    if _ytmusic is None or not (q or "").strip():
        return []

    # Кэш по имени: три round-trip'а к YouTube (search → get_artist →
    # get_playlist) на каждое нажатие клавиши в поиске — заметная задержка.
    # Ключ транслитерированный: «Земфира» и «Zemfira» — один артист и один
    # каталог, греть провайдер дважды незачем.
    cache_key = f"ytmusic:artist_catalog:{translit_key(q)}:{limit}"
    cached = await get_cache_async(cache_key)
    if cached is not None:
        tracks = [ExternalTrackResponse(**t) for t in cached]
    else:
        tracks = await _fetch_artist_catalog(q, limit)
        # Негативный кэш короткий: запрос-не-имя дешевле перепроверить позже,
        # чем держать артиста вычеркнутым полдня.
        await set_cache_async(
            cache_key,
            [t.model_dump() for t in tracks],
            expire=_ARTIST_CATALOG_TTL if tracks else 600,
        )

    base_url = str(request.base_url).rstrip("/")
    for t in tracks:
        t.stream_url = f"{base_url}/api/ytdlp/stream/{t.external_id}"
    return tracks


async def _fetch_artist_catalog(q: str, limit: int) -> List[ExternalTrackResponse]:
    try:
        found = await asyncio.to_thread(_ytmusic.search, q, filter="artists", limit=1)
    except Exception:  # noqa: BLE001 — провайдер, агрегатор падать не должен
        logger.warning("YouTube Music artist lookup failed for %s", q)
        return []

    top = (found or [{}])[0] or {}
    name = (top.get("artist") or top.get("title") or "").strip()
    browse_id = top.get("browseId")
    if not browse_id or not _query_names_artist(q, name):
        return []

    return await ytmusic_artist_songs(browse_id, limit=limit)


async def ytmusic_artist_profile(request: Request, name: str, limit: int = 60) -> dict:
    """Профиль артиста для его страницы: имя, обложка, треки и дискография.

    Отличие от ytmusic_artist_catalog: кроме треков отдаёт метаданные самого
    артиста (канoническое написание имени и аватар) и его релизы — странице
    артиста нужна шапка и карусель альбомов, а не только список.

    Возвращает {"name": str, "cover_url": str|None, "tracks": [...],
    "albums": [...]}; при любом сбое провайдера — тот же словарь с пустыми
    списками, страница артиста должна открываться и на одной локальной
    библиотеке.
    """
    display = (name or "").strip()
    if _ytmusic is None or not display:
        return {"name": display, "cover_url": None, "tracks": [], "albums": []}

    # Кэш тот же по смыслу, что у каталога: search → get_artist → get_playlist
    # это три round-trip'а к YouTube на каждое открытие страницы. Ключ
    # транслитерированный — обе страницы артиста делят один профиль. Версия в
    # ключе: у записей прошлой версии нет альбомов, и без неё карусель ждала бы
    # истечения кэша.
    cache_key = f"ytmusic:artist_profile:v2:{translit_key(display)}:{limit}"
    cached = await get_cache_async(cache_key)
    if cached is not None:
        profile = {
            "name": cached.get("name") or display,
            "cover_url": cached.get("cover_url"),
            "tracks": [ExternalTrackResponse(**t) for t in cached.get("tracks") or []],
            "albums": [ExternalAlbumResponse(**a) for a in cached.get("albums") or []],
        }
    else:
        profile = await _fetch_artist_profile(display, limit)
        await set_cache_async(
            cache_key,
            {
                **profile,
                "tracks": [t.model_dump() for t in profile["tracks"]],
                "albums": [a.model_dump() for a in profile["albums"]],
            },
            # Негативный кэш короткий: артиста могли не найти из-за разовой
            # ошибки провайдера, держать его пустым полдня незачем.
            expire=_ARTIST_CATALOG_TTL if profile["tracks"] else 600,
        )

    base_url = str(request.base_url).rstrip("/")
    for t in profile["tracks"]:
        t.stream_url = f"{base_url}/api/ytdlp/stream/{t.external_id}"
    return profile


async def _fetch_artist_profile(name: str, limit: int) -> dict:
    empty = {"name": name, "cover_url": None, "tracks": [], "albums": []}
    try:
        found = await asyncio.to_thread(_ytmusic.search, name, filter="artists", limit=1)
    except Exception:  # noqa: BLE001 — провайдер, страница падать не должна
        logger.warning("YouTube Music artist lookup failed for %s", name)
        return empty

    top = (found or [{}])[0] or {}
    canonical = (top.get("artist") or top.get("title") or "").strip()
    browse_id = top.get("browseId")
    # Имя пришло из строки исполнителя трека — если YouTube нашёл кого-то
    # другого, подмешивать его дискографию нельзя: это чужие треки.
    if not browse_id or not _query_names_artist(name, canonical):
        return empty

    # Один get_artist на треки и на релизы: обе секции лежат в одном ответе.
    info = await _artist_info(browse_id)
    display = canonical or name
    return {
        "name": display,
        "cover_url": _thumb(top.get("thumbnails")),
        "tracks": await _songs_from_info(info, limit),
        "albums": _albums_from_info(info, display),
    }


async def ytmusic_album(request: Request, browse_id: str) -> Optional[ExternalAlbumDetail]:
    """Альбом по его browseId: метаданные релиза и его треки.

    None — провайдер отключён или альбома нет. Страница альбома отвечает на это
    404: пустой список треков выглядел бы как «альбом есть, но он пустой».
    """
    if _ytmusic is None or not browse_id:
        return None

    cache_key = f"ytmusic:album:v1:{browse_id}"
    cached = await get_cache_async(cache_key)
    if cached is not None:
        # Негативный ответ кэшируется пустым словарём: у ExternalAlbumDetail
        # обязательное поле album, и None в кэш не положить.
        detail = ExternalAlbumDetail(**cached) if cached else None
    else:
        detail = await _fetch_album(browse_id)
        await set_cache_async(
            cache_key,
            detail.model_dump() if detail else {},
            expire=_ARTIST_CATALOG_TTL if detail else 600,
        )

    if detail is None:
        return None

    base_url = str(request.base_url).rstrip("/")
    for t in detail.tracks:
        t.stream_url = f"{base_url}/api/ytdlp/stream/{t.external_id}"
    return detail


async def _fetch_album(browse_id: str) -> Optional[ExternalAlbumDetail]:
    try:
        info = await asyncio.to_thread(_ytmusic.get_album, browse_id)
    except Exception:  # noqa: BLE001 — провайдер, страница падать не должна
        logger.warning("YouTube Music album failed for %s", browse_id)
        return None
    if not info:
        return None

    title = (info.get("title") or "Unknown").strip()
    artists = info.get("artists") or []
    artist = ", ".join(a.get("name", "") for a in artists if a.get("name")).strip()
    cover = _thumb(info.get("thumbnails"))
    year = info.get("year")

    tracks: List[ExternalTrackResponse] = []
    for item in info.get("tracks") or []:
        track = _normalize(item)
        if track is None:
            continue
        # Внутри альбома провайдер не повторяет у трека ни обложку, ни название
        # релиза, а исполнителя иногда отдаёт пустым — подставляем данные
        # альбома, иначе в очереди окажется пустой квадрат без артиста.
        track.cover_url = track.cover_url or cover
        track.album = track.album or title
        if artist and track.artist == "Unknown Artist":
            track.artist = artist
        tracks.append(track)

    return ExternalAlbumDetail(
        album=ExternalAlbumResponse(
            id=f"ytmusic:{browse_id}",
            source="ytmusic",
            external_id=browse_id,
            title=title,
            artist=artist or None,
            year=str(year) if year else None,
            cover_url=cover,
            track_count=info.get("trackCount") or len(tracks),
            album_type=info.get("type"),
        ),
        tracks=tracks,
    )


@router.get("/search", response_model=List[ExternalTrackResponse])
async def search_endpoint(
    request: Request,
    q: str = Query(..., min_length=1),
    limit: int = Query(20, ge=1, le=50),
):
    return await search_ytmusic(request, q, limit)


def _pick_audio_format(info: dict) -> Optional[dict]:
    """Выбирает лучший аудио-only формат из info['formats'] вручную.

    Надёжнее строки 'bestaudio' — не падает с 'Requested format is not
    available', когда набор форматов у ролика нестандартный.

    Годятся ТОЛЬКО форматы с прямым http(s)-URL: стрим-прокси тянет источник
    байтовыми range-запросами (см. stream_cached_audio), а m3u8_native — это
    манифест, а не поток байт (soundcloud.py фильтрует по той же причине).
    Фильтр важен именно для фолбэк-клиентов: у web_safari аудио-дорожки
    приходят HLS-плейлистами (91-94) плюс один progressive mp4 (18) —
    проверено. Без фильтра сортировка ниже честно вернула бы манифест, прокси
    отдал бы его браузеру как .m4a/.mp4 и ещё и положил в дисковый кэш.
    """
    formats = [
        f
        for f in (info.get("formats") or [])
        if f.get("url") and f.get("protocol") in ("http", "https")
    ]
    audio_only = [
        f
        for f in formats
        if f.get("acodec") not in (None, "none")
        and f.get("vcodec") in (None, "none")
    ]
    if not audio_only:
        # Фолбэк: любой формат с аудио-дорожкой (progressive mp4 — там есть и
        # видео, но <audio> тянет из него только звук). У JS-клиентов это
        # единственное, что остаётся: их audio-only форматы SABR-only, прямых
        # ссылок у них нет.
        audio_only = [f for f in formats if f.get("acodec") not in (None, "none")]
    if not audio_only:
        return None
    # Больше abr (аудио-битрейт) → лучше; при равенстве предпочитаем m4a.
    audio_only.sort(
        key=lambda f: (f.get("abr") or 0, 1 if f.get("ext") == "m4a" else 0),
        reverse=True,
    )
    return audio_only[0]


# Наборы player-клиентов, которыми по очереди прикидываемся при резолве.
# "Video unavailable" часто зависит от клиента: то, что недоступно для одного,
# нередко отдаётся другим. Перебираем, пока не выйдет.
#
# ВАЖНО (проверено на yt-dlp 2026.7.4): единственный клиент, отдающий прямые
# audio-URL без PO-token, — android_vr. Остальные (ios/android/mweb/tv*/web*)
# на тех же роликах возвращают только mhtml-storyboard'ы: аудио у них
# SABR-only, ссылок нет. Поэтому android_vr — primary, а не «ещё один в
# списке». Раньше здесь первым стоял android_music, которого в yt-dlp УЖЕ НЕТ
# ("Skipping unsupported client android_music"): primary-слот молча пустовал,
# резолв всегда съедал _HEDGE_DELAY и веером поднимал все остальные наборы.
# Работало это лишь потому, что yt-dlp падал на свой дефолт (тот же android_vr).
#
# Наборов теперь два, а не четыре: каждый лишний набор — отдельный запрос к
# YouTube на КАЖДЫЙ промах, а именно объём запросов с одного IP и вызывает
# "Sign in to confirm you're not a bot" (см. _BOT_CHECK_MARKERS). web_safari
# оставлен фолбэком: он требует JS-рантайм (в образе есть nodejs) и JS-солвер
# challenge'ей (yt-dlp-ejs, см. requirements.txt) — с ними отдаёт progressive
# mp4 (формат 18) с прямой ссылкой, и это единственный путь резолва, когда
# android_vr получил bot-check. Без солвера этот набор мёртв: проверено на
# yt-dlp 2026.7.4 — "Signature solving failed" / "n challenge solving failed"
# и на выходе "Only images are available", т.е. 0 пригодных форматов.
#
# tv_simply из набора убран: его https-форматы ВСЕГДА требуют GVS PO Token
# ("tv_simply client https formats require a GVS PO Token which was not
# provided. They will be skipped"), которого у нас нет, — то есть он не может
# отдать аудио ни при каких условиях и лишь добавляет запрос к YouTube на
# каждый промах, ровно тогда, когда запросы надо сокращать.
_CLIENT_CANDIDATES = (
    ["android_vr"],
    ["web_safari"],
)

# JS-рантайм для расшифровки n-sig/cipher googlevideo-ссылок. По умолчанию
# yt-dlp включает только deno; в образе стоит nodejs (см. backend/Dockerfile),
# поэтому указываем его явно — иначе рантайм не находится и все JS-клиенты
# отдают 0 пригодных форматов ("No supported JavaScript runtime could be
# found ... some formats may be missing").
_JS_RUNTIMES = {"node": {}}

# Cookie-файл YouTube в Netscape-формате (экспорт из браузера с залогиненной
# сессией). Пусто — анонимный резолв, как раньше. Залогиненные куки — главный
# способ обойти "Sign in to confirm you're not a bot": этот ответ прилетает
# анонимному датацентровому трафику, а не конкретному ролику.
# Нюанс web_safari: логин-статус влияет на выбор форматов, и cookie-файл с
# активной сессией поднимает шансы получить рабочие progressive-стримы даже
# тогда, когда android_vr уже словил bot-check.
# Настроечная переменная читается один раз при импорте: смена файла требует
# перезапуска контейнера (сами куки yt-dlp перечитывает на каждый extract_info).
_YTDLP_COOKIEFILE = os.getenv("YTDLP_COOKIEFILE", "").strip()


def _ytdlp_cookie_opts() -> dict:
    """``cookiefile``-опции для YoutubeDL, если задан YTDLP_COOKIEFILE.

    Файл может исчезнуть (ротация/очистка) — тогда логируем один раз и
    возвращаем пустой dict: резолв уходит анонимно, а не падает. Флаг
    ``_cookiefile_missing_logged`` не даёт заспамить лог на каждом резолве.
    """
    global _cookiefile_missing_logged
    if not _YTDLP_COOKIEFILE:
        return {}
    if os.path.exists(_YTDLP_COOKIEFILE):
        return {"cookiefile": _YTDLP_COOKIEFILE}
    if not _cookiefile_missing_logged:
        _cookiefile_missing_logged = True
        logger.warning(
            "YTDLP_COOKIEFILE=%s не существует — резолв идёт анонимно",
            _YTDLP_COOKIEFILE,
        )
    return {}


_cookiefile_missing_logged = False


# Каждую попытку резолва ограничиваем по времени: без таймаута зависшее
# соединение с YouTube тянет extract_info очень долго (жалобы «грузится вечно»).
# Попытки хеджированы (см. _resolve_audio), а не все параллельно с самого
# начала, так что 8с — с запасом для здорового ролика, а зависший клиент не
# держит резолв так долго, как раньше при последовательном переборе.
_SOCKET_TIMEOUT = 8

# Хедж-задержка: первым стартует самый надёжный набор клиентов; остальные
# подключаются параллельно, только если он не ответил за это время. Экономит
# нагрузку на YouTube в общем случае (обычно первый клиент и так отвечает),
# но не жертвует задержкой, если он подвис. Primary теперь лёгкий одиночный
# клиент (см. _CLIENT_CANDIDATES) и обычно отвечает быстро, поэтому задержку
# можно держать короче — подвисший primary не тянет резолв дольше 0.6с до
# подключения fallback-наборов.
_HEDGE_DELAY = 0.6


class TrackUnavailable(Exception):
    """Видео недоступно (удалено/приватно/регион) — резолв невозможен."""


class TransientResolveError(Exception):
    """Временный сбой резолва (таймаут/429/сеть) — стоит повторить позже."""


class BotCheckError(TransientResolveError):
    """YouTube ответил "Sign in to confirm you're not a bot" — rate-limit по IP.

    Подтип временного сбоя: ролик цел, через некоторое время резолвится (это
    проверено — те же id, что отдавали bot-check, минутой позже вернули по 26-27
    форматов). Отдельный класс нужен ради ДЛИНЫ бэкоффа: обычный
    _TRANSIENT_TTL (25с) провоцирует быстрый повтор, а каждый лишний запрос с
    того же IP только продлевает блокировку.
    """


# Invidious-инстанс (self-hosted, с companion-сервисом для PO-token) отдаёт
# уже готовый прямой URL аудио-потока без локального n-sig/cipher-расчёта —
# резолв через него на порядок быстрее yt-dlp. Используется как основной путь
# резолва (см. _resolve_audio), yt-dlp остаётся фолбэком на случай
# недоступности/пустого ответа инстанса.
_INVIDIOUS_ENABLED = os.getenv("INVIDIOUS_ENABLED", "0") == "1"
_INVIDIOUS_API_BASES = [
    b.strip().rstrip("/") for b in os.getenv("INVIDIOUS_API_BASE", "").split(",") if b.strip()
]
_INVIDIOUS_TIMEOUT = float(os.getenv("INVIDIOUS_TIMEOUT", "10"))

# ─────────────────── Прокси для скачивания с googlevideo ───────────────────
# Ссылки googlevideo привязаны к IP того, кто их запросил: параметр `ip` входит
# в подписанный `sparams`, и запрос с другого адреса получает 403. Если
# Invidious-companion выходит в YouTube через прокси (invidious/proxy-pool —
# нужен, когда с адреса сервера не выпускается PO-token), то выданная им ссылка
# привязана к адресу ПРОКСИ, и качать её надо через тот же выход.
#
# Проксируется только скачивание аудио с googlevideo: резолв через Invidious
# идёт внутрь стека, а обложки/метаданные другим хостам платного трафика не
# стоят.
#
# Пусто (по умолчанию) — прямой выход, поведение не меняется.
_STREAM_PROXY_STATIC = os.getenv("STREAM_PROXY", "").strip()
# Файл важнее переменной: ротацию выхода пишет rotate.sh, а бэкенд перечитывает
# файл по mtime — смена прокси не требует перезапуска контейнера, который
# оборвал бы активные стримы.
_STREAM_PROXY_FILE = os.getenv("STREAM_PROXY_FILE", "").strip()
# (mtime, url) последнего прочтения файла; -1.0 — «ещё не читали».
_stream_proxy_cache: tuple[float, Optional[str]] = (-1.0, None)


def _mask_proxy(url: Optional[str]) -> str:
    """Прокси для лога без пароля: креды в URL — секрет."""
    if not url:
        return "нет (прямой выход)"
    return f"...@{url.rsplit('@', 1)[-1]}" if "@" in url else url


def stream_proxy() -> Optional[str]:
    """Прокси для запросов к googlevideo или None (прямой выход).

    Читает файл ``STREAM_PROXY_FILE`` (первая непустая строка не с ``#``) и
    перечитывает его только при смене mtime — вызывается на каждый стрим, так
    что дешёвый stat вместо открытия файла здесь принципиален. Если файла нет
    (оверлей прокси не подключён), используется статический ``STREAM_PROXY``.
    """
    global _stream_proxy_cache
    if not _STREAM_PROXY_FILE:
        return _STREAM_PROXY_STATIC or None
    try:
        mtime = os.path.getmtime(_STREAM_PROXY_FILE)
    except OSError:
        return _STREAM_PROXY_STATIC or None
    cached_mtime, cached = _stream_proxy_cache
    if mtime != cached_mtime:
        cached = None
        try:
            with open(_STREAM_PROXY_FILE, encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if line and not line.startswith("#"):
                        cached = line
                        break
        except OSError as exc:
            logger.warning("stream proxy file unreadable: %s", exc)
        _stream_proxy_cache = (mtime, cached)
        logger.info("stream proxy reloaded: %s", _mask_proxy(cached))
    return cached or _STREAM_PROXY_STATIC or None


def proxy_for_url(url: str) -> Optional[str]:
    """Прокси для скачивания ``url`` или None (прямой выход).

    Проксируем ТОЛЬКО googlevideo. stream_cached_audio общий с SoundCloud
    (soundcloud.stream_soundcloud), а у cf-media привязки к IP нет — гнать его
    аудио и обложки через платный прокси незачем. Метаданные SoundCloud — другое
    дело, они закрыты целиком и ходят через свой выход
    (soundcloud.soundcloud_proxy).
    """
    proxy = stream_proxy()
    if not proxy:
        return None
    host = (urlsplit(url).hostname or "").lower()
    return proxy if host.endswith("googlevideo.com") else None


def record_stream_proxy_traffic(url: str, amount: int) -> None:
    """Record bytes that actually crossed the paid googlevideo proxy."""
    record_proxy_traffic(proxy_for_url(url), amount)


def _stream_client(timeout: httpx.Timeout, url: str) -> httpx.AsyncClient:
    """Клиент для скачивания аудио источника.

    follow_redirects обязателен: googlevideo нередко отвечает 302 на другой
    edge-узел. Прокси — тот же выход, через который ссылка была выдана
    (см. proxy_for_url); клиент живёт весь стрим, поэтому ротация прокси
    посреди стрима не рассинхронит его с уже выданной ссылкой.
    """
    return httpx.AsyncClient(
        timeout=timeout, follow_redirects=True, proxy=proxy_for_url(url)
    )


# Один клиент с keep-alive на все резолвы: инстанс Invidious всегда один и
# тот же, так что переиспользование соединения убирает TCP/TLS-хендшейк из
# каждого резолва (и накладные расходы на создание клиента).
_invidious_client: Optional[httpx.AsyncClient] = None


def _get_invidious_client() -> httpx.AsyncClient:
    global _invidious_client
    if _invidious_client is None:
        _invidious_client = httpx.AsyncClient(timeout=_INVIDIOUS_TIMEOUT)
    return _invidious_client


async def _resolve_via_invidious(video_id: str) -> tuple[str, str, Optional[int]]:
    """Резолвит прямой URL аудио через Invidious API (/api/v1/videos/{id}).

    Пробует настроенные инстансы по очереди (первый удачный ответ побеждает).
    Любая ошибка Invidious, включая HTTP 404, считается временной: публичный
    инстанс может вернуть 404 из-за своего прокси, региона или companion, хотя
    ролик доступен на YouTube. Вызывающий код всегда проверит такой случай
    через yt-dlp.
    """
    if not _INVIDIOUS_API_BASES:
        raise TransientResolveError(video_id)

    last_exc: Optional[Exception] = None
    client = _get_invidious_client()
    for base in _INVIDIOUS_API_BASES:
        try:
            resp = await client.get(f"{base}/api/v1/videos/{video_id}")
        except httpx.HTTPError as exc:
            last_exc = exc
            continue
        if resp.status_code == 404:
            last_exc = RuntimeError(f"invidious {base} returned 404")
            continue
        if resp.is_error:
            last_exc = RuntimeError(f"invidious {base} returned {resp.status_code}")
            continue
        try:
            data = resp.json()
        except ValueError as exc:
            last_exc = exc
            continue
        if data.get("error"):
            # Инстанс жив, но явно сообщил о проблеме с видео (обычно
            # companion недоступен или PO-token не провалидировался) —
            # это сбой инстанса, а не факт недоступности ролика.
            last_exc = RuntimeError(f"invidious error: {data['error']}")
            continue
        formats = data.get("adaptiveFormats") or []
        streams = [
            f for f in formats
            if f.get("url") and str(f.get("type", "")).startswith("audio")
        ]
        if not streams:
            last_exc = RuntimeError("invidious: no audio formats")
            continue
        streams.sort(key=lambda f: int(f.get("bitrate") or 0), reverse=True)
        best = streams[0]
        mime = str(best.get("type", "")).lower()
        ext = ".m4a"
        if "webm" in mime or "opus" in mime:
            ext = ".opus" if "opus" in mime else ".webm"
        elif "mp4" in mime or "m4a" in mime or "aac" in mime:
            ext = ".m4a"
        total = best.get("clen")
        total = int(total) if isinstance(total, (int, float, str)) and str(total).isdigit() else None
        return best["url"], ext, total

    raise TransientResolveError(video_id) from last_exc


# Маркеры в тексте ошибки yt-dlp, означающие ИМЕННО недоступность ролика, а не
# временный сбой. Всё остальное (таймауты, 429, обрывы сети) считаем временным.
#
# "video unavailable" / "this video is not available" — сюда же: для нашего
# egress-IP такой ролик не отдаётся ни одним клиентом (проверено: oembed
# подтверждает, что видео существует, но playabilityStatus=UNPLAYABLE на
# android_vr/ios/web*/tv*). Ретрай это не лечит, а без маркера такой трек
# считался временным сбоем: фронт жёг MAX_TRACK_RETRIES по 503 и только потом
# показывал ошибку — вместо чистого скипа по 404.
_UNAVAILABLE_MARKERS = (
    "private video",
    "removed",
    "no longer available",
    "account associated with this video has been terminated",
    "video unavailable",
    "this video is not available",
)

# Bot-check: YouTube требует логин, потому что с этого IP пришло слишком много
# запросов. Это ВРЕМЕННОЕ состояние (проверено: те же ролики резолвятся через
# минуту), поэтому оно НЕ должно попасть в _UNAVAILABLE_MARKERS и стать 404.
# Но и коротким _TRANSIENT_TTL его лечить нельзя: быстрый ретрай только
# добавляет запросов и продлевает блокировку — нужен свой, длинный бэкофф
# (_BOT_CHECK_TTL). Осторожно с апострофом: YouTube пишет "you’re" через U+2019
# (typographic), поэтому матчим по подстроке без него.
_BOT_CHECK_MARKERS = (
    "sign in to confirm",
    "not a bot",
    "confirm your age",
)


def is_track_unavailable_error(exc: Exception) -> bool:
    """True only when yt-dlp explicitly reports that the source is unavailable."""
    msg = str(exc).lower()
    if is_bot_check_error(msg):
        # Bot-check важнее: его текст содержит "sign in", но недоступностью
        # ролика он не является.
        return False
    return any(m in msg for m in _UNAVAILABLE_MARKERS)


def is_bot_check_error(text) -> bool:
    """True, если YouTube ответил bot-check'ом (rate-limit по IP), а не отказом
    в доступе к конкретному ролику."""
    msg = (text if isinstance(text, str) else str(text)).lower()
    return any(m in msg for m in _BOT_CHECK_MARKERS)


def _needs_auth(info: dict) -> bool:
    """Age-gate / login-only ролик: yt-dlp вернул метаданные, но форматов нет,
    т.к. YouTube требует авторизацию (availability=needs_auth, age_limit>=18).
    Без cookies это перманентно — ретрай бесполезен, поэтому такой трек надо
    отдавать как недоступный (404), а не временный (503, с бесконечным ретраем
    на фронте). Invidious на такие ролики отвечает 500 «inappropriate…»."""
    if info.get("availability") == "needs_auth":
        return True
    try:
        age = int(info.get("age_limit") or 0)
    except (TypeError, ValueError):
        age = 0
    return age >= 18 and not (info.get("formats") or [])


# Создание YoutubeDL — это не только выделение объекта: конструктор грузит
# реестр экстракторов и плагинов, и это ощутимая накладная трата на каждый
# резолв. asyncio.to_thread гоняет задачи через пул потоков-воркеров, которые
# переживают между вызовами, так что кэшируем инстанс per-thread по ключу
# опций. Используется и SoundCloud-роутером (см. soundcloud._resolve_blocking).
_thread_local = threading.local()


def cached_ydl(cache_key, opts: dict):
    """YoutubeDL с переиспользованием инстанса в рамках текущего потока.

    ``cache_key`` — hashable-ключ (например, tuple клиентов или строка) для
    различения наборов опций внутри одного потока.
    """
    import yt_dlp

    cache = getattr(_thread_local, "ydl_cache", None)
    if cache is None:
        cache = {}
        _thread_local.ydl_cache = cache
    ydl = cache.get(cache_key)
    if ydl is None:
        ydl = yt_dlp.YoutubeDL(opts)
        cache[cache_key] = ydl
    return ydl


def _warmup_ydl_blocking() -> None:
    """Прогревает yt-dlp для primary-набора клиентов.

    Основная цена здесь — process-wide: импорт модуля ``yt_dlp`` и загрузка
    реестра экстракторов/плагинов (~0.5-0.7с суммарно), это происходит один
    раз на процесс независимо от потока. Без прогрева эту цену при cold-start
    платит самый первый резолв, что ощущается как «первый трек всегда долго
    грузится». cached_ydl дополнительно кладёт готовый YoutubeDL-инстанс в
    per-thread кэш текущего потока — это уже локальный бонус, если тот же
    поток threadpool-воркера подхватит следующий запрос.
    Вызывается один раз при старте приложения (см. app.main), в отдельном
    потоке, чтобы не блокировать остальной startup.
    """
    try:
        primary = _CLIENT_CANDIDATES[0]
        cached_ydl(
            tuple(primary),
            {
                "quiet": True,
                "no_warnings": True,
                "noplaylist": True,
                "skip_download": True,
                "socket_timeout": _SOCKET_TIMEOUT,
                "format": "bestaudio/best",
                "ignore_no_formats_error": True,
                "js_runtimes": _JS_RUNTIMES,
                "extractor_args": {"youtube": {"player_client": primary}},
                **_ytdlp_cookie_opts(),
            },
        )
        logger.info("yt-dlp extractor warmed up")
    except Exception:  # noqa: BLE001 — прогрев best-effort, не должен ронять старт
        logger.warning("yt-dlp warmup failed", exc_info=True)


class _CapturingLogger:
    """Собирает warning/error yt-dlp, не печатая их в stdout.

    Причина отказа (``Video unavailable``, ``Sign in to confirm you're not a
    bot``) в info-словаре НЕ лежит: при ``ignore_no_formats_error`` yt-dlp
    возвращает info с ``availability='public'``, ``age_limit=0`` и пустым
    ``formats``, а текст уходит только в логгер. Без него bot-check (временный,
    лечится бэкоффом) и гео-блок (перманентный, надо скипнуть) выглядят
    одинаково и оба уезжают в transient.
    """

    def __init__(self) -> None:
        self.messages: List[str] = []

    def reset(self) -> None:
        self.messages.clear()

    @property
    def text(self) -> str:
        return " | ".join(self.messages)

    def debug(self, msg):  # noqa: D102 — интерфейс yt-dlp
        pass

    def info(self, msg):  # noqa: D102
        pass

    def warning(self, msg):  # noqa: D102
        self.messages.append(str(msg))

    def error(self, msg):  # noqa: D102
        self.messages.append(str(msg))


def _extract_with_clients(
    video_id: str, clients: List[str]
) -> tuple[Optional[dict], bool, bool]:
    """Одна попытка резолва набором клиентов.

    Возвращает ``(info, transient, bot_check)``: ``info`` — результат или None;
    ``transient`` True, если неудача выглядит временной (таймаут/сеть/429), а не
    «видео недоступно»; ``bot_check`` True, если YouTube ответил
    "Sign in to confirm you're not a bot" (rate-limit по IP — временно, но
    требует ДЛИННОГО бэкоффа, а не быстрого ретрая). Классификация нужна, чтобы
    не помечать валидный трек надолго недоступным из-за случайного сбоя и,
    наоборот, не жечь ретраи на перманентно заблокированном.
    """
    import yt_dlp

    url = f"https://music.youtube.com/watch?v={video_id}"
    ydl = cached_ydl(
        tuple(clients),
        {
            "quiet": True,
            # Нужны тексты предупреждений: причина отказа приходит именно
            # warning'ом (см. _CapturingLogger). В stdout они не попадают —
            # их забирает наш логгер.
            "no_warnings": False,
            "logger": _CapturingLogger(),
            "noplaylist": True,
            "skip_download": True,
            "socket_timeout": _SOCKET_TIMEOUT,
            # Без этого yt-dlp применяет дефолтный селектор
            # 'bestvideo*+bestaudio/best' и падает с "Requested format is not
            # available" на роликах без муксированного progressive-формата —
            # ДО того, как _pick_audio_format успевает выбрать формат вручную.
            # 'bestaudio/best' всегда матчится (audio-only поток есть почти
            # всегда), а конкретный URL всё равно выбирает _pick_audio_format
            # из info['formats'].
            "format": "bestaudio/best",
            # Подстраховка к предыдущему: на некоторых клиентах (PO-token и
            # т.п.) даже 'bestaudio/best' не матчится, и extract_info кидает
            # "Requested format is not available", хотя другой клиент отдал бы
            # формат. С этим флагом yt-dlp не кидает ошибку селектора вовсе —
            # возвращает info как есть, а непригодность форматов решает
            # _pick_audio_format (нет — просто пробуем следующий клиент).
            "ignore_no_formats_error": True,
            "js_runtimes": _JS_RUNTIMES,
            "extractor_args": {"youtube": {"player_client": clients}},
            **_ytdlp_cookie_opts(),
        },
    )
    # Инстанс переиспользуется в рамках потока (cached_ydl), поэтому чистим
    # накопленное от прошлого резолва. Внутри одного потока вызовы строго
    # последовательные, так что перемешаться сообщения не могут.
    cap = ydl.params.get("logger")
    if isinstance(cap, _CapturingLogger):
        cap.reset()
    try:
        info = ydl.extract_info(url, download=False)
    except yt_dlp.utils.DownloadError as exc:
        bot = is_bot_check_error(exc)
        transient = bot or not is_track_unavailable_error(exc)
        logger.info(
            "resolve via %s failed for %s (%s): %s",
            clients, video_id, _reason_label(transient, bot), exc,
        )
        return None, transient, bot

    if _pick_audio_format(info or {}):
        return info, False, False

    # Форматов нет, но исключения не было (ignore_no_formats_error). Причину
    # знает только логгер — по ней и решаем: bot-check лечится бэкоффом,
    # "video unavailable" — перманентен и должен дать чистый 404.
    reason = cap.text if isinstance(cap, _CapturingLogger) else ""
    bot = is_bot_check_error(reason)
    if bot:
        transient = True
    elif reason and is_track_unavailable_error(Exception(reason)):
        transient = False
    else:
        transient = True
    logger.info(
        "resolve via %s got no audio format for %s (%s): %s",
        clients, video_id, _reason_label(transient, bot), reason or "no reason logged",
    )
    return info, transient, bot


def _reason_label(transient: bool, bot: bool) -> str:
    if bot:
        return "bot-check"
    return "transient" if transient else "unavailable"


async def _resolve_audio(video_id: str) -> tuple[str, str, Optional[int]]:
    """Резолвит прямой URL через быстрый Invidious с hedged fallback yt-dlp.

    Invidious обычно отвечает быстрее, поэтому получает короткую фору. Если
    он зависает, yt-dlp стартует параллельно, а не после его 10-секундного
    таймаута. Это сокращает паузу между появлением карточки трека и первыми
    байтами аудио при проблемном Invidious.

    Пока держится глобальный бэкофф по bot-check'у (см. _BOT_CHECK_GLOBAL_KEY),
    yt-dlp не запускается вовсе: YouTube всё равно ответит тем же bot-check'ом,
    а каждый такой запрос продлевает блокировку. Остаётся Invidious.
    """
    blocked = bot_check_active()

    if not _INVIDIOUS_ENABLED:
        if blocked:
            # Обходного пути нет — не ходим к YouTube до истечения бэкоффа.
            raise BotCheckError(video_id)
        return await _resolve_via_ytdlp(video_id)

    if blocked:
        try:
            return await _resolve_via_invidious(video_id)
        except TrackUnavailable:
            raise
        except Exception as exc:  # noqa: BLE001 — Invidious тоже не смог
            # Именно BotCheckError, а не transient: 25-секундный TTL вернул бы
            # быстрые повторы, которые здесь как раз и вредны.
            logger.info(
                "bot-check backoff active, invidious-only resolve failed for %s: %s",
                video_id, exc,
            )
            raise BotCheckError(video_id) from exc

    invidious_task = asyncio.create_task(_resolve_via_invidious(video_id))
    try:
        try:
            return await asyncio.wait_for(asyncio.shield(invidious_task), timeout=_HEDGE_DELAY)
        except asyncio.TimeoutError:
            pass
        except Exception as exc:  # noqa: BLE001 — сразу пробуем yt-dlp
            logger.info("invidious resolve failed for %s: %s", video_id, exc)

        ytdlp_task = asyncio.create_task(_resolve_via_ytdlp(video_id))
        pending = {invidious_task, ytdlp_task}
        failures: list[Exception] = []
        while pending:
            done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                try:
                    return task.result()
                except Exception as exc:  # noqa: BLE001 — второй источник ещё может сработать
                    failures.append(exc)
                    logger.info("audio resolver failed for %s: %s", video_id, exc)
        # yt-dlp — авторитетный источник: если ОН сказал «недоступно» (age-gate/
        # удалено/приватно), не понижаем это до transient (иначе фронт уйдёт в
        # бесконечный ретрай по 503). Invidious же всегда кидает transient, так
        # что его сбой сюда не попадёт как TrackUnavailable.
        if any(isinstance(f, TrackUnavailable) for f in failures):
            raise TrackUnavailable(video_id) from failures[-1]
        # Bot-check сохраняем как есть: иначе он превратился бы в обычный
        # transient с 25-секундным TTL, и быстрые повторы продлевали бы
        # блокировку вместо длинного бэкоффа (_BOT_CHECK_TTL).
        if any(isinstance(f, BotCheckError) for f in failures):
            raise BotCheckError(video_id) from failures[-1]
        raise TransientResolveError(video_id) from (failures[-1] if failures else None)
    finally:
        if not invidious_task.done():
            invidious_task.cancel()


async def _resolve_via_ytdlp(video_id: str) -> tuple[str, str, Optional[int]]:
    """Через yt-dlp достаёт прямой URL аудио, расширение и размер.

    Хеджирование вместо постоянного запуска всех наборов клиентов разом:
    сперва пробуем только первый (самый надёжный по опыту) набор; если он не
    ответил за _HEDGE_DELAY секунд, параллельно подключаем остальные. Типичный
    случай (первый клиент и так отвечает) не создаёт лишней нагрузки на
    YouTube, а подвисший/медленный клиент не блокирует резолв дольше
    хедж-задержки — итоговая задержка ограничена сверху примерно
    _HEDGE_DELAY + _SOCKET_TIMEOUT, а не суммой по всем клиентам.
    Кидает TrackUnavailable, если все клиенты сообщили о недоступности, или
    TransientResolveError при временном сбое (его негативно кэшируем
    ненадолго, чтобы дать треку восстановиться).
    """
    primary, *rest = _CLIENT_CANDIDATES
    pending = {asyncio.create_task(asyncio.to_thread(_extract_with_clients, video_id, primary))}
    hedged = False
    info = None
    saw_transient = False
    saw_needs_auth = False
    saw_bot_check = False
    # Хоть один клиент НАЗВАЛ причину недоступности («Video unavailable» и
    # прочие _UNAVAILABLE_MARKERS). Отдельно от saw_transient: у сбойного
    # клиента transient=True, и без этого флага его сбой затирал бы
    # подтверждённый ответ YouTube, превращая мёртвый ролик в вечный 503.
    saw_unavailable = False
    try:
        while pending:
            done, pending = await asyncio.wait(
                pending,
                timeout=None if hedged else _HEDGE_DELAY,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if not done:
                # Хедж: первый набор не успел за _HEDGE_DELAY — подключаем остальных.
                hedged = True
                pending |= {
                    asyncio.create_task(asyncio.to_thread(_extract_with_clients, video_id, clients))
                    for clients in rest
                }
                continue
            success = False
            for t in done:
                result_info, transient, bot_check = t.result()
                if bot_check:
                    saw_bot_check = True
                if result_info and _pick_audio_format(result_info):
                    info = result_info
                    success = True
                    break
                if result_info:
                    # Age-gate/login-only ролик — форматов не будет ни у одного
                    # клиента (проверено). Это перманентно, ретрай бесполезен.
                    if _needs_auth(result_info):
                        saw_needs_auth = True
                    # Иначе доверяем классификации _extract_with_clients: она
                    # читает причину из логгера yt-dlp и уже отличила bot-check
                    # (временный) от "video unavailable" (перманентный). Раньше
                    # здесь стоял безусловный transient=True, из-за которого
                    # гео-блок навсегда выглядел временным сбоем и фронт жёг на
                    # нём ретраи вместо чистого скипа.
                if not transient and not bot_check:
                    # transient=False означает, что классификатор увидел в
                    # причине явный маркер недоступности — это ответ YouTube о
                    # самом ролике, а не наш сбой.
                    saw_unavailable = True
                saw_transient = saw_transient or transient
            if success:
                break
            if not hedged:
                # Primary набор отработал (не подвис), но не дал результата —
                # без этого фолбэки не подключились бы вовсе, т.к. эскалация
                # выше срабатывает только по таймауту ожидания, а не по
                # быстрому провалу (например, "Requested format is not
                # available" из-за PO-token требований на некоторых клиентах).
                hedged = True
                pending |= {
                    asyncio.create_task(asyncio.to_thread(_extract_with_clients, video_id, clients))
                    for clients in rest
                }
    finally:
        for t in pending:
            if not t.done():
                t.cancel()

    if info is None or not _pick_audio_format(info):
        # Bot-check важнее всего: это rate-limit по IP, а не свойство ролика.
        # Отдаём transient (→503), но вызывающий код закэширует его на
        # _BOT_CHECK_TTL, а не на _TRANSIENT_TTL: быстрый ретрай только
        # добавляет запросов и продлевает блокировку.
        if saw_bot_check:
            # Маркер ставим здесь, а не в _resolve_and_cache: сюда приходят и
            # вызовы в обход кэша резолва (force=True из архивации), а бэкофф
            # нужен всем путям сразу.
            _note_bot_check()
            raise BotCheckError(video_id)
        # Age-gate важнее «временного»: если хоть один клиент показал needs_auth,
        # это перманентная недоступность (→404, чистый скип), а не 503 с ретраем.
        if saw_needs_auth:
            raise TrackUnavailable(video_id)
        # Подтверждённый маркер важнее чужого сбоя: если один клиент назвал
        # ролик недоступным, а другой просто не смог ответить (transient),
        # это всё равно 404 — иначе мёртвый ролик висел бы в вечном 503.
        if saw_unavailable:
            raise TrackUnavailable(video_id)
        if saw_transient:
            raise TransientResolveError(video_id)
        # Ни один клиент не дал форматов, но и НИ ОДИН не назвал причину
        # («Video unavailable» и прочие _UNAVAILABLE_MARKERS в логгере).
        # Раньше здесь стоял TrackUnavailable — и это давало ложные 404:
        # проверено, что генуинно мёртвый ролик (удалённый, несуществующий,
        # приватный) ВСЕГДА приходит с маркером, т.е. уходит ветками выше.
        # Пустая же причина — признак сбоя на нашей стороне (PO-token, смена
        # плеера, JS-рантайм, обрыв), и помечать по ней трек мёртвым нельзя:
        # те же ролики резолвятся через минуту. Отдаём transient → 503 с
        # ретраем вместо 404 с необратимым скипом.
        logger.warning(
            "no audio format and no reason reported for %s — treating as transient",
            video_id,
        )
        raise TransientResolveError(video_id)

    fmt = _pick_audio_format(info)
    ext = "." + (fmt.get("ext") or "m4a").lower()
    # Только ТОЧНЫЙ filesize годится для Content-Length; filesize_approx может
    # расходиться с реальным размером и ломает ответ ("content shorter than
    # Content-Length"). Если точного нет — вернём None и определим размер
    # пробным range-запросом к googlevideo (там размер точный).
    size = fmt.get("filesize")
    total = int(size) if isinstance(size, (int, float)) and size > 0 else None
    return fmt["url"], ext, total


# googlevideo-ссылки живут несколько часов; кэшируем результат резолва в Redis,
# чтобы не гонять медленный yt-dlp при перемотке, повторе и ретраях. TTL с
# запасом меньше реального срока жизни ссылки.
_RESOLVE_TTL = 3 * 3600
# Негативный кэш ГЕНУИННО недоступных видео (удалено/приватно): не гоняем
# yt-dlp на каждый ретрай браузера. Короткий TTL — вдруг видео вернётся.
_UNAVAILABLE_TTL = 600
# Негативный кэш ВРЕМЕННЫХ сбоев (таймаут/429/сеть): короткий, чтобы, с одной
# стороны, не долбить YouTube на каждый ретрай, а с другой — быстро дать
# валидному треку восстановиться (иначе он «не играет» до 10 минут).
_TRANSIENT_TTL = 25
# Негативный кэш bot-check'а: сильно длиннее обычного transient. Блокировка
# снимается временем И тишиной, поэтому быстрый ретрай тут вреден — он
# продлевает бан. 3 минуты: достаточно, чтобы поток запросов утих, и не так
# долго, чтобы трек «умер» на весь сеанс.
_BOT_CHECK_TTL = 180

# Bot-check прилетает не на конкретный ролик, а на НАШ egress-IP. Негативная
# запись по video_id это не покрывает: в очереди (и особенно в волне-потоке)
# каждый следующий трек — новый ключ, он честно шёл в yt-dlp, получал тот же
# bot-check и добавлял запросов ровно тогда, когда их надо прекратить. Снаружи
# это и выглядело как «блокировка не проходит, ошибка на каждом треке».
# Глобальный бэкофф держит паузу сразу на все ролики: пока он жив, yt-dlp к
# YouTube не ходит вовсе, а резолв идёт только через Invidious — у него свой
# companion/PO-token и свой поток запросов, блокировка нашего yt-dlp его не
# касается.
#
# Маркер живёт В ПАМЯТИ процесса, а не в Redis: чтение из Redis стоило бы
# лишний round-trip на КАЖДОМ резолве, а польза нужна лишь в редкие минуты
# блокировки. Цена — каждый gunicorn-воркер узнаёт о блокировке сам (до
# GUNICORN_WORKERS «пробных» запросов вместо одного), но это на порядок меньше,
# чем запрос на каждый трек, а межпроцессную часть добирает общая для воркеров
# негативная запись по video_id в Redis.
_bot_check_until = 0.0


def _note_bot_check() -> None:
    """Открывает глобальный бэкофф: YouTube ограничил наш IP."""
    global _bot_check_until
    _bot_check_until = time.monotonic() + _BOT_CHECK_TTL


def bot_check_active() -> bool:
    """True, пока держится глобальный бэкофф по bot-check'у YouTube."""
    return time.monotonic() < _bot_check_until


# Однополётность резолва: с прогревом (prefetch текущего/следующих треков во
# flow) стало обычным делом, что несколько вызовов (прогрев + сам <audio>-GET,
# либо несколько прогревов подряд) метят в один и тот же трек почти
# одновременно. Без дедупликации это означало бы несколько параллельных
# yt-dlp extract_info на один и тот же трек — лишняя нагрузка на источник и
# трата воркеров. Держим по одной in-flight задаче на ключ: все опоздавшие
# вызовы просто дожидаются результата первой. Ключи неймспейсим по источнику
# ("ytmusic:...", "soundcloud:..."), словарь общий для всех yt-dlp-провайдеров.
_inflight_resolves: dict[str, asyncio.Task] = {}


async def single_flight_resolve(key: str, factory):
    """Выполняет ``factory()`` с дедупликацией параллельных вызовов по ключу.

    Если резолв с тем же ключом уже идёт — не запускает второй, а дожидается
    результата первого (исключение первого получат все ожидающие). Отмена
    ожидающего не отменяет саму задачу — остальные ожидающие не страдают.
    """
    existing = _inflight_resolves.get(key)
    if existing is not None:
        return await existing
    task = asyncio.ensure_future(factory())
    _inflight_resolves[key] = task
    try:
        return await task
    finally:
        if _inflight_resolves.get(key) is task:
            del _inflight_resolves[key]


async def _resolve_cached(
    video_id: str, force: bool = False
) -> tuple[str, str, Optional[int], bool]:
    """Резолв прямого URL с кэшем в Redis.

    force=True — игнорирует кэш и резолвит заново (протухшая ссылка).
    Кидает TrackUnavailable при ГЕНУИННОЙ недоступности видео (удалено/
    приватно/регион) и TransientResolveError при временном сбое (таймаут/
    сеть/429). Раньше оба случая наружу выглядели одинаково («недоступен»),
    и клиент не мог отличить «трек мёртв» от «сервер не успел» — это било по
    UX (см. stream_cached_audio: TransientResolveError теперь отдаётся как
    503 Retry-After, а не 404, и фронт не должен скипать трек на 503).
    Четвёртый элемент — ``fresh``: True, если URL только что получен от
    yt-dlp (валиден заведомо), False — если отдан из Redis-кэша (в теории
    мог протухнуть). Позволяет вызывающему коду пропустить лишний probe-запрос
    для заведомо свежей ссылки и не терять на нём время при холодном старте.
    """
    key = f"ytdlp:resolve:v2:{video_id}"
    cached = None if force else await get_cache_async(key)
    if cached:
        if cached.get("bot_check"):
            # Держим бэкофф: пока запись жива, к YouTube не ходим вовсе.
            raise BotCheckError(video_id)
        if cached.get("transient"):
            raise TransientResolveError(video_id)
        if cached.get("unavailable"):
            # Старые версии записывали сюда любой сбой резолва, включая ложные
            # 404 от Invidious. Не доверяем такой записи и резолвим заново.
            logger.info("ignoring legacy unavailable cache entry for %s", video_id)
        if cached.get("url"):
            return cached["url"], cached.get("ext", ".m4a"), cached.get("total"), False

    # Однополётность: если резолв этого video_id уже идёт (например, прогрев
    # прогремел на долю секунды раньше настоящего запроса на стрим) — просто
    # дожидаемся его вместо запуска второго extract_info.
    return await single_flight_resolve(
        f"ytmusic:{video_id}", lambda: _resolve_and_cache(video_id, key)
    )


async def _resolve_and_cache(
    video_id: str, key: str
) -> tuple[str, str, Optional[int], bool]:
    try:
        url, ext, total = await _resolve_audio(video_id)
    except BotCheckError:
        # Bot-check — длинный бэкофф (см. _BOT_CHECK_TTL). Проверяется РАНЬШЕ
        # TransientResolveError, т.к. является его подклассом.
        logger.warning(
            "youtube bot-check for %s — backing off %ds", video_id, _BOT_CHECK_TTL
        )
        await set_cache_async(
            key, {"transient": True, "bot_check": True}, expire=_BOT_CHECK_TTL
        )
        raise
    except TransientResolveError:
        # Временный сбой — короткий негативный кэш отдельным маркером, чтобы
        # скорый повтор от того же клиента не долбил yt-dlp, но чтобы вызывающий
        # код (и в итоге HTTP-статус) не путал это с «трек реально недоступен».
        await set_cache_async(key, {"transient": True}, expire=_TRANSIENT_TTL)
        raise
    except TrackUnavailable:
        # Не кэшируем 404: даже явный ответ YouTube может зависеть от IP,
        # авторизации и выбранного player client. Следующий запуск сможет
        # повторить резолв с другим контекстом, а не 10 минут показывать ошибку.
        raise
    except Exception as exc:  # noqa: BLE001 — не маскируем сбои под 404
        # Непредвиденная ошибка резолва (сеть, yt-dlp, формат) не доказывает,
        # что ролик удалён. Короткий transient-кэш сохраняет сервис от шквала
        # повторов, а warning со стеком даёт диагностировать первопричину.
        logger.warning("audio resolve failed for %s", video_id, exc_info=True)
        await set_cache_async(key, {"transient": True}, expire=_TRANSIENT_TTL)
        raise TransientResolveError(video_id) from exc

    await set_cache_async(key, {"url": url, "ext": ext, "total": total}, expire=_RESOLVE_TTL)
    return url, ext, total, True


# Размер сегмента при проксировании googlevideo. Длинный одиночный GET
# googlevideo часто троттлит и обрывает (RemoteProtocolError), поэтому тянем
# файл короткими range-запросами — каждый успевает завершиться целиком.
_SEGMENT = 1 << 20  # 1 MiB
_SEGMENT_RETRIES = 3
# Буфер чтения при отдаче кэш-файла с диска. Крупнее 64 KiB — меньше переходов
# в threadpool на каждый чанк при множестве одновременных стримов.
_FILE_CHUNK = 256 * 1024

# Дисковый кэш проигранных треков: раз скачав аудио с googlevideo, храним его
# локально и при повторном прослушивании отдаём с диска — без обращения к
# YouTube и повторного скачивания.
CACHE_DIR = os.getenv(
    "YTDLP_CACHE_DIR",
    os.path.join(os.path.dirname(__file__), "..", "..", "ytdlp_cache"),
)
CACHE_MAX_BYTES = int(os.getenv("YTDLP_CACHE_MAX_MB", "4096")) * 1024 * 1024
os.makedirs(CACHE_DIR, exist_ok=True)


def _cached_file(video_id: str) -> Optional[str]:
    """Путь к готовому кэш-файлу трека (любое расширение) или None."""
    for path in glob.glob(os.path.join(CACHE_DIR, f"{video_id}.*")):
        if (
            not path.endswith(".part")
            and not path.endswith(".warm")
            and os.path.getsize(path) > 0
        ):
            return path
    return None


def _warm_file(cache_id: str, ext: str) -> str:
    """Путь к warm-файлу (первые байты трека, скачанные при префетче)."""
    return os.path.join(CACHE_DIR, f"{cache_id}{ext}.warm")


# Сколько первых байт трека скачиваем при префетче. 2 MiB — хватает на
# ~1 минуту звука при 256kbps: старт воспроизведения идёт целиком с диска,
# пока живой proxy догоняет хвост.
_WARM_BYTES = 2 * 1024 * 1024

# Ограничитель конкуренции резолва ТОЛЬКО для фоновых прогревов: фронт может
# прогреть сразу несколько треков очереди, и без лимита это означало бы залп
# параллельных yt-dlp extract_info в сторону YouTube (риск 429). Реальные
# /stream-запросы семафор не проходят — воспроизведение не троттлится.
# С Invidious как основным резолвером (лёгкий локальный HTTP-запрос) прогрев
# заметно дешевле, чем во времена чистого yt-dlp, — параллелизм чуть выше,
# чтобы расширенное окно префетча (поиск/плейлисты) прогревалось быстрее.
_PREFETCH_SEM = asyncio.Semaphore(3)
# Скачивание первых байт — просто GET к CDN, узкое место не оно: параллелизм
# можно держать заметно выше, чем у yt-dlp-резолвов.
_WARM_SEM = asyncio.Semaphore(8)

# Фоновая очередь прогрева: эндпоинт /prefetch отвечает сразу, работа идёт в
# asyncio-задаче. Прогрев — best-effort, поэтому при переполнении очереди
# новые заявки молча отбрасываются (играть трек это не мешает, а «протухший»
# прогрев, доехавший через минуты, всё равно бесполезен). _prefetch_pending
# заодно дедуплицирует заявки на один и тот же трек. Сильные ссылки на задачи
# держим в _prefetch_tasks, иначе asyncio может собрать их до завершения.
_PREFETCH_QUEUE_LIMIT = 64
_prefetch_pending: set[str] = set()
_prefetch_tasks: set[asyncio.Task] = set()


async def _prefetch_job(
    cache_id: str, resolver, cache_key: str, ttl: int, archive_key: Optional[str] = None
) -> None:
    try:
        # Архивная копия в MinIO уже даёт мгновенный старт — резолв провайдера
        # и скачивание первых байт для такого трека были бы чистой тратой
        # (и лишним походом к YouTube).
        if await archived_music_path(archive_key):
            return
        async with _PREFETCH_SEM:
            url, ext, total, _ = await resolver(False)
        async with _WARM_SEM:
            warmed_total = await _warm_first_chunk(cache_id, url, ext)
        if warmed_total is not None and total is None:
            # Content-Range warm-запроса дал точный размер — дописываем его в
            # кэш резолва, чтобы стрим мог пропустить probe (см. движок).
            await set_cache_async(
                cache_key, {"url": url, "ext": ext, "total": warmed_total}, expire=ttl
            )
    except (TrackUnavailable, TransientResolveError):
        pass  # негативный результат уже закэширован резолвером
    except Exception:  # noqa: BLE001 — прогрев не должен шуметь стектрейсами
        logger.warning("prefetch job failed for %s", cache_id, exc_info=True)
    finally:
        _prefetch_pending.discard(cache_id)


def schedule_prefetch(
    cache_id: str, resolver, cache_key: str, ttl: int, archive_key: Optional[str] = None
) -> str:
    """Ставит прогрев трека в фоновую очередь; возвращает статус для ответа.

    Не ждёт ни резолва, ни скачивания — вызывающий эндпоинт отвечает мгновенно
    и не держит HTTP-соединение открытым, пока очередь прогрева занята.
    """
    if _cached_file(cache_id):
        return "cached"
    if cache_id in _prefetch_pending:
        return "queued"
    if len(_prefetch_pending) >= _PREFETCH_QUEUE_LIMIT:
        return "dropped"
    _prefetch_pending.add(cache_id)
    task = asyncio.create_task(
        _prefetch_job(cache_id, resolver, cache_key, ttl, archive_key)
    )
    _prefetch_tasks.add(task)
    task.add_done_callback(_prefetch_tasks.discard)
    return "queued"


async def prefetch_is_ready(
    cache_id: str, cache_key: str, archive_key: Optional[str] = None
) -> bool:
    """Готов ли трек к почти мгновенному старту воспроизведения.

    В отличие от schedule_prefetch (fire-and-forget: ставит задачу и сразу
    отвечает «queued»), это ПРОВЕРКА фактического результата прогрева, без
    запуска какой-либо работы. Готово, если резолв прямого URL уже лежит в
    Redis (валидная запись, а не transient-маркер), ИЛИ трек уже полностью
    скачан в дисковый кэш, ИЛИ есть архивная копия в MinIO (стрим отдаёт её
    напрямую, см. stream_cached_audio). Фронт поллит это после /prefetch и
    снимает гейт скипа вперёд только когда здесь True.
    """
    if _cached_file(cache_id):
        return True
    cached = await get_cache_async(cache_key)
    if cached and cached.get("url"):
        return True
    return bool(await archived_music_path(archive_key))


async def _warm_first_chunk(cache_id: str, url: str, ext: str) -> Optional[int]:
    """Скачивает первые _WARM_BYTES трека в кэш-файл ``{cache_id}{ext}.warm``.

    Вызывается из префетча best-effort: тогда первый play отдаёт начало трека
    мгновенно с диска (и без валидирующего probe — URL проверен здесь), а
    живой proxy подхватывает с позиции warm-файла. Возвращает полный размер
    файла из Content-Range (авторитетный, годится для Content-Length) или
    None, если прогрев не удался/не нужен.
    """
    warm_path = _warm_file(cache_id, ext)
    if os.path.exists(warm_path) or _cached_file(cache_id):
        return None
    total: Optional[int] = None
    fd, tmp_path = tempfile.mkstemp(dir=CACHE_DIR, suffix=".part")
    ok = False
    try:
        # Клиент общий с основным стримом (_stream_client): и redirect'ы
        # googlevideo, и прокси выданной ссылки нужны здесь ровно так же —
        # прогретый с прямого выхода кусок был бы 403 при проксированной ссылке.
        async with _stream_client(httpx.Timeout(15.0, read=30.0), url) as client:
            async with client.stream(
                "GET", url, headers={"Range": f"bytes=0-{_WARM_BYTES - 1}"}
            ) as resp:
                # Только 206: сервер, игнорирующий Range (200), отдал бы весь
                # файл — не хотим качать его целиком на префетче.
                if resp.status_code != 206:
                    logger.info(
                        "first-chunk warm skipped for %s: upstream %s",
                        cache_id, resp.status_code,
                    )
                    return None
                cr = resp.headers.get("content-range")
                if cr and "/" in cr:
                    tail = cr.rsplit("/", 1)[-1].strip()
                    if tail.isdigit():
                        total = int(tail)
                with os.fdopen(fd, "wb") as fh:
                    fd = None
                    async for chunk in resp.aiter_bytes(65536):
                        record_stream_proxy_traffic(url, len(chunk))
                        fh.write(chunk)
        os.replace(tmp_path, warm_path)
        ok = True
        _enforce_cache_limit()
        return total
    except (httpx.HTTPError, OSError) as exc:
        logger.info("first-chunk warm failed for %s: %s", cache_id, exc)
        return None
    finally:
        if fd is not None:
            os.close(fd)
        if not ok and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


def _enforce_cache_limit() -> None:
    """Простейший LRU по mtime: чистим самые старые файлы при переполнении."""
    try:
        files = [
            (p, os.path.getsize(p), os.path.getmtime(p))
            for p in glob.glob(os.path.join(CACHE_DIR, "*"))
            if not p.endswith(".part")
        ]
    except OSError:
        return
    total = sum(size for _, size, _ in files)
    if total <= CACHE_MAX_BYTES:
        return
    for path, size, _ in sorted(files, key=lambda f: f[2]):  # старые первыми
        try:
            os.remove(path)
        except OSError:
            continue
        total -= size
        if total <= CACHE_MAX_BYTES:
            break


async def _serve_file(path: str, media_type: str, request: Request) -> StreamingResponse:
    """Отдаёт локальный файл с поддержкой Range (перемотка/докачка)."""
    size = os.path.getsize(path)
    has_range = bool(request.headers.get("range"))
    start, end = _parse_range(request.headers.get("range"), size)
    if end is None:
        end = size - 1
    end = min(end, size - 1)

    async def gen():
        async with aiofiles.open(path, "rb") as fh:
            await fh.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = await fh.read(min(_FILE_CHUNK, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    headers = {
        "Accept-Ranges": "bytes",
        # Кэш-файл неизменен для данного video_id — разрешаем браузеру кэшировать
        # (повторное прослушивание не бьёт по бэку вовсе).
        "Cache-Control": "public, max-age=86400",
        "Content-Length": str(end - start + 1),
    }
    status_code = 200
    if has_range:
        status_code = 206
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    return StreamingResponse(
        gen(), status_code=status_code, media_type=media_type, headers=headers
    )


def _parse_range(header: Optional[str], total: Optional[int]) -> tuple[int, Optional[int]]:
    """Парсит 'bytes=start-end' → (start, end|None). end включительный."""
    if not header:
        return 0, None
    m = re.fullmatch(r"bytes=(\d*)-(\d*)", header.strip())
    if not m:
        return 0, None
    start_s, end_s = m.group(1), m.group(2)
    if start_s == "":
        # suffix range: последние N байт
        if end_s == "" or total is None:
            return 0, None
        n = int(end_s)
        return max(0, total - n), total - 1
    start = int(start_s)
    end = int(end_s) if end_s else None
    return start, end


async def _probe(client: httpx.AsyncClient, url: str) -> tuple[int, Optional[int]]:
    """Пробный range-запрос: (http-статус, полный размер файла или None).

    Заодно валидирует ссылку: googlevideo-URL живут ограниченно и могут быть
    привязаны к IP — протухшая ссылка отвечает 403 ещё ДО начала стрима.
    """
    try:
        resp = await client.get(url, headers={"Range": "bytes=0-0"})
    except httpx.HTTPError:
        return 599, None
    # Некоторые CDN отвечают 206, но закрывают соединение без единого байта.
    # Такой URL нельзя передавать в StreamingResponse: первый же Range от
    # браузера закончится short segment. httpx уже дочитал тело ответа.
    if 200 <= resp.status_code < 300 and not resp.content:
        return 599, None
    cr = resp.headers.get("content-range")  # 'bytes 0-0/12345'
    total = None
    if cr and "/" in cr:
        tail = cr.rsplit("/", 1)[-1].strip()
        if tail.isdigit():
            total = int(tail)
    return resp.status_code, total


# Путь архивной копии внешнего трека в MinIO кэшируем в Redis: без этого
# list_objects уходил бы в сеть на КАЖДЫЙ Range-запрос плеера. Положительный
# ответ живёт долго (объект не исчезает), отрицательный — коротко, чтобы трек,
# заархивированный только что, быстро начал отдаваться из хранилища.
_ARCHIVE_HIT_TTL = 24 * 3600
_ARCHIVE_MISS_TTL = 300


async def archived_music_path(archive_key: Optional[str]) -> Optional[str]:
    """file_path архивной копии внешнего трека (``external/<source>/<id>``) или None."""
    if not archive_key or not storage.is_minio_backend():
        return None
    cache_key = f"archive:path:{archive_key}"
    cached = await get_cache_async(cache_key)
    if cached is not None:
        return cached or None
    path = await asyncio.to_thread(storage.find_music_object, f"external/{archive_key}")
    await set_cache_async(
        cache_key, path or "", expire=_ARCHIVE_HIT_TTL if path else _ARCHIVE_MISS_TTL
    )
    return path


async def stream_cached_audio(
    request: Request, cache_id: str, resolver, archive_key: Optional[str] = None
):
    """Отдаёт аудио по прямому URL с диск-кэшем, probe и ресегментацией.

    Общий движок стрима для всех yt-dlp-провайдеров (YouTube Music, SoundCloud).
    Специфика источника вынесена в ``resolver`` — awaitable ``resolver(force)``,
    возвращающий ``(direct_url, ext, total, fresh)``. Кидает ``TrackUnavailable``
    при генуинной недоступности (→ 404) и ``TransientResolveError`` при
    временном сбое резолва (→ 503 Retry-After — НЕ 404). Различие важно для
    фронта: 404 значит «трек мёртв, скипай», 503 — «попробуй ещё раз», и
    смешивать их приводило к тому, что обычный таймаут yt-dlp выглядел как
    недоступный трек и трек автоматически пропускался. ``fresh`` — True, если
    URL только что получен от резолвера, False — если отдан из кэша. ``cache_id``
    — безопасное для файловой системы имя
    (используется как имя кэш-файла и должно быть уникальным между источниками).
    """
    # Уже качали этот трек — отдаём с диска, минуя yt-dlp и CDN источника.
    cached = _cached_file(cache_id)
    if cached:
        ext = os.path.splitext(cached)[1].lower()
        return await _serve_file(cached, MEDIA_TYPES.get(ext, "audio/mp4"), request)

    # Архивная копия в MinIO (её кладёт ленивая архивация при первом
    # прослушивании) — второй по скорости путь после локального диск-кэша:
    # байты рядом, резолв провайдера не нужен вовсе. Диск-кэш ограничен
    # 4 ГБ и вытесняется по LRU, поэтому без этой проверки давно
    # заархивированный трек всё равно уходил в резолв (~1.5-5 с TTFB).
    archived = await archived_music_path(archive_key)
    if archived:
        try:
            return await storage.minio_range_response_async(archived, request)
        except Exception:  # noqa: BLE001 — объект мог быть удалён; играем по обычному пути
            logger.warning("archived object unusable for %s", cache_id, exc_info=True)

    try:
        direct_url, ext, total, fresh = await resolver(False)
    except TrackUnavailable:
        # Трек недоступен (удалён/приватен/регион) — это не сбой сервера.
        logger.info("track unavailable: %s", cache_id)
        raise HTTPException(status_code=404, detail="Трек недоступен")
    except BotCheckError:
        # Rate-limit по IP. Тоже 503, но с длинным Retry-After: фронт не должен
        # частить — каждый лишний запрос продлевает блокировку.
        logger.info("bot-check backoff: %s", cache_id)
        raise HTTPException(
            status_code=503,
            detail="Источник временно ограничил доступ, повторите позже",
            headers={"Retry-After": str(_BOT_CHECK_TTL)},
        )
    except TransientResolveError:
        # Временный сбой (таймаут/сеть/429) — сервер жив, стоит повторить
        # скоро. 503, а не 404: фронт не должен считать трек мёртвым.
        logger.info("transient resolve failure: %s", cache_id)
        raise HTTPException(
            status_code=503,
            detail="Временная ошибка получения аудио, повторите",
            headers={"Retry-After": str(_TRANSIENT_TTL)},
        )
    except Exception:  # noqa: BLE001
        logger.exception("yt-dlp resolve failed: %s", cache_id)
        raise HTTPException(status_code=502, detail="Не удалось получить аудио")

    media_type = MEDIA_TYPES.get(ext, "audio/mp4")

    # follow_redirects обязателен: googlevideo нередко отвечает 302 на другой
    # edge-узел (rr2---…). Без него probe возвращал 302 без размера, а каждый
    # сегмент — 302 с пустым телом → 3 ретрая → пере-резолв → по кругу. Снаружи
    # это выглядело как «трек грузится вечно», хотя ссылка живая.
    # Прокси (если настроен) обязателен по другой причине: ссылка привязана к IP
    # выхода, с которого её выдали, — см. proxy_for_url.
    client = _stream_client(httpx.Timeout(30.0, read=60.0), direct_url)
    # Размер нужен для корректного Range и дискового кэша. Авторитетный размер
    # — из content-range самого googlevideo (probe), а filesize из yt-dlp может
    # расходиться. Probe заодно валидирует
    # ссылку: кэшированный URL мог протухнуть (403) — тогда резолвим заново
    # и пробуем ещё раз, ДО отправки заголовков клиенту.
    #
    # Проверяем даже свежий URL: Invidious/yt-dlp могут вернуть ссылку, которую
    # CDN сразу закрывает пустым 206. Один range 0-0 дешевле, чем запускать
    # StreamingResponse с нерабочим источником и заставлять браузер повторять
    # запросы.
    def _warm_size(path: str) -> int:
        try:
            return os.path.getsize(path)
        except OSError:
            return 0

    warm_path = _warm_file(cache_id, ext)
    early_start, _ = _parse_range(request.headers.get("range"), None)
    warm_size = _warm_size(warm_path) if early_start == 0 else 0
    # Probe выполняем ВСЕГДА — и для кэшированных, и для свежих ссылок.
    # Кэшированные могли протухнуть за часы с момента прогрева, а свежие
    # Invidious/yt-dlp иногда выдают ссылку, которую CDN сразу закрывает
    # пустым 206. Раньше fast-path пропускал probe для свежих URL — мёртвая
    # ссылка обнаруживалась УЖЕ после отправки заголовков с Content-Length:
    # стрим обрывался, тело оказывалось короче заявленного и uvicorn падал
    # с «Exception in ASGI application» на некоторых треках. Один range 0-0
    # (десятки мс) дешевле оборванного ответа: мёртвая ссылка ловится ДО
    # ответа клиенту и чисто пере-резолвится ниже (либо клиент получает
    # честный 502 и может повторить запрос). Заодно probe даёт
    # авторитетный total от самого CDN (filesize из yt-dlp может врать —
    # ещё один источник расхождения тела с Content-Length).
    # Probe (range 0-0 к CDN) — это полный RTT до googlevideo (~1с и хуже),
    # и он стоял ПЕРЕД первым байтом ответа даже у прогретых треков. Если
    # первые байты уже на диске (warm-файл) И размер известен (Content-Range
    # прогрева — авторитетный), probe не нужен: заголовки строим по total,
    # старт уходит с диска мгновенно, а мёртвую ссылку живой proxy поймает
    # уже ПОСЛЕ warm-куска и пере-резолвит через try_reresolve — клиент к
    # этому моменту давно играет. Для остальных случаев (нет warm / нет
    # total / Range с середины) probe обязателен: он даёт total для
    # Content-Length и ловит пустые 206 до отправки заголовков.
    if warm_size > 0 and total is not None:
        status, probed = 200, None
    else:
        status, probed = await _probe(client, direct_url)
    if status >= 400:
        logger.info("stale direct url for %s (probe %s), re-resolving", cache_id, status)
        try:
            direct_url, ext, total, _ = await resolver(True)
        except TrackUnavailable:
            await client.aclose()
            raise HTTPException(status_code=404, detail="Трек недоступен")
        except BotCheckError:
            await client.aclose()
            logger.info("bot-check backoff on re-resolve: %s", cache_id)
            raise HTTPException(
                status_code=503,
                detail="Источник временно ограничил доступ, повторите позже",
                headers={"Retry-After": str(_BOT_CHECK_TTL)},
            )
        except TransientResolveError:
            await client.aclose()
            logger.info("transient re-resolve failure: %s", cache_id)
            raise HTTPException(
                status_code=503,
                detail="Временная ошибка получения аудио, повторите",
                headers={"Retry-After": str(_TRANSIENT_TTL)},
            )
        except Exception:  # noqa: BLE001
            await client.aclose()
            logger.exception("re-resolve failed: %s", cache_id)
            raise HTTPException(status_code=502, detail="Не удалось получить аудио")
        media_type = MEDIA_TYPES.get(ext, "audio/mp4")
        # После пере-резолва расширение (и warm-путь) могли смениться.
        warm_path = _warm_file(cache_id, ext)
        warm_size = _warm_size(warm_path) if early_start == 0 else 0
        status, probed = await _probe(client, direct_url)
        if status >= 400:
            await client.aclose()
            logger.warning("fresh url also dead for %s (probe %s)", cache_id, status)
            raise HTTPException(status_code=502, detail="Источник аудио недоступен")
    if probed is not None:
        total = probed

    req_start, req_end = _parse_range(request.headers.get("range"), total)
    if total is not None and req_end is None:
        req_end = total - 1

    # Кэшируем только когда клиент тянет файл целиком (start=0..total-1) —
    # тогда по завершении получаем полную копию, пригодную для повторной отдачи.
    cache_final = os.path.join(CACHE_DIR, f"{cache_id}{ext}")
    want_cache = (
        total is not None
        and req_start == 0
        and req_end == total - 1
        and not os.path.exists(cache_final)
    )

    async def proxy():
        # Тянем сегментами по _SEGMENT байт с повтором при обрыве — googlevideo
        # надёжно отдаёт короткие range-запросы, но рвёт длинные потоки.
        nonlocal direct_url
        # Пере-резолв протухшей ссылки прямо посреди стрима:
        # заголовки уже отправлены, но содержимое файла у нового URL то же,
        # так что можно продолжить с той же позиции. Покрывает длинные стримы,
        # переживающие срок жизни googlevideo-ссылки (раньше такой стрим
        # просто молча обрывался). Разрешён ОДИН раз на позицию (а не один
        # на весь стрим): очень длинный стрим может пережить НЕСКОЛЬКО
        # протуханий ссылки. Зацикливание исключено: без прогресса с момента
        # последнего пере-резолва повторная попытка не даётся.
        last_reresolve_pos = -1
        tmp = None
        tmp_path = None
        committed = False
        if want_cache:
            try:
                fd, tmp_path = tempfile.mkstemp(dir=CACHE_DIR, suffix=".part")
                tmp = os.fdopen(fd, "wb")
            except OSError:
                tmp = None
        try:
            pos = req_start
            got = 0

            async def try_reresolve(reason: str) -> bool:
                """Одна попытка добыть свежую ссылку, не роняя начатый стрим.

                Содержимое файла у нового URL то же (при том же формате),
                поэтому можно продолжить с текущей позиции — уже отправленные
                заголовки и байты остаются валидными.
                """
                nonlocal direct_url, last_reresolve_pos
                cur = pos + got
                if cur <= last_reresolve_pos:
                    # С прошлого пере-резолва не продвинулись ни на байт —
                    # свежая ссылка тоже мертва, повторять бессмысленно.
                    return False
                last_reresolve_pos = cur
                try:
                    new_url, new_ext, new_total, _nf = await resolver(True)
                except Exception:  # noqa: BLE001
                    logger.warning("mid-stream re-resolve failed for %s", cache_id)
                    return False
                if new_ext != ext:
                    # Другое расширение = другой формат и другие байты —
                    # доклеивать их с середины нельзя.
                    logger.warning(
                        "mid-stream re-resolve changed format for %s (%s -> %s)",
                        cache_id, ext, new_ext,
                    )
                    return False
                if total is not None and new_total is not None and new_total != total:
                    # То же расширение, но другой размер файла — YouTube пересобрал
                    # вариант (другой itag/битрейт). Байты несовместимы с уже
                    # отправленными, а хвост за new_total вообще не существует —
                    # продолжение дало бы битый звук или вечные 416 от CDN.
                    logger.warning(
                        "mid-stream re-resolve changed size for %s (%d -> %d)",
                        cache_id, total, new_total,
                    )
                    return False
                logger.info(
                    "mid-stream re-resolve for %s (%s @%d)", cache_id, reason, pos + got
                )
                direct_url = new_url
                return True

            # Прогретое начало трека (см. _warm_first_chunk) отдаём с диска —
            # первые байты уходят клиенту мгновенно, живой proxy подхватывает
            # с позиции warm-файла. Только для запросов с начала файла (pos=0),
            # остальные Range идут прежним чистым proxy-путём.
            if pos == 0 and warm_size > 0:
                try:
                    with open(warm_path, "rb") as wf:
                        while req_end is None or pos <= req_end:
                            chunk = wf.read(_FILE_CHUNK)
                            if not chunk:
                                break
                            if req_end is not None and pos + len(chunk) > req_end + 1:
                                chunk = chunk[: req_end + 1 - pos]
                            if tmp is not None:
                                tmp.write(chunk)
                            pos += len(chunk)
                            yield chunk
                except OSError:
                    # Warm-файл не дочитался — продолжаем живым proxy с pos.
                    pass
            # Если размер неизвестен — качаем до конца (end=None) одним потоком
            # с ретраями по мере продвижения.
            while req_end is None or pos <= req_end:
                seg_end = pos + _SEGMENT - 1
                if req_end is not None:
                    seg_end = min(seg_end, req_end)
                headers = {"Range": f"bytes={pos}-{seg_end}"}
                expected = seg_end - pos + 1

                got = 0
                for attempt in range(_SEGMENT_RETRIES):
                    try:
                        async with client.stream("GET", direct_url, headers=headers) as up:
                            if up.status_code >= 400:
                                if await try_reresolve(f"upstream {up.status_code}"):
                                    continue
                                logger.warning("upstream %s for %s", up.status_code, cache_id)
                                return
                            async for chunk in up.aiter_bytes(chunk_size=65536):
                                # CDN иногда игнорирует конец Range и шлёт
                                # больше запрошенного. Не отдаём байты другого
                                # сегмента: следующая итерация заберёт их
                                # правильным Range-запросом.
                                remaining = expected - got
                                if remaining <= 0:
                                    break
                                if len(chunk) > remaining:
                                    chunk = chunk[:remaining]
                                record_stream_proxy_traffic(direct_url, len(chunk))
                                # Пишем в кэш только новые (за пределами уже
                                # полученных got) байты сегмента.
                                if tmp is not None:
                                    tmp.write(chunk)
                                got += len(chunk)
                                yield chunk
                                if got == expected:
                                    break
                        if got == expected:
                            break
                        # Нормально закрывшееся соединение с неполным Range —
                        # это такой же обрыв, как HTTPError. Дособираем хвост,
                        # иначе Content-Length не совпадёт с телом ответа.
                        if req_end is None:
                            break  # настоящий EOF у потока без известной длины
                        if attempt == _SEGMENT_RETRIES - 1:
                            # Ретраи не помогли — возможно, ссылка мертва (CDN
                            # отвечает 2xx, но закрывает соединение без байтов).
                            # break: outer while повторит остаток сегмента уже
                            # с пере-резолвленной ссылкой.
                            if await try_reresolve("short segment"):
                                break
                            logger.warning("short segment %s @%d (%d/%d bytes)", cache_id, pos, got, expected)
                            return
                        headers = {"Range": f"bytes={pos + got}-{seg_end}"}
                    except httpx.HTTPError as exc:
                        # Частичный сегмент — досбираем оставшийся хвост.
                        if got:
                            headers = {"Range": f"bytes={pos + got}-{seg_end}"}
                        if attempt == _SEGMENT_RETRIES - 1:
                            if await try_reresolve(f"segment error: {exc}"):
                                break
                            logger.warning("segment failed %s @%d: %s", cache_id, pos, exc)
                            return

                pos += got
                if req_end is None and got < expected:
                    break

            # Дошли до конца файла без обрыва — фиксируем кэш атомарно.
            if tmp is not None and req_end is not None and pos > req_end:
                tmp.flush()
                os.fsync(tmp.fileno())
                tmp.close()
                tmp = None
                os.replace(tmp_path, cache_final)
                committed = True
                # Полная копия на диске — warm-огрызок больше не нужен.
                try:
                    os.remove(warm_path)
                except OSError:
                    pass
                _enforce_cache_limit()
        finally:
            await client.aclose()
            if tmp is not None:
                tmp.close()
            if tmp_path and not committed and os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass

    status_code = 200
    # Содержимое трека для данного cache_id неизменно, так что при известном
    # размере ответ можно кэшировать браузеру. Это критично за медленным
    # туннелем (ngrok): скрытый preload-<audio> следующего трека буферизует
    # байты заранее, и при переключении браузер переиспользует их из HTTP-кэша
    # вместо повторной перекачки через узкий туннель. С no-store каждый старт
    # качал те же байты дважды. private — кэш только в браузере слушателя.
    # Без известного total остаёмся на no-store: не хотим закэшированных
    # обрывков от стрима неизвестной длины.
    cache_control = "private, max-age=3600" if total is not None else "no-store"
    headers = {"Accept-Ranges": "bytes", "Cache-Control": cache_control}
    if total is not None:
        if request.headers.get("range"):
            status_code = 206
            headers["Content-Range"] = f"bytes {req_start}-{req_end}/{total}"
            headers["Content-Length"] = str(req_end - req_start + 1)
        else:
            headers["Content-Length"] = str(total)

    return StreamingResponse(
        proxy(),
        status_code=status_code,
        media_type=media_type,
        headers=headers,
    )


@router.get("/stream/{video_id}")
async def stream_ytmusic(video_id: str, request: Request):
    if _ytmusic is None:
        raise HTTPException(status_code=503, detail="YouTube Music не настроен")
    if not re.fullmatch(r"[A-Za-z0-9_-]{5,20}", video_id):
        raise HTTPException(status_code=400, detail="Некорректный id")
    # Ленивая архивация в MinIO прямо отсюда: внешние треки из поиска/потока
    # имеют строковой id и играются напрямую через этот эндпоинт, минуя
    # /tracks/{id}/stream (где раньше был единственный хук). fire-and-forget:
    # schedule_archive_external сам дедупит по (source, external_id) и быстро
    # выходит, если объект уже в MinIO или бэкенд не minio, поэтому
    # повторные вызовы (в т.ч. на Range-запросы) дешёвые.
    try:
        from app import external_archive

        asyncio.create_task(external_archive.schedule_archive_external("ytmusic", video_id))
    except Exception:  # noqa: BLE001 — архивация не должна ломать воспроизведение
        logger.exception("lazy-archive-ext: не удалось запланировать архивацию %s", video_id)
    return await stream_cached_audio(
        request,
        video_id,
        lambda force: _resolve_cached(video_id, force=force),
        archive_key=f"ytmusic/{video_id}",
    )


@router.post("/prefetch/{video_id}")
async def prefetch_ytmusic(video_id: str):
    """Ставит трек в фоновую очередь прогрева (резолв в Redis + первые байты
    на диск, см. schedule_prefetch) и отвечает сразу. Фронт зовёт это для
    кликнутого и следующих в очереди треков."""
    if _ytmusic is None:
        raise HTTPException(status_code=503, detail="YouTube Music не настроен")
    if not re.fullmatch(r"[A-Za-z0-9_-]{5,20}", video_id):
        raise HTTPException(status_code=400, detail="Некорректный id")
    status = schedule_prefetch(
        video_id,
        lambda force=False: _resolve_cached(video_id, force=force),
        f"ytdlp:resolve:v2:{video_id}",
        _RESOLVE_TTL,
        archive_key=f"ytmusic/{video_id}",
    )
    return {"status": status}


@router.get("/prefetch/{video_id}/ready")
async def prefetch_ytmusic_ready(video_id: str):
    """Готов ли прогрев трека (резолв в Redis или кэш-файл). Фронт поллит это
    после POST /prefetch и снимает гейт скипа вперёд только на ready=True."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{5,20}", video_id):
        raise HTTPException(status_code=400, detail="Некорректный id")
    ready = await prefetch_is_ready(
        video_id, f"ytdlp:resolve:v2:{video_id}", archive_key=f"ytmusic/{video_id}"
    )
    return {"ready": ready}
