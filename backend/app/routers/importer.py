"""Импорт треков и плейлистов из внешних сервисов (SoundCloud, Yandex Music, Spotify).

Разбирает ссылку, делает каждый трек играбельным и складывает в новый плейлист
пользователя:

* SoundCloud — материализуем нативно (свой стрим-движок, см. soundcloud.py).
* Yandex Music — метаданные из yandex_music.py (публичные веб-хендлеры без
  токена, либо API по токену, если он задан), с фолбэком на yt-dlp; аудио
  подбирается матчингом в YouTube Music.
* Spotify — метаданные из spotify.py (страница встроенного плеера без ключей,
  либо Web API, если ключи заданы): аудио закрыто DRM, поэтому каждый трек
  тоже подбирается матчингом в YouTube Music.

Ключи и токены нигде не обязательны — они лишь снимают ограничения (длинные
плейлисты в Spotify, приватные коллекции в Yandex).
"""

import asyncio
import logging
import os
import re
from typing import List, Optional, Tuple
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File
from sqlalchemy import insert
from sqlalchemy.orm import Session

from app.artist_utils import split_title_artist
from app.database import get_db
from app.dependencies import get_current_active_user
from app.models import Playlist, playlist_tracks
from app.recommendation_cache import invalidate_recommendation_cache
from app.routers import soundcloud, spotify, ytdlp
from app.routers.tracks import get_or_create_external_track
from app.recommendation_telemetry import link_materialized_deliveries
from app.schemas import (
    ExternalTrackImport,
    ImportPreviewResponse,
    ImportPreviewTrack,
    ImportRequest,
    ImportResult,
    PlaylistResponse,
)

logger = logging.getLogger(__name__)

# Пытаемся импортировать нативный клиент Yandex Music
try:
    from app.routers import yandex_music as yandex_music_native
    HAS_YANDEX_MUSIC_NATIVE = True
except ImportError:
    HAS_YANDEX_MUSIC_NATIVE = False
    logger.warning("Нативный клиент Yandex Music недоступен")

router = APIRouter()

# Safety ceiling; providers are paged until exhaustion below this high bound.
_MAX_TRACKS = 10_000
# Одновременных резолвов/матчей — чтобы большой плейлист не завалил yt-dlp/ytmusic.
_CONCURRENCY = 8

# Директория для хранения cookies файлов (для обхода CAPTCHA на Yandex Music)
_COOKIES_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "cookies")
os.makedirs(_COOKIES_DIR, exist_ok=True)

# Человекочитаемые имена источников для описания созданного плейлиста.
_SOURCE_LABELS = {
    "soundcloud": "SoundCloud",
    "yandex": "Yandex Music",
    "spotify": "Spotify",
}


def _detect(url: str) -> Tuple[str, str]:
    """Ссылка → (source, kind). Кидает 400 на нераспознанный URL.

    source: soundcloud | yandex | spotify;
    kind: playlist | user | track | album | artist | likes.
    """
    # Spotify: и веб-ссылки (open.spotify.com/...), и URI (spotify:playlist:...).
    # Проверяем первым: у URI нет netloc, разбор ниже его не увидит.
    spotify_parsed = spotify.parse_url(url)
    if spotify_parsed:
        return "spotify", spotify_parsed[0]

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
        # Разбор ссылок Yandex живёт в yandex_music.py — там же, где по этим
        # id ходят за метаданными.
        if HAS_YANDEX_MUSIC_NATIVE:
            parsed = yandex_music_native.parse_url(url)
            if parsed:
                return "yandex", parsed[0]
        # Неизвестный формат — пробуем как плейлист (дальше подхватит yt-dlp).
        return "yandex", "playlist"

    raise HTTPException(
        status_code=400,
        detail="Поддерживаются только ссылки SoundCloud, Yandex Music и Spotify",
    )


async def _normalize_url(url: str) -> str:
    """Приводит ссылку к разбираемому виду до _detect.

    Мобильное «Поделиться» в Spotify даёт короткую spotify.link/... — из неё
    нельзя вытащить тип и id, пока не пройден редирект.
    """
    url = (url or "").strip()
    if spotify.is_short_link(url):
        return await spotify.resolve_short_link(url)
    return url


def _artist_of(entry: dict) -> str:
    artists = entry.get("artists") or []
    name = ", ".join(a for a in artists if a).strip()
    return name or (entry.get("uploader") or entry.get("artist") or "Unknown Artist")


def _cover_of(entry: dict) -> Optional[str]:
    thumbs = entry.get("thumbnails") or []
    if thumbs:
        return thumbs[-1].get("url")
    return entry.get("thumbnail")


