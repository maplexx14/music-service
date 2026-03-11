#!/usr/bin/env python3
"""
hitmotop_scraper.py — Парсер треков с hitmotop.me

Собирает: название трека, исполнитель, жанры, обложку, ссылку на скачивание.
Данные сохраняются в JSON/CSV, а при необходимости сами аудиофайлы могут
скачиваться локально и импортироваться в библиотеку музыкального сервиса.

Использование:
    # Быстрый старт — топ-чарт + первая страница всех жанров
    python hitmotop_scraper.py

    # Только определённые жанры, все страницы
    python hitmotop_scraper.py --genres rusrap ruspop rock --max-pages 0

    # Скачать треки и обложки локально
    python hitmotop_scraper.py --genres rusrap --download-tracks --download-covers

    # Импортировать скачанное прямо в библиотеку (локальный backend)
    python hitmotop_scraper.py --genres rusrap --download-tracks --import-to-library

    # Импортировать через API backend'а
    python hitmotop_scraper.py --genres rock --download-tracks --import-to-library --library-mode api --auth-token TOKEN

    # Продолжить после остановки
    python hitmotop_scraper.py --resume

    # Только топ-100 чарт
    python hitmotop_scraper.py --top-only

    # Топ-500
    python hitmotop_scraper.py --top-limit 500 --top-only

    # Топ-500 именно с rus.hitmotop.com/songs/top-today
    python hitmotop_scraper.py --top-source rus-today --top-limit 500 --top-only
"""

import argparse
import asyncio
import csv
import importlib
import json
import logging
import mimetypes
import os
import random
import re
import shutil
import shlex
import subprocess
import sys
import time
from datetime import datetime
from html import unescape
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import requests

# ─── Константы ────────────────────────────────────────────────────────────────

BASE_URL = "https://hitmotop.me"
RUS_BASE_URL = "https://rus.hitmotop.com"
TOP_CHART_TAG = "ТОП-100"
REQUEST_TIMEOUT = 30
RETRYABLE_STATUSES = {403, 429, 500, 502, 503, 504}

USER_AGENTS = [
    (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/123.0.0.0 Safari/537.36"
    ),
    (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) "
        "Gecko/20100101 Firefox/124.0"
    ),
    (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) "
        "Version/17.3 Safari/605.1.15"
    ),
    (
        "Mozilla/5.0 (X11; Linux x86_64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/122.0.0.0 Safari/537.36"
    ),
    (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Edg/122.0.0.0 Safari/537.36"
    ),
]

ACCEPT_LANGUAGES = [
    "ru-RU,ru;q=0.9,en;q=0.8",
    "ru,en-US;q=0.9,en;q=0.8",
    "en-US,en;q=0.9,ru;q=0.7",
]

DEFAULT_LIBRARY_API_BASE = os.getenv("LIBRARY_API_BASE", "http://localhost:8000/api")
DEFAULT_DOCKER_BACKEND_CONTAINER = os.getenv("LIBRARY_DOCKER_BACKEND_CONTAINER", "music_backend")
DEFAULT_DOCKER_IMPORT_DIR = os.getenv("LIBRARY_DOCKER_IMPORT_DIR", "/tmp/music_import_data")
DEFAULT_DOCKER_IMPORT_SCRIPT = os.getenv("LIBRARY_DOCKER_IMPORT_SCRIPT", "/app/import_scraped_tracks.py")
DEFAULT_DATABASE_URL = (
    os.getenv("SCRAPER_DATABASE_URL")
    or os.getenv("DATABASE_URL")
    or "postgresql+asyncpg://music_user:music_password@localhost:5432/music_db"
)
DEFAULT_LIBRARY_MUSIC_DIR = Path(
    os.getenv(
        "LIBRARY_MUSIC_DIR",
        str(Path(__file__).resolve().parent / "backend" / "music_files"),
    )
)
DEFAULT_LIBRARY_COVER_DIR = Path(
    os.getenv(
        "LIBRARY_COVER_DIR",
        str(Path(__file__).resolve().parent / "backend" / "cover_files"),
    )
)


# ─── Утилиты ──────────────────────────────────────────────────────────────────

def setup_logging(output_dir: Path) -> logging.Logger:
    output_dir.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("hitmotop")
    logger.setLevel(logging.DEBUG)
    logger.handlers.clear()
    logger.propagate = False
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", "%H:%M:%S")

    ch = logging.StreamHandler()
    ch.setLevel(logging.INFO)
    ch.setFormatter(fmt)

    fh = logging.FileHandler(output_dir / "scraper.log", encoding="utf-8")
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(fmt)

    logger.addHandler(ch)
    logger.addHandler(fh)
    return logger


def build_request_headers(referer: str | None = None) -> dict[str, str]:
    return {
        "User-Agent": random.choice(USER_AGENTS),
        "Accept-Language": random.choice(ACCEPT_LANGUAGES),
        "Accept": (
            "text/html,application/xhtml+xml,application/xml;q=0.9,"
            "image/avif,image/webp,*/*;q=0.8"
        ),
        "Referer": referer or BASE_URL,
        "DNT": "1",
        "Connection": "keep-alive",
    }


def sleep_with_jitter(delay: float, spread: float = 0.35):
    if delay <= 0:
        return
    lower = max(0.05, delay * (1 - spread))
    upper = max(lower, delay * (1 + spread))
    time.sleep(random.uniform(lower, upper))