def _extract_blocking(url: str, cookies_file: Optional[str] = None) -> dict:
    """yt-dlp extract_flat по ссылке. Блокирующая — звать через to_thread.

    cookies_file — путь к Netscape-формату cookies (браузерный экспорт).
    Помогает обойти CAPTCHA на Yandex Music, если пользователь уже авторизован
    в браузере.
    """
    import yt_dlp

    opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": True,
        "skip_download": True,
        "playlistend": _MAX_TRACKS,
        "socket_timeout": 20,
    }

    # Поддержка cookies для обхода CAPTCHA
    if cookies_file:
        opts["cookiefile"] = cookies_file
    else:
        # Пробуем стандартные пути для cookies
        import os
        possible_cookie_paths = [
            os.path.expanduser("~/yandex_music_cookies.txt"),
            os.path.expanduser("~/.config/yandex_music_cookies.txt"),
            os.path.join(os.path.dirname(__file__), "..", "..", "yandex_cookies.txt"),
        ]
        for path in possible_cookie_paths:
            if os.path.exists(path):
                opts["cookiefile"] = path
                break

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


def _extract_yandex_likes_url(url: str) -> Optional[str]:
    """Извлекает URL для извлечения лайков из ссылки Yandex Music.

    Примеры:
    - https://music.yandex.ru/users/12345678/likes/tracks → https://music.yandex.ru/users/12345678/likes/tracks
    - https://music.yandex.ru/users/12345678/likes → https://music.yandex.ru/users/12345678/likes/tracks
    """
    parsed = urlparse(url)
    path = parsed.path.rstrip("/")

    # Паттерн: /users/{user_id}/likes[/tracks]
    match = re.search(r"(/users/\d+/likes)(/tracks)?$", path)
    if match:
        base = match.group(1)
        return f"{parsed.scheme}://{parsed.netloc}{base}/tracks"

    return None


def _clean_match_title(title: str) -> str:
    """Очищает название трека от мусора перед матчингом.

    Удаляет '(remix)', '[explicit]', 'feat. ...' и т.п. из названия
    для более точного матчинга в YouTube Music. Используется для всех
    источников без нативного стрима (Yandex Music, Spotify).
    """
    if not title:
        return title

    # Удаляем типичные суффиксы в скобках/квадратных скобках
    cleaned = re.sub(
        r"\s*[\(\[]\s*(?:remix|edit|version|explicit|clean|radio edit|"
        r"extended|instrumental|acoustic|live|demo|radio|club|"
        r"remaster(?:ed)?|deluxe|single|album version)\s*[\)\]]",
        "",
        title,
        flags=re.IGNORECASE,
    )

    # Удаляем "feat. ..." и "ft. ..." из названия (артист уже вынесен отдельно)
    cleaned = re.sub(r"\s*(?:feat\.|ft\.)\s*.+$", "", cleaned, flags=re.IGNORECASE)

    return cleaned.strip(" -–—")


def _build_match_query(artist: str, title: str) -> str:
    """Строит оптимальный запрос для матчинга в YouTube Music.

    Использует очищенное название и основного артиста для более точного поиска.
    """
    # Берём только первого артиста (основного) для более точного поиска
    main_artist = artist.split(",")[0].strip() if artist else ""
    cleaned_title = _clean_match_title(title)

    if main_artist and cleaned_title:
        return f"{main_artist} {cleaned_title}"
    elif main_artist:
        return main_artist
    elif cleaned_title:
        return cleaned_title
    else:
        return f"{artist} {title}".strip()


def _tracks_to_entries(tracks: List) -> List[dict]:
    """Треки Spotify/Yandex → entries в формате yt-dlp (общий вход матчинга)."""
    return [
        {
            "title": t.title,
            "artists": [t.artist],
            "album": t.album,
            "duration": t.duration,
            "thumbnails": [{"url": t.cover_url}] if t.cover_url else [],
            "id": t.id,
            # explicit есть только у Spotify (Web API); yandex-треки несут False
            "explicit": bool(getattr(t, "explicit", False)),
        }
        for t in tracks
    ]


async def _extract_yandex_native(
    request: Request, url: str, kind: str
) -> Optional[Tuple[Optional[str], Optional[str], List[dict]]]:
    """Метаданные Yandex Music без yt-dlp: публичные хендлеры или API по токену.

    None — ссылка не разобрана либо сервис не ответил (тогда пробуем yt-dlp).
    """
    if not HAS_YANDEX_MUSIC_NATIVE:
        return None

    result = await yandex_music_native.fetch_by_url(request, url)
    if result is None:
        return None

    title, cover, tracks = result
    if not tracks:
        return None
    return title, cover, _tracks_to_entries(tracks)


async def _extract_spotify(url: str) -> Tuple[Optional[str], Optional[str], List[dict]]:
    """Метаданные коллекции/трека Spotify → entries.

    Фолбэка на yt-dlp нет: yt-dlp не умеет Spotify (аудио под DRM). Ошибки
    (приватный плейлист, 404, недоступность) уходят наружу как есть.
    """
    title, cover, tracks = await spotify.fetch_by_url(url)
    return title, cover, _tracks_to_entries(tracks)


async def _extract_collection(
    request: Request, url: str, source: str, kind: str, cookies_file: Optional[str] = None
) -> Tuple[Optional[str], Optional[str], List[dict]]:
    """(title, cover, entries) коллекции/трека. Кидает 502 при сбое извлечения."""

    if source == "spotify":
        return await _extract_spotify(url)

    # Для Yandex Music сначала пробуем нативный API (обходит CAPTCHA)
    if source == "yandex":
        native_result = await _extract_yandex_native(request, url, kind)
        if native_result is not None:
            return native_result
        # Если нативный API не сработал, фолбэк на yt-dlp

    # Специальная обработка для лайков Yandex Music
    if source == "yandex" and kind == "likes":
        likes_url = _extract_yandex_likes_url(url)
        if likes_url:
            url = likes_url
            kind = "playlist"  # Лайки обрабатываются как плейлист

    # Если cookies не передан, пробуем найти файл для текущего пользователя
    if not cookies_file and source == "yandex":
        try:
            from app.dependencies import get_current_user_id
            user_id = get_current_user_id(request)
            user_cookies = os.path.join(_COOKIES_DIR, f"user_{user_id}_cookies.txt")
            if os.path.exists(user_cookies):
                cookies_file = user_cookies
        except Exception:
            pass  # Игнорируем, если не удалось получить user_id

    try:
        info = await asyncio.to_thread(_extract_blocking, url, cookies_file)
    except Exception as exc:  # noqa: BLE001 — сеть/капча/недоступно
        logger.warning("import extract failed for %s: %s", url, exc)
        detail = "Не удалось прочитать ссылку. "
        if source == "yandex":
            detail += (
                "Публичные данные Yandex Music тоже не отдались. Возможные причины:\n"
                "1. Сервис недоступен с IP сервера (геоблокировка вне РФ/РБ) — нужен прокси\n"
                "2. Yandex показал капчу — загрузите cookies через /api/import/cookies\n"
                "3. Коллекция приватная — задайте YANDEX_MUSIC_TOKEN в .env"
            )
        else:
            detail += "Проверьте ссылку и доступность сервиса."
        raise HTTPException(status_code=502, detail=detail) from exc

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
        split = split_title_artist(title)
        if split:
            # artists читают и _artist_of, и soundcloud._declared_artist.
            e["artists"] = [split[0]]
            e["title"] = split[1]
        elif coll_artist:
            e["artists"] = [coll_artist]

    # Для лайков Yandex Music устанавливаем заголовок по умолчанию
    if source == "yandex" and kind == "likes" and not info.get("title"):
        info["title"] = "Избранное (Yandex Music)"

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

    # Yandex, Spotify и прочее: матчим по «артист + название» в YouTube Music.
    title = entry.get("title") or entry.get("track") or ""
    artist = _artist_of(entry)
    if not title:
        return None, False

    # Улучшенный запрос для матчинга
    query = _build_match_query(artist, title)

    # Если запрос слишком короткий (< 3 символов), пробуем полный вариант
    if len(query) < 3:
        query = f"{artist} {title}".strip()

    try:
        # Пробуем улучшенный запрос, если не нашли — полный
        found = await ytdlp.search_ytmusic(request, query, limit=3)

        # Если улучшенный запрос не дал результатов, пробуем полный
        if not found and query != f"{artist} {title}".strip():
            full_query = f"{artist} {title}".strip()
            if full_query != query:
                found = await ytdlp.search_ytmusic(request, full_query, limit=3)

        # Если всё ещё не нашли, пробуем только название (для случаев с
        # нестандартными артистами)
        if not found and title:
            found = await ytdlp.search_ytmusic(request, title, limit=3)

    except Exception:  # noqa: BLE001
        logger.exception("ytmusic match failed for %s", query)
        return None, False

    if not found:
        return None, True  # искали, но не нашли — считается как «matched-попытка»

    # Выбираем лучшее совпадение (если несколько)
    best_match = _select_best_match(found, artist, title)
    if not best_match:
        return None, True

    # Источник говорит «explicit», а ytmusic отдал clean-версию (isExplicit
    # отсутствует/False) — в YouTube Music у такой записи обычно нет
    # нецензурной редакции. Ищем ту же запись на SoundCloud: там цензуры нет.
    if entry.get("explicit") and not best_match.is_explicit:
        uncensored = await _find_uncensored_soundcloud(
            request, artist, title, entry.get("duration") or 0
        )
        if uncensored is not None:
            return (
                ExternalTrackImport(
                    source=uncensored.source,
                    external_id=uncensored.external_id,
                    title=uncensored.title,
                    artist=uncensored.artist,
                    album=uncensored.album,
                    duration=uncensored.duration,
                    cover_url=uncensored.cover_url,
                    stream_url=uncensored.stream_url,
                    genre=uncensored.genre,
                ),
                True,
            )

    payload = ExternalTrackImport(
        source=best_match.source,
        external_id=best_match.external_id,
        title=best_match.title,
        artist=best_match.artist,
        album=best_match.album,
        duration=best_match.duration,
        cover_url=best_match.cover_url,
        stream_url=best_match.stream_url,
    )
    return payload, True