def parse_retry_after(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        return None


def request_with_retry(
    url: str,
    session: requests.Session,
    logger: logging.Logger,
    *,
    stream: bool = False,
    referer: str | None = None,
    max_attempts: int = 5,
) -> requests.Response | None:
    last_error: Exception | None = None

    for attempt in range(1, max_attempts + 1):
        headers = build_request_headers(referer=referer)
        try:
            response = session.get(
                url,
                timeout=REQUEST_TIMEOUT,
                stream=stream,
                headers=headers,
                allow_redirects=True,
            )
            if response.status_code in RETRYABLE_STATUSES:
                retry_after = parse_retry_after(response.headers.get("Retry-After"))
                wait_time = retry_after if retry_after is not None else min(
                    25.0, 1.6 * (2 ** (attempt - 1)) + random.uniform(0.25, 1.25)
                )
                logger.warning(
                    "Сайт ответил статусом %s для %s (попытка %s/%s), ждём %.1fс",
                    response.status_code,
                    url,
                    attempt,
                    max_attempts,
                    wait_time,
                )
                response.close()
                if attempt < max_attempts:
                    sleep_with_jitter(wait_time, spread=0.2)
                    continue
            response.raise_for_status()
            return response
        except requests.HTTPError as exc:
            last_error = exc
            status_code = exc.response.status_code if exc.response is not None else None
            if status_code not in RETRYABLE_STATUSES:
                logger.error("Неретраимая ошибка запроса %s: %s", url, exc)
                if exc.response is not None:
                    exc.response.close()
                return None
            if attempt >= max_attempts:
                break
            wait_time = min(25.0, 1.6 * (2 ** (attempt - 1)) + random.uniform(0.25, 1.25))
            logger.warning(
                "Ошибка запроса %s (попытка %s/%s): %s. Повтор через %.1fс",
                url,
                attempt,
                max_attempts,
                exc,
                wait_time,
            )
            sleep_with_jitter(wait_time, spread=0.2)
        except requests.RequestException as exc:
            last_error = exc
            if attempt >= max_attempts:
                break
            wait_time = min(25.0, 1.6 * (2 ** (attempt - 1)) + random.uniform(0.25, 1.25))
            logger.warning(
                "Ошибка запроса %s (попытка %s/%s): %s. Повтор через %.1fс",
                url,
                attempt,
                max_attempts,
                exc,
                wait_time,
            )
            sleep_with_jitter(wait_time, spread=0.2)

    logger.error(f"Не удалось получить {url}: {last_error}")
    return None


def detect_extension_from_response(response: requests.Response, fallback: str) -> str:
    content_type = response.headers.get("Content-Type", "").split(";")[0].strip().lower()
    ext = mimetypes.guess_extension(content_type) if content_type else None
    if ext == ".jpe":
        ext = ".jpg"

    url_suffix = Path(urlparse(response.url).path).suffix.lower()
    if url_suffix and len(url_suffix) <= 5:
        ext = url_suffix

    return ext or fallback


def should_refresh_download_url(download_url: str) -> bool:
    if not download_url:
        return True
    parsed = urlparse(download_url)
    host = (parsed.netloc or "").lower()
    if host.endswith("hitmotop.me") or "X-Amz-Signature=" not in download_url:
        return True
    return is_presigned_url_expired(download_url)


def is_presigned_url_expired(download_url: str, skew_seconds: int = 120) -> bool:
    parsed = urlparse(download_url)
    query = parse_qs(parsed.query)
    signed_at = (query.get("X-Amz-Date") or [""])[0]
    expires_in = (query.get("X-Amz-Expires") or [""])[0]
    if not signed_at or not expires_in:
        return False

    try:
        signed_dt = datetime.strptime(signed_at, "%Y%m%dT%H%M%SZ")
        expires_seconds = int(expires_in)
    except ValueError:
        return False

    expires_at = signed_dt.timestamp() + expires_seconds
    return time.time() >= (expires_at - skew_seconds)


def extract_fresh_download_url(page_text: str) -> str:
    text = unescape(page_text).replace("\\/", "/")
    patterns = [
        r"https://music-[^\"'\s<>]+",
        r"https://[^\"'\s<>]+\.mp3[^\"'\s<>]*X-Amz-Signature=[^\"'\s<>]+",
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return match.group(0)
    return ""


def refresh_track_download_url(track: dict, session: requests.Session, logger: logging.Logger) -> str:
    track_url = track.get("track_url")
    if not track_url:
        return ""

    response = request_with_retry(track_url, session, logger, referer=BASE_URL)
    if not response:
        return ""

    try:
        fresh_url = ""
        page_data = parse_inertia_data_from_html(response.text, logger)
        if page_data:
            payload = find_track_payload(page_data, int(track.get("id") or 0))
            if payload:
                candidates = [payload.get("download") or "", payload.get("play") or ""]
                for candidate in candidates:
                    candidate = unescape(candidate).replace("\\/", "/")
                    if candidate and not should_refresh_download_url(candidate):
                        fresh_url = candidate
                        break
        if fresh_url:
            track["download_url"] = fresh_url
            logger.info("Обновлена ссылка скачивания для трека %s", track.get("id"))
        else:
            logger.warning(
                "Для трека %s не удалось получить прямую ссылку на аудио, трек будет пропущен",
                track.get("id"),
            )
        return fresh_url
    finally:
        response.close()


def normalize_text(value: str | None) -> str:
    return (value or "").strip()


def resolve_existing_local_path(stored_path: str, output_dir: Path) -> str:
    if not stored_path:
        return ""

    candidates: list[Path] = []
    normalized = stored_path.replace("\\", "/")
    raw_path = Path(normalized)

    if raw_path.is_absolute():
        candidates.append(raw_path)
    else:
        candidates.append(Path.cwd() / raw_path)
        candidates.append(output_dir.parent / raw_path)
        candidates.append(output_dir / raw_path)

    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return ""


def find_existing_media_file(media_dir: Path | None, track_id: int) -> str:
    if not media_dir or not media_dir.exists():
        return ""
    matches = sorted(media_dir.glob(f"{track_id}.*"))
    for match in matches:
        if match.is_file():
            return str(match)
    return ""


def hydrate_local_media_paths(
    track: dict,
    output_dir: Path,
    tracks_dir: Path | None,
    covers_dir: Path | None,
):
    track["audio_local"] = resolve_existing_local_path(track.get("audio_local", ""), output_dir)
    if not track["audio_local"]:
        track["audio_local"] = find_existing_media_file(tracks_dir, int(track.get("id") or 0))

    track["cover_local"] = resolve_existing_local_path(track.get("cover_local", ""), output_dir)
    if not track["cover_local"]:
        track["cover_local"] = find_existing_media_file(covers_dir, int(track.get("id") or 0))


def dedupe_preserve_order(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        clean = value.strip()
        if not clean:
            continue
        key = clean.casefold()
        if key in seen:
            continue
        seen.add(key)
        result.append(clean)
    return result


def get_primary_genre(track: dict) -> str:
    genres = [g for g in track.get("genres", []) if g and g != TOP_CHART_TAG]
    return genres[0] if genres else ""


def upgrade_track_record(track: dict) -> dict:
    original_genres = track.get("genres") or []
    original_slugs = track.get("genre_slugs") or []

    if isinstance(original_genres, str):
        original_genres = [part.strip() for part in original_genres.split(";")]
    if isinstance(original_slugs, str):
        original_slugs = [part.strip() for part in original_slugs.split(";")]

    if track.get("genre") and track["genre"] != TOP_CHART_TAG:
        original_genres.append(track["genre"])

    in_top_chart = bool(track.get("in_top_chart"))
    in_top_chart = in_top_chart or any(g == TOP_CHART_TAG for g in original_genres)
    in_top_chart = in_top_chart or any(slug == "top" for slug in original_slugs)

    track["genres"] = dedupe_preserve_order(
        [g for g in original_genres if g and g != TOP_CHART_TAG]
    )
    track["genre_slugs"] = dedupe_preserve_order(
        [slug for slug in original_slugs if slug and slug != "top"]
    )
    track["in_top_chart"] = in_top_chart
    track["primary_genre"] = get_primary_genre(track)
    track.setdefault("cover_local", "")
    track.setdefault("audio_local", "")
    track.setdefault("library_track_id", None)
    track.setdefault("library_status", "")
    track.setdefault("library_file_path", "")
    track.setdefault("library_cover_url", "")
    track.setdefault("download_url", "")
    track.setdefault("track_url", "")
    track.setdefault("album", "")
    track.setdefault("year", "")
    track.setdefault("duration_sec", 0)
    return track


def fetch_inertia_data(url: str, session: requests.Session, logger: logging.Logger) -> dict | None:
    """
    Загружает страницу и извлекает JSON из атрибута data-page (Inertia.js).
    Возвращает распарсенный dict с ключами component, props, ...
    """
    response = request_with_retry(url, session, logger, referer=BASE_URL)
    if not response:
        return None

    try:
        marker = "data-page="
        idx = response.text.find(marker)
        if idx == -1:
            logger.error(f"data-page не найден на странице {url}")
            return None

        start = idx + len(marker) + 1
        end = response.text.find('"></div>', start)
        if end == -1:
            logger.error(f"Не найден конец data-page на странице {url}")
            return None

        return json.loads(unescape(response.text[start:end]))
    except json.JSONDecodeError as exc:
        logger.error(f"Ошибка парсинга JSON на {url}: {exc}")
        return None
    finally:
        response.close()


def parse_inertia_data_from_html(page_text: str, logger: logging.Logger | None = None) -> dict | None:
    marker = "data-page="
    idx = page_text.find(marker)
    if idx == -1:
        if logger:
            logger.error("data-page не найден в HTML")
        return None

    start = idx + len(marker) + 1
    end = page_text.find('"></div>', start)
    if end == -1:
        if logger:
            logger.error("Не найден конец data-page в HTML")
        return None

    try:
        return json.loads(unescape(page_text[start:end]))
    except json.JSONDecodeError as exc:
        if logger:
            logger.error(f"Ошибка парсинга data-page из HTML: {exc}")
        return None


def find_track_payload(node, track_id: int) -> dict | None:
    if isinstance(node, dict):
        if node.get("id") == track_id and ("download" in node or "play" in node):
            return node
        for value in node.values():
            found = find_track_payload(value, track_id)
            if found:
                return found
    elif isinstance(node, list):
        for item in node:
            found = find_track_payload(item, track_id)
            if found:
                return found
    return None


# ─── Получение данных ──────────────────────────────────────────────────────────

def get_all_genres(session: requests.Session, logger: logging.Logger) -> list[dict]:
    """Возвращает список всех жанров с главной страницы."""
    data = fetch_inertia_data(BASE_URL, session, logger)
    if not data:
        return []
    genres = data.get("props", {}).get("genres", [])
    logger.info(f"Найдено жанров: {len(genres)}")
    return genres


def get_top_chart(session: requests.Session, logger: logging.Logger) -> list[dict]:
    """Возвращает треки из топ-100 чарта."""
    data = fetch_inertia_data(f"{BASE_URL}/songs/top", session, logger)
    if not data:
        return []
    return data.get("props", {}).get("chart_tracks", [])


def get_songs_page(
    page: int,
    session: requests.Session,
    logger: logging.Logger,
) -> dict | None:
    """Возвращает paginated объект items для страницы общего рейтинга /songs."""
    data = fetch_inertia_data(f"{BASE_URL}/songs?page={page}", session, logger)
    if not data:
        return None
    return data.get("props", {}).get("items")


def get_top_tracks(
    top_limit: int,
    session: requests.Session,
    logger: logging.Logger,
    delay: float,
    top_source: str = "global",
) -> list[dict]:
    """
    Возвращает top_limit треков из рейтинга.
    - global: до 100 берётся из /songs/top, далее доклеивается /songs?page=N.
    - rus-today: берётся с rus.hitmotop.com/songs/top-today?page=N.
    """
    if top_source == "rus-today":
        return get_rus_top_today_tracks(top_limit, session, logger, delay)

    requested = max(1, int(top_limit))
    result: list[dict] = []
    seen_ids: set[int] = set()

    chart = get_top_chart(session, logger)
    for raw in chart:
        track_id = raw.get("id")
        if not track_id or track_id in seen_ids:
            continue
        result.append(raw)
        seen_ids.add(track_id)
        if len(result) >= requested:
            return result

    page = 1
    while len(result) < requested:
        items = get_songs_page(page, session, logger)
        if not items or not items.get("data"):
            break

        last_page = int(items.get("last_page") or 1)
        logger.info("  [ТОП] /songs стр. %s/%s", page, last_page)
        for raw in items["data"]:
            track_id = raw.get("id")
            if not track_id or track_id in seen_ids:
                continue
            result.append(raw)
            seen_ids.add(track_id)
            if len(result) >= requested:
                break

        if page >= last_page:
            break
        page += 1
        sleep_with_jitter(delay)

    return result


def parse_rus_track_entries(html_text: str, logger: logging.Logger) -> list[dict]:
    """
    Парсит блоки tracks__item с rus.hitmotop.com.
    Возвращает список raw-треков в совместимом формате.
    """
    entries = re.findall(r"data-musmeta='([^']+)'", html_text)
    download_links = re.findall(
        r'<a[^>]+href="([^"]+)"[^>]*class="track__download-btn"',
        html_text,
        flags=re.IGNORECASE,
    )

    if not entries:
        return []

    raw_tracks: list[dict] = []
    for idx, entry in enumerate(entries):
        try:
            meta = json.loads(unescape(entry))
        except json.JSONDecodeError:
            continue

        track_token = normalize_text(meta.get("id"))
        track_id_str = track_token.replace("track-id-", "")
        if not track_id_str.isdigit():
            continue
        track_id = int(track_id_str)

        download_url = ""
        if idx < len(download_links):
            download_url = unescape(download_links[idx]).strip()
        if not download_url:
            download_url = normalize_text(meta.get("url"))
        if download_url.startswith("//"):
            download_url = f"https:{download_url}"
        elif download_url.startswith("/"):
            download_url = f"{RUS_BASE_URL}{download_url}"

        cover_url = normalize_text(meta.get("img"))
        if cover_url.startswith("//"):
            cover_url = f"https:{cover_url}"

        raw_tracks.append(
            {
                "id": track_id,
                "name": normalize_text(meta.get("title")),
                "performers": normalize_text(meta.get("artist")),
                "duration": 0,
                "cover": cover_url,
                "download": download_url,
                "track_url": f"{RUS_BASE_URL}/song/{track_id}",
            }
        )

    if not raw_tracks:
        logger.warning("rus-today: не удалось распарсить треки из HTML")
    return raw_tracks


def get_rus_top_today_page(
    page: int,
    session: requests.Session,
    logger: logging.Logger,
) -> list[dict]:
    """Возвращает список raw-треков со страницы rus top-today."""
    url = f"{RUS_BASE_URL}/songs/top-today" if page == 1 else f"{RUS_BASE_URL}/songs/top-today?page={page}"
    response = request_with_retry(url, session, logger, referer=RUS_BASE_URL)
    if not response:
        return []
    try:
        return parse_rus_track_entries(response.text, logger)
    finally:
        response.close()


def get_rus_top_today_tracks(
    top_limit: int,
    session: requests.Session,
    logger: logging.Logger,
    delay: float,
) -> list[dict]:
    """Собирает top_limit треков с rus.hitmotop.com/songs/top-today."""
    requested = max(1, int(top_limit))
    result: list[dict] = []
    seen_ids: set[int] = set()
    max_pages = max(1, (requested // 40) + 15)

    for page in range(1, max_pages + 1):
        page_tracks = get_rus_top_today_page(page, session, logger)
        if not page_tracks:
            break

        added_on_page = 0
        for raw in page_tracks:
            track_id = raw.get("id")
            if not track_id or track_id in seen_ids:
                continue
            seen_ids.add(track_id)
            result.append(raw)
            added_on_page += 1
            if len(result) >= requested:
                return result

        logger.info("  [rus-today] стр. %s: +%s треков", page, added_on_page)
        # Если страница полностью дублируется, дальше идти бессмысленно.
        if added_on_page == 0:
            break
        sleep_with_jitter(delay)

    return result


def get_genre_page(
    genre_slug: str,
    page: int,
    session: requests.Session,
    logger: logging.Logger,
) -> dict | None:
    """Возвращает paginated объект items для страницы жанра."""
    url = f"{BASE_URL}/genre/{genre_slug}?page={page}"
    data = fetch_inertia_data(url, session, logger)
    if not data:
        return None
    return data.get("props", {}).get("items")


# ─── Нормализация трека ────────────────────────────────────────────────────────

def normalize_track(
    raw: dict,
    genre_name: str | None = None,
    genre_slug: str | None = None,
    *,
    in_top_chart: bool = False,
) -> dict:
    """Преобразует сырые данные трека в единый формат."""
    album = raw.get("album") or {}

    genres = [normalize_text(genre_name)] if genre_name and genre_name != TOP_CHART_TAG else []
    genre_slugs = [normalize_text(genre_slug)] if genre_slug and genre_slug != "top" else []

    return upgrade_track_record(
        {
            "id": raw.get("id"),
            "title": normalize_text(raw.get("name")),
            "artist": normalize_text(raw.get("performers")),
            "genres": genres,
            "genre_slugs": genre_slugs,
            "album": normalize_text(album.get("name")),
            "year": album.get("year", ""),
            "duration_sec": int(raw.get("duration") or 0),
            "cover_url": raw.get("cover") or album.get("cover", ""),
            "cover_local": "",
            "download_url": raw.get("download", ""),
            "track_url": normalize_text(raw.get("track_url")) or f"{BASE_URL}/song/{raw.get('id')}",
            "in_top_chart": in_top_chart,
            "audio_local": "",
            "library_track_id": None,
            "library_status": "",
            "library_file_path": "",
            "library_cover_url": "",
        }
    )


def merge_track(existing: dict, new: dict) -> dict:
    """Объединяет жанры и дополнительные данные, если трек уже есть в базе."""
    existing = upgrade_track_record(existing)
    new = upgrade_track_record(new)

    existing["genres"] = dedupe_preserve_order(existing["genres"] + new["genres"])
    existing["genre_slugs"] = dedupe_preserve_order(existing["genre_slugs"] + new["genre_slugs"])
    existing["in_top_chart"] = existing.get("in_top_chart", False) or new.get("in_top_chart", False)

    for key in ("cover_url", "download_url", "track_url", "album", "year"):
        if not existing.get(key) and new.get(key):
            existing[key] = new[key]

    if not existing.get("duration_sec") and new.get("duration_sec"):
        existing["duration_sec"] = new["duration_sec"]
    if not existing.get("cover_local") and new.get("cover_local"):
        existing["cover_local"] = new["cover_local"]
    if not existing.get("audio_local") and new.get("audio_local"):
        existing["audio_local"] = new["audio_local"]
    if not existing.get("library_track_id") and new.get("library_track_id"):
        existing["library_track_id"] = new["library_track_id"]

    existing["primary_genre"] = get_primary_genre(existing)
    return existing


# ─── Скачивание файлов ────────────────────────────────────────────────────────

def download_cover(
    track_id: int,
    cover_url: str,
    covers_dir: Path,
    session: requests.Session,
    logger: logging.Logger,
    delay: float,
) -> str:
    """Скачивает обложку и возвращает локальный путь. Пропускает уже скачанные."""
    if not cover_url:
        return ""

    for ext in (".jpg", ".jpeg", ".webp", ".png"):
        candidate = covers_dir / f"{track_id}{ext}"
        if candidate.exists():
            return str(candidate)

    response = request_with_retry(
        cover_url,
        session,
        logger,
        stream=True,
        referer=BASE_URL,
    )
    if not response:
        return ""

    try:
        ext = detect_extension_from_response(response, fallback=".jpg")
        path = covers_dir / f"{track_id}{ext}"
        temp_path = path.with_suffix(f"{path.suffix}.part")
        with open(temp_path, "wb") as file_obj:
            for chunk in response.iter_content(8192):
                if chunk:
                    file_obj.write(chunk)
        temp_path.replace(path)
        sleep_with_jitter(delay * 0.5)
        return str(path)
    except Exception as exc:
        logger.warning(f"Не удалось скачать обложку трека {track_id}: {exc}")
        return ""
    finally:
        response.close()


def download_track_audio(
    track: dict,
    tracks_dir: Path,
    session: requests.Session,
    logger: logging.Logger,
    delay: float,
) -> str:
    """Скачивает аудиофайл и возвращает локальный путь."""
    track_id = track["id"]
    download_url = track.get("download_url") or ""

    for ext in (".mp3", ".m4a", ".aac", ".ogg", ".wav", ".flac"):
        candidate = tracks_dir / f"{track_id}{ext}"
        if candidate.exists():
            return str(candidate)

    if should_refresh_download_url(download_url):
        download_url = refresh_track_download_url(track, session, logger)

    if not download_url or should_refresh_download_url(download_url):
        logger.warning("У трека %s не удалось получить download_url", track_id)
        return ""

    response = request_with_retry(
        download_url,
        session,
        logger,
        stream=True,
        referer=track.get("track_url") or BASE_URL,
    )
    if not response and download_url == track.get("download_url"):
        fresh_url = refresh_track_download_url(track, session, logger)
        if fresh_url and fresh_url != download_url:
            response = request_with_retry(
                fresh_url,
                session,
                logger,
                stream=True,
                referer=track.get("track_url") or BASE_URL,
                max_attempts=3,
            )
    if not response:
        return ""

    try:
        ext = detect_extension_from_response(response, fallback=".mp3")
        path = tracks_dir / f"{track_id}{ext}"
        temp_path = path.with_suffix(f"{path.suffix}.part")
        bytes_written = 0
        with open(temp_path, "wb") as file_obj:
            for chunk in response.iter_content(16384):
                if not chunk:
                    continue
                file_obj.write(chunk)
                bytes_written += len(chunk)

        if bytes_written == 0:
            temp_path.unlink(missing_ok=True)
            logger.warning("Файл трека %s оказался пустым", track_id)
            return ""

        temp_path.replace(path)
        sleep_with_jitter(delay)
        return str(path)
    except Exception as exc:
        logger.warning(f"Не удалось скачать трек {track_id}: {exc}")
        return ""
    finally:
        response.close()


def ensure_cover_downloaded(
    track: dict,
    covers_dir: Path | None,
    session: requests.Session,
    logger: logging.Logger,
    delay: float,
):
    if (
        covers_dir
        and track.get("cover_url")
        and (not track.get("cover_local") or not Path(track["cover_local"]).exists())
    ):
        track["cover_local"] = download_cover(
            track["id"],
            track["cover_url"],
            covers_dir,
            session,
            logger,
            delay,
        )


def copy_to_library(source_path: str, target_dir: Path, target_stem: str) -> str:
    source = Path(source_path)
    if not source.exists():
        return ""
    target_dir.mkdir(parents=True, exist_ok=True)
    suffix = source.suffix.lower() or ".bin"
    target = target_dir / f"{target_stem}{suffix}"
    if not target.exists():
        shutil.copy2(source, target)
    return target.name


# ─── Сохранение ───────────────────────────────────────────────────────────────

CSV_FIELDS = [
    "id",
    "title",
    "artist",
    "primary_genre",
    "genres",
    "genre_slugs",
    "album",
    "year",
    "duration_sec",
    "in_top_chart",
    "cover_url",
    "cover_local",
    "download_url",
    "audio_local",
    "library_track_id",
    "library_status",
    "library_file_path",
    "library_cover_url",
    "track_url",
]


def save_database(db: dict[int, dict], output_dir: Path, logger: logging.Logger):
    """Сохраняет базу треков в JSON и CSV."""
    tracks = []
    for track in db.values():
        upgraded = upgrade_track_record(track)
        upgraded["primary_genre"] = get_primary_genre(upgraded)
        tracks.append(upgraded)

    tracks.sort(key=lambda item: ((item["artist"] or "").casefold(), (item["title"] or "").casefold()))

    json_path = output_dir / "tracks.json"
    with open(json_path, "w", encoding="utf-8") as file_obj:
        json.dump(tracks, file_obj, ensure_ascii=False, indent=2)

    csv_path = output_dir / "tracks.csv"
    with open(csv_path, "w", encoding="utf-8-sig", newline="") as file_obj:
        writer = csv.DictWriter(file_obj, fieldnames=CSV_FIELDS, extrasaction="ignore")
        writer.writeheader()
        for track in tracks:
            row = dict(track)
            row["genres"] = "; ".join(track.get("genres", []))
            row["genre_slugs"] = "; ".join(track.get("genre_slugs", []))
            writer.writerow(row)

    logger.info(f"Сохранено {len(tracks)} треков → {json_path}, {csv_path}")


def load_database(output_dir: Path) -> dict[int, dict]:
    """Загружает существующую базу треков (для продолжения/докачки)."""
    json_path = output_dir / "tracks.json"
    if not json_path.exists():
        return {}
    with open(json_path, encoding="utf-8") as file_obj:
        try:
            tracks = json.load(file_obj)
            return {track["id"]: upgrade_track_record(track) for track in tracks}
        except (json.JSONDecodeError, KeyError):
            return {}


# ─── Прогресс ─────────────────────────────────────────────────────────────────

def load_progress(output_dir: Path) -> dict:
    path = output_dir / "progress.json"
    if path.exists():
        with open(path, encoding="utf-8") as file_obj:
            return json.load(file_obj)
    return {"done_genres": [], "started_at": datetime.now().isoformat()}


def save_progress(progress: dict, output_dir: Path):
    path = output_dir / "progress.json"
    progress["updated_at"] = datetime.now().isoformat()
    with open(path, "w", encoding="utf-8") as file_obj:
        json.dump(progress, file_obj, ensure_ascii=False, indent=2)


# ─── Импорт в библиотеку ──────────────────────────────────────────────────────

async def sync_library_direct(
    tracks: list[dict],
    database_url: str,
    library_music_dir: Path,
    library_cover_dir: Path,
    logger: logging.Logger,
) -> tuple[int, int, int]:
    try:
        sqlalchemy = importlib.import_module("sqlalchemy")
        sqlalchemy_asyncio = importlib.import_module("sqlalchemy.ext.asyncio")
    except ModuleNotFoundError as exc:
        raise RuntimeError(
            "Для режима direct нужен установленный SQLAlchemy/asyncpg "
            "(обычно достаточно backend/requirements.txt)."
        ) from exc

    text = sqlalchemy.text
    async_sessionmaker = sqlalchemy_asyncio.async_sessionmaker
    create_async_engine = sqlalchemy_asyncio.create_async_engine

    library_music_dir.mkdir(parents=True, exist_ok=True)
    library_cover_dir.mkdir(parents=True, exist_ok=True)

    engine = create_async_engine(database_url, pool_pre_ping=True)
    session_maker = async_sessionmaker(bind=engine, expire_on_commit=False)

    created = 0
    updated = 0
    skipped = 0

    try:
        async with session_maker() as db:
            for track in tracks:
                audio_local = track.get("audio_local")
                if not audio_local or not Path(audio_local).exists():
                    track["library_status"] = "missing-audio"
                    skipped += 1
                    continue

                music_name = copy_to_library(
                    audio_local,
                    library_music_dir,
                    f"hitmotop-{track['id']}",
                )
                if not music_name:
                    track["library_status"] = "copy-failed"
                    skipped += 1
                    continue

                file_path = f"/music_files/{music_name}"
                cover_url = track.get("cover_url") or None

                if track.get("cover_local") and Path(track["cover_local"]).exists():
                    cover_name = copy_to_library(
                        track["cover_local"],
                        library_cover_dir,
                        f"hitmotop-{track['id']}",
                    )
                    if cover_name:
                        cover_url = f"/cover_files/{cover_name}"

                primary_genre = get_primary_genre(track) or None
                duration = int(track.get("duration_sec") or 0)
                lookup_params = {
                    "track_id": track.get("library_track_id"),
                    "title": normalize_text(track.get("title")).lower(),
                    "artist": normalize_text(track.get("artist")).lower(),
                    "album": normalize_text(track.get("album")).lower(),
                }

                result = await db.execute(
                    text(
                        """
                        SELECT id, title, artist, album, duration, file_path, cover_url, genre
                        FROM tracks
                        WHERE (:track_id IS NOT NULL AND id = :track_id)
                           OR (
                               lower(title) = :title
                               AND lower(artist) = :artist
                               AND coalesce(lower(album), '') = :album
                           )
                        ORDER BY CASE WHEN id = :track_id THEN 0 ELSE 1 END
                        LIMIT 1
                        """
                    ),
                    lookup_params,
                )
                existing = result.mappings().first()

                if existing:
                    created_by_scraper = str(existing["file_path"] or "").startswith("/music_files/hitmotop-")
                    new_file_path = file_path if created_by_scraper else existing["file_path"]
                    new_cover_url = existing["cover_url"] or cover_url
                    new_genre = existing["genre"] or primary_genre
                    new_duration = existing["duration"] or duration

                    if (
                        new_file_path != existing["file_path"]
                        or new_cover_url != existing["cover_url"]
                        or new_genre != existing["genre"]
                        or new_duration != existing["duration"]
                    ):
                        await db.execute(
                            text(
                                """
                                UPDATE tracks
                                SET duration = :duration,
                                    file_path = :file_path,
                                    cover_url = :cover_url,
                                    genre = :genre
                                WHERE id = :id
                                """
                            ),
                            {
                                "id": existing["id"],
                                "duration": new_duration,
                                "file_path": new_file_path,
                                "cover_url": new_cover_url,
                                "genre": new_genre,
                            },
                        )
                        updated += 1
                        track["library_status"] = "updated"
                    else:
                        track["library_status"] = "exists"

                    track["library_track_id"] = existing["id"]
                    track["library_file_path"] = new_file_path
                    track["library_cover_url"] = new_cover_url or ""
                    continue

                insert_result = await db.execute(
                    text(
                        """
                        INSERT INTO tracks (title, artist, album, duration, file_path, cover_url, genre, play_count)
                        VALUES (:title, :artist, :album, :duration, :file_path, :cover_url, :genre, 0)
                        RETURNING id
                        """
                    ),
                    {
                        "title": normalize_text(track.get("title")),
                        "artist": normalize_text(track.get("artist")),
                        "album": normalize_text(track.get("album")) or None,
                        "duration": duration,
                        "file_path": file_path,
                        "cover_url": cover_url,
                        "genre": primary_genre,
                    },
                )
                new_track_id = insert_result.scalar_one()
                created += 1
                track["library_track_id"] = new_track_id
                track["library_status"] = "created"
                track["library_file_path"] = file_path
                track["library_cover_url"] = cover_url or ""

            await db.commit()
    finally:
        await engine.dispose()

    logger.info(
        "Импорт в библиотеку завершён (direct): %s создано, %s обновлено, %s пропущено",
        created,
        updated,
        skipped,
    )
    return created, updated, skipped


def fetch_existing_track_from_api(
    api_base: str,
    api_session: requests.Session,
    track: dict,
    logger: logging.Logger,
) -> dict | None:
    try:
        response = api_session.get(
            f"{api_base}/tracks",
            params={"artist": track.get("artist", ""), "limit": 200},
            timeout=20,
        )
        response.raise_for_status()
        items = response.json()
    except Exception as exc:
        logger.warning("Не удалось проверить наличие трека '%s - %s' через API: %s", track.get("artist"), track.get("title"), exc)
        return None

    target_title = normalize_text(track.get("title")).casefold()
    target_artist = normalize_text(track.get("artist")).casefold()
    target_album = normalize_text(track.get("album")).casefold()
    for item in items:
        if (
            normalize_text(item.get("title")).casefold() == target_title
            and normalize_text(item.get("artist")).casefold() == target_artist
            and normalize_text(item.get("album")).casefold() == target_album
        ):
            return item
    return None


def sync_library_via_api(
    tracks: list[dict],
    api_base: str,
    auth_token: str,
    logger: logging.Logger,
) -> tuple[int, int, int]:
    created = 0
    updated = 0
    skipped = 0

    api_session = requests.Session()
    api_session.headers.update({"Authorization": f"Bearer {auth_token}"})

    for track in tracks:
        audio_local = track.get("audio_local")
        if not audio_local or not Path(audio_local).exists():
            track["library_status"] = "missing-audio"
            skipped += 1
            continue

        existing = fetch_existing_track_from_api(api_base, api_session, track, logger)
        if existing:
            track["library_track_id"] = existing.get("id")
            track["library_status"] = "exists"
            track["library_file_path"] = existing.get("file_path", "")
            track["library_cover_url"] = existing.get("cover_url") or ""

            if track.get("cover_local") and not existing.get("cover_url"):
                try:
                    with open(track["cover_local"], "rb") as cover_file:
                        response = api_session.post(
                            f"{api_base}/tracks/{existing['id']}/cover",
                            files={"cover": (Path(track["cover_local"]).name, cover_file, "image/webp")},
                            timeout=60,
                        )
                        response.raise_for_status()
                        payload = response.json()
                        track["library_cover_url"] = payload.get("cover_url") or ""
                        updated += 1
                except Exception as exc:
                    logger.warning("Не удалось загрузить обложку для track_id=%s через API: %s", existing["id"], exc)
            continue

        data = {
            "title": normalize_text(track.get("title")),
            "artist": normalize_text(track.get("artist")),
            "album": normalize_text(track.get("album")),
            "genre": get_primary_genre(track),
            "duration": str(int(track.get("duration_sec") or 0)),
        }

        files: dict[str, tuple] = {}
        try:
            with open(audio_local, "rb") as audio_file:
                files["file"] = (
                    Path(audio_local).name,
                    audio_file,
                    mimetypes.guess_type(audio_local)[0] or "audio/mpeg",
                )
                if track.get("cover_local") and Path(track["cover_local"]).exists():
                    cover_mime = mimetypes.guess_type(track["cover_local"])[0] or "image/webp"
                    cover_file = open(track["cover_local"], "rb")
                    try:
                        files["cover"] = (
                            Path(track["cover_local"]).name,
                            cover_file,
                            cover_mime,
                        )
                        response = api_session.post(
                            f"{api_base}/tracks/upload",
                            data=data,
                            files=files,
                            timeout=180,
                        )
                        response.raise_for_status()
                    finally:
                        cover_file.close()
                else:
                    response = api_session.post(
                        f"{api_base}/tracks/upload",
                        data=data,
                        files=files,
                        timeout=180,
                    )
                    response.raise_for_status()

            payload = response.json()
            track["library_track_id"] = payload.get("id")
            track["library_status"] = "created"
            track["library_file_path"] = payload.get("file_path", "")
            track["library_cover_url"] = payload.get("cover_url") or ""
            created += 1
        except Exception as exc:
            logger.warning("Не удалось импортировать '%s - %s' через API: %s", track.get("artist"), track.get("title"), exc)
            track["library_status"] = "api-error"
            skipped += 1

    logger.info(
        "Импорт в библиотеку завершён (api): %s создано, %s обновлено, %s пропущено",
        created,
        updated,
        skipped,
    )
    return created, updated, skipped


def sync_library_via_docker(
    output_dir: Path,
    backend_container: str,
    import_dir_in_container: str,
    import_script_in_container: str,
    logger: logging.Logger,
) -> tuple[int, int, int]:
    if not shutil.which("docker"):
        raise RuntimeError("Команда 'docker' не найдена, docker-импорт невозможен.")

    output_dir = output_dir.resolve()

    def run_command(args: list[str], description: str) -> subprocess.CompletedProcess[str]:
        completed = subprocess.run(
            args,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        if completed.returncode != 0:
            stderr = (completed.stderr or completed.stdout or "").strip()
            raise RuntimeError(f"{description}: {stderr}")
        return completed

    quoted_import_dir = shlex.quote(import_dir_in_container)
    run_command(
        ["docker", "exec", backend_container, "sh", "-lc", f"rm -rf {quoted_import_dir}"],
        "Не удалось очистить временную папку импорта в Docker",
    )
    run_command(
        ["docker", "cp", str(output_dir), f"{backend_container}:{import_dir_in_container}"],
        "Не удалось скопировать scraped_data в Docker-контейнер",
    )
    completed = run_command(
        [
            "docker",
            "exec",
            backend_container,
            "python",
            import_script_in_container,
            "--data-dir",
            import_dir_in_container,
        ],
        "Не удалось выполнить импорт треков в Docker-контейнере",
    )

    output = (completed.stdout or "").strip()
    logger.info("Импорт в библиотеку завершён (docker): %s", output or "без вывода")
    match = re.search(r"created=(\d+)\s+updated=(\d+)\s+skipped=(\d+)", output)
    if not match:
        return 0, 0, 0
    return tuple(int(value) for value in match.groups())


def process_downloads_and_library(
    db: dict[int, dict],
    session: requests.Session,
    output_dir: Path,
    tracks_dir: Path | None,
    covers_dir: Path | None,
    args,
    logger: logging.Logger,
):
    hydrated_tracks = []
    for track in db.values():
        upgraded = upgrade_track_record(track)
        hydrate_local_media_paths(upgraded, output_dir, tracks_dir, covers_dir)
        hydrated_tracks.append(upgraded)

    tracks = sorted(
        hydrated_tracks,
        key=lambda item: (
            should_refresh_download_url(item.get("download_url") or ""),
            not bool(get_primary_genre(item)),
            (item.get("artist") or "").casefold(),
            (item.get("title") or "").casefold(),
        ),
    )

    if tracks_dir and args.download_tracks:
        downloaded = 0
        for index, track in enumerate(tracks, start=1):
            ensure_cover_downloaded(track, covers_dir, session, logger, args.delay)

            audio_local = track.get("audio_local")
            if audio_local and Path(audio_local).exists():
                continue

            logger.info(
                "[%s/%s] Скачивание: %s - %s",
                index,
                len(tracks),
                track.get("artist"),
                track.get("title"),
            )
            local_path = download_track_audio(track, tracks_dir, session, logger, args.delay)
            if local_path:
                track["audio_local"] = local_path
                downloaded += 1

            if downloaded and downloaded % 20 == 0:
                save_database(db, output_dir, logger)

        logger.info("Скачивание аудио завершено: %s новых файлов", downloaded)
        save_database(db, output_dir, logger)

    if not args.import_to_library:
        return

    if args.library_mode == "api":
        if not args.auth_token:
            logger.error("Для режима --library-mode api нужен --auth-token")
            return
        sync_library_via_api(tracks, args.library_api_base.rstrip("/"), args.auth_token, logger)
    elif args.library_mode == "docker":
        try:
            sync_library_via_docker(
                output_dir,
                args.docker_backend_container,
                args.docker_import_dir,
                args.docker_import_script,
                logger,
            )
        except RuntimeError as exc:
            logger.error(str(exc))
            return
    else:
        asyncio.run(
            sync_library_direct(
                tracks,
                args.database_url,
                Path(args.library_music_dir),
                Path(args.library_cover_dir),
                logger,
            )
        )

    for track in tracks:
        db[track["id"]] = track
    save_database(db, output_dir, logger)


# ─── Основная логика скрапинга ────────────────────────────────────────────────

def scrape_genre(
    genre: dict,
    session: requests.Session,
    db: dict[int, dict],
    covers_dir: Path | None,
    max_pages: int,
    delay: float,
    logger: logging.Logger,
) -> int:
    """
    Скрапит все треки жанра постранично.
    Возвращает количество новых/обновлённых треков.
    """
    slug = genre["slug"]
    name = genre["name"]
    count = 0
    page = 1

    while True:
        if max_pages and page > max_pages:
            break

        items = get_genre_page(slug, page, session, logger)
        if not items or not items.get("data"):
            break

        last_page = items.get("last_page", 1)
        total = items.get("total", 0)
        logger.info(f"  [{name}] стр. {page}/{last_page} (всего ~{total} треков)")

        for raw in items["data"]:
            track = normalize_track(raw, name, slug)
            tid = track["id"]

            if tid in db:
                db[tid] = merge_track(db[tid], track)
            else:
                db[tid] = track
                count += 1

            ensure_cover_downloaded(db[tid], covers_dir, session, logger, delay)

        if page >= last_page:
            break

        page += 1
        sleep_with_jitter(delay)

    logger.info(f"  [{name}] готово: +{count} новых треков")
    return count


def scrape_top_chart(
    session: requests.Session,
    db: dict[int, dict],
    covers_dir: Path | None,
    top_limit: int,
    top_source: str,
    delay: float,
    logger: logging.Logger,
) -> int:
    """Добавляет top_limit треков из чарта, не назначая ему роль основного жанра."""
    logger.info("Скрапинг top-%s (%s)...", top_limit, top_source)
    raw_tracks = get_top_tracks(top_limit, session, logger, delay, top_source=top_source)
    count = 0

    for raw in raw_tracks:
        track = normalize_track(raw, in_top_chart=True)
        tid = track["id"]
        if tid in db:
            db[tid] = merge_track(db[tid], track)
        else:
            db[tid] = track
            count += 1

        ensure_cover_downloaded(db[tid], covers_dir, session, logger, delay)

    logger.info("Топ-%s (%s): +%s новых треков", top_limit, top_source, count)
    return count


# ─── CLI ──────────────────────────────────────────────────────────────────────

def parse_args():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(
        description="Парсер треков с hitmotop.me",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--genres",
        nargs="*",
        metavar="SLUG",
        help="Слаги жанров (напр.: rusrap ruspop rock). По умолчанию — все.",
    )
    parser.add_argument(
        "--max-pages",
        type=int,
        default=1,
        metavar="N",
        help="Макс. страниц на жанр (50 треков/страница). 0 = без лимита. По умолчанию: 1.",
    )
    parser.add_argument(
        "--top-only",
        action="store_true",
        help="Скачать только top-N чарт, не трогать жанры.",
    )
    parser.add_argument(
        "--top-limit",
        type=int,
        default=100,
        metavar="N",
        help="Сколько треков брать из топа (по умолчанию: 100, можно 500).",
    )
    parser.add_argument(
        "--top-source",
        choices=("global", "rus-today"),
        default="global",
        help="Источник топа: global (/songs/top + /songs) или rus-today (rus.hitmotop.com/songs/top-today).",
    )
    parser.add_argument(
        "--download-covers",
        action="store_true",
        help="Скачать обложки в папку scraped_data/covers/.",
    )
    parser.add_argument(
        "--download-tracks",
        action="store_true",
        help="Скачать аудиофайлы в папку scraped_data/audio/.",
    )
    parser.add_argument(
        "--import-to-library",
        action="store_true",
        help="Импортировать скачанные треки в библиотеку сервиса.",
    )
    parser.add_argument(
        "--library-mode",
        choices=("direct", "api", "docker"),
        default="docker",
        help=(
            "Способ импорта в библиотеку: "
            "direct = копирование в music_files + запись в БД, "
            "api = загрузка через backend API, "
            "docker = импорт в running music_backend через docker cp/exec."
        ),
    )
    parser.add_argument(
        "--database-url",
        default=DEFAULT_DATABASE_URL,
        help=f"URL БД для режима direct (по умолчанию: {DEFAULT_DATABASE_URL}).",
    )
    parser.add_argument(
        "--library-music-dir",
        default=str(DEFAULT_LIBRARY_MUSIC_DIR),
        help="Папка music_files для режима direct.",
    )
    parser.add_argument(
        "--library-cover-dir",
        default=str(DEFAULT_LIBRARY_COVER_DIR),
        help="Папка cover_files для режима direct.",
    )
    parser.add_argument(
        "--library-api-base",
        default=DEFAULT_LIBRARY_API_BASE,
        help="Базовый URL backend API для режима api (по умолчанию: http://localhost:8000/api).",
    )
    parser.add_argument(
        "--auth-token",
        default=os.getenv("LIBRARY_AUTH_TOKEN", ""),
        help="Bearer token для режима api.",
    )
    parser.add_argument(
        "--docker-backend-container",
        default=DEFAULT_DOCKER_BACKEND_CONTAINER,
        help="Имя backend-контейнера для режима docker.",
    )
    parser.add_argument(
        "--docker-import-dir",
        default=DEFAULT_DOCKER_IMPORT_DIR,
        help="Временная папка внутри backend-контейнера для режима docker.",
    )
    parser.add_argument(
        "--docker-import-script",
        default=DEFAULT_DOCKER_IMPORT_SCRIPT,
        help="Путь к helper-скрипту импорта внутри backend-контейнера.",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=0.9,
        metavar="SEC",
        help="Базовая задержка между запросами в секундах, к ней добавляется jitter (по умолчанию: 0.9).",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Продолжить с места остановки (пропустить уже скрапленные жанры).",
    )
    parser.add_argument(
        "--output",
        default="scraped_data",
        metavar="DIR",
        help="Папка для сохранения данных (по умолчанию: scraped_data).",
    )
    parser.add_argument(
        "--list-genres",
        action="store_true",
        help="Вывести список всех жанров и выйти.",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    output_dir = Path(args.output)
    logger = setup_logging(output_dir)

    session = requests.Session()
    session.headers.update(
        {
            "Accept": (
                "text/html,application/xhtml+xml,application/xml;q=0.9,"
                "image/avif,image/webp,*/*;q=0.8"
            ),
            "Connection": "keep-alive",
        }
    )

    covers_dir = None
    if args.download_covers or args.import_to_library:
        covers_dir = output_dir / "covers"
        covers_dir.mkdir(parents=True, exist_ok=True)

    tracks_dir = None
    if args.download_tracks or args.import_to_library:
        tracks_dir = output_dir / "audio"
        tracks_dir.mkdir(parents=True, exist_ok=True)

    if args.list_genres:
        genres = get_all_genres(session, logger)
        sys.stdout.reconfigure(encoding="utf-8")
        print(f"\n{'Слаг':<30} {'Название'}")
        print("-" * 60)
        for genre in genres:
            print(f"{genre['slug']:<30} {genre['name']}")
        return

    db = load_database(output_dir)
    logger.info(f"В базе уже {len(db)} треков")

    progress = load_progress(output_dir) if args.resume else {"done_genres": []}
    total_new = 0

    top_progress_key = f"top_{args.top_source}_{max(1, args.top_limit)}"
    if (top_progress_key not in progress["done_genres"]) and (
        not (args.top_source == "global" and args.top_limit == 100 and "top" in progress["done_genres"])
    ):
        total_new += scrape_top_chart(session, db, covers_dir, args.top_limit, args.top_source, args.delay, logger)
        progress["done_genres"].append(top_progress_key)
        # Backward compatibility with old progress format.
        if args.top_source == "global" and args.top_limit == 100 and "top" not in progress["done_genres"]:
            progress["done_genres"].append("top")
        save_database(db, output_dir, logger)
        save_progress(progress, output_dir)

    if not args.top_only:
        all_genres = get_all_genres(session, logger)

        if args.genres:
            genres_to_scrape = [genre for genre in all_genres if genre["slug"] in args.genres]
            missing = set(args.genres) - {genre["slug"] for genre in genres_to_scrape}
            if missing:
                logger.warning(f"Жанры не найдены: {', '.join(missing)}")
        else:
            genres_to_scrape = all_genres

        if args.resume:
            done = set(progress.get("done_genres", []))
            genres_to_scrape = [genre for genre in genres_to_scrape if genre["slug"] not in done]
            logger.info(f"Продолжение: осталось {len(genres_to_scrape)} жанров")

        for index, genre in enumerate(genres_to_scrape, 1):
            logger.info(f"[{index}/{len(genres_to_scrape)}] Жанр: {genre['name']} ({genre['slug']})")

            new = scrape_genre(
                genre,
                session,
                db,
                covers_dir,
                max_pages=args.max_pages,
                delay=args.delay,
                logger=logger,
            )
            total_new += new

            progress["done_genres"].append(genre["slug"])
            save_progress(progress, output_dir)
            save_database(db, output_dir, logger)
            sleep_with_jitter(args.delay)
    else:
        logger.info("Режим --top-only: жанры пропущены.")

    if tracks_dir or args.import_to_library:
        process_downloads_and_library(
            db,
            session,
            output_dir,
            tracks_dir,
            covers_dir,
            args,
            logger,
        )

    logger.info("=" * 60)
    logger.info(f"Готово! Новых треков в этом сеансе: {total_new}")
    logger.info(f"Итого в базе: {len(db)} уникальных треков")
    logger.info(f"Файлы: {output_dir / 'tracks.json'}, {output_dir / 'tracks.csv'}")


if __name__ == "__main__":
    main()