def _select_best_match(
    candidates: List, artist: str, title: str
) -> Optional[object]:
    """Выбирает лучшее совпадение из списка кандидатов.

    Использует простой scoring: точное совпадение артиста + название = высший
    балл. При равном счёте предпочитаем explicit-кандидата: в YouTube Music
    часто лежат обе версии записи с одинаковым названием и длительностью.
    """
    if not candidates:
        return None

    artist_lower = artist.lower()
    title_lower = title.lower()

    scored = []
    for candidate in candidates:
        score = 0

        # Совпадение артиста (точное или частичное)
        candidate_artist = (candidate.artist or "").lower()
        if candidate_artist == artist_lower:
            score += 10
        elif artist_lower in candidate_artist or candidate_artist in artist_lower:
            score += 5

        # Совпадение названия (точное или частичное)
        candidate_title = (candidate.title or "").lower()
        cleaned_title = _clean_match_title(title_lower)
        if candidate_title == cleaned_title or candidate_title == title_lower:
            score += 10
        elif cleaned_title in candidate_title or candidate_title in cleaned_title:
            score += 5
        elif title_lower in candidate_title or candidate_title in title_lower:
            score += 3

        # Наличие обложки (бонус)
        if candidate.cover_url:
            score += 1

        # Наличие альбома (бонус)
        if candidate.album:
            score += 1

        scored.append((score, candidate))

    # Сортируем по убыванию балла; при равном счёте первым идёт explicit
    # (оригинал), а не clean-версия той же записи.
    scored.sort(key=lambda x: (-x[0], not getattr(x[1], "is_explicit", False)))

    # Возвращаем лучший вариант, если балл достаточный
    best_score, best_candidate = scored[0]
    if best_score >= 5:  # Минимальный порог для принятия
        return best_candidate

    # Если балл низкий, всё равно возвращаем лучший (может быть полезен)
    return best_candidate


# Маркеры «другой записи» в названии: slowed/reverb-версии живут на SoundCloud
# тысячами, совпадают по названию (вхождение) и длительности, но записью не
# являются. Clean — наоборот, та же цензура, за которой мы сюда пришли.
_NOT_SAME_RECORDING = re.compile(
    r"slowed|reverb|sped\s*up|nightcore|8d|instrumental|clean",
    re.IGNORECASE,
)


async def _find_uncensored_soundcloud(
    request: Request, artist: str, title: str, duration: int
) -> Optional["ExternalTrackResponse"]:
    """Та же запись на SoundCloud — там нет цензуры, в отличие от ytmusic.

    Матч строгий (как у soundcloud.find_ytmusic_equivalent): артист, название
    и длительность одновременно — иначе есть риск подменить трек чужой
    записью или «slowed + reverb». None — точного совпадения нет, вызывающий
    код оставляет ytmusic-матч (лучше цензурный трек, чем никакого).
    """
    query = _build_match_query(artist, title)
    if len(query) < 3:
        query = f"{artist} {title}".strip()
    try:
        results = await soundcloud.search_soundcloud(request, query, limit=10)
    except Exception:  # noqa: BLE001 — поиск не должен ломать импорт
        logger.exception("soundcloud uncensored search failed for %s", query)
        return None

    for candidate in results:
        if _NOT_SAME_RECORDING.search(candidate.title or ""):
            continue
        if soundcloud._is_exact_match(candidate, title, artist, duration):
            return candidate
    return None


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


@router.post("/cookies")
async def upload_cookies(
    file: UploadFile = File(...),
    current_user=Depends(get_current_active_user),
):
    """Загружает cookies файл для обхода CAPTCHA на Yandex Music.

    Формат: Netscape cookies (экспорт из браузерного расширения).
    Примеры расширений:
    - Chrome: "Get cookies.txt LOCALLY"
    - Firefox: "cookies.txt"
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="Файл не выбран")

    # Проверяем расширение
    if not file.filename.endswith(('.txt', '.cookies')):
        raise HTTPException(
            status_code=400,
            detail="Поддерживаются только .txt файлы (Netscape cookies format)"
        )

    # Сохраняем файл
    file_path = os.path.join(_COOKIES_DIR, f"user_{current_user.id}_cookies.txt")
    content = await file.read()

    # Простая валидка формата cookies
    content_str = content.decode('utf-8', errors='ignore')
    if not any(line.strip().startswith('.') or line.strip().startswith('#') 
               for line in content_str.split('\n')[:10]):
        raise HTTPException(
            status_code=400,
            detail="Неверный формат cookies. Используйте Netscape cookies format."
        )

    with open(file_path, 'wb') as f:
        f.write(content)

    return {
        "status": "ok",
        "message": "Cookies загружены. Теперь вы можете импортировать из Yandex Music.",
        "file_path": file_path
    }


@router.delete("/cookies")
async def delete_cookies(
    current_user=Depends(get_current_active_user),
):
    """Удаляет загруженный cookies файл."""
    file_path = os.path.join(_COOKIES_DIR, f"user_{current_user.id}_cookies.txt")
    if os.path.exists(file_path):
        os.remove(file_path)
        return {"status": "ok", "message": "Cookies удалены"}
    return {"status": "ok", "message": "Cookies файл не найден"}


@router.get("/cookies")
async def check_cookies(
    current_user=Depends(get_current_active_user),
):
    """Проверяет наличие загруженного cookies файла."""
    file_path = os.path.join(_COOKIES_DIR, f"user_{current_user.id}_cookies.txt")
    exists = os.path.exists(file_path)
    return {
        "exists": exists,
        "file_path": file_path if exists else None
    }


@router.post("/preview", response_model=ImportPreviewResponse)
async def import_preview(
    payload: ImportRequest,
    request: Request,
    current_user=Depends(get_current_active_user),
):
    """Разбирает ссылку и возвращает метаданные без материализации (для UI)."""
    url = await _normalize_url(payload.url)
    source, kind = _detect(url)

    if source == "soundcloud" and kind == "playlist":
        native = await _soundcloud_playlist_native(request, url)
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

    title, cover, entries = await _extract_collection(request, url, source, kind)

    # Для лайков Yandex Music устанавливаем заголовок по умолчанию
    if source == "yandex" and kind == "likes" and not title:
        title = "Избранное (Yandex Music)"

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
    url = await _normalize_url(payload.url)
    source, kind = _detect(url)

    imports: List[ExternalTrackImport] = []
    matched = 0
    skipped = 0
    title = cover = None

    native = None
    if source == "soundcloud" and kind == "playlist":
        native = await _soundcloud_playlist_native(request, url)

    if native:
        title, cover, imports = native
    else:
        title, cover, entries = await _extract_collection(request, url, source, kind)
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
        link_materialized_deliveries(
            db,
            user_id=current_user.id,
            source=imp.source,
            external_id=imp.external_id,
            track_id=track.id,
        )
        if track.id in seen:
            continue  # дубли внутри коллекции (напр. матч в один и тот же трек)
        seen.add(track.id)
        track_ids.append(track.id)

    # Теперь собираем плейлист и связи одной транзакцией.
    name = payload.playlist_name or title or "Импортированный плейлист"
    new_playlist = Playlist(
        name=name,
        description=f"Импортировано из {_SOURCE_LABELS.get(source, source)}"
                    + (" (избранное)" if kind == "likes" else ""),
        cover_url=cover if (cover and cover.startswith("http")) else None,
        is_public=False,
        origin="imported",
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
    invalidate_recommendation_cache(current_user.id)
    position = len(track_ids)

    return ImportResult(
        playlist=PlaylistResponse.model_validate(new_playlist),
        imported=position,
        matched=matched,
        skipped=skipped,
    )
