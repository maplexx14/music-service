"""Превью ссылок на трек в мессенджерах (Open Graph).

Ссылка из «Поделиться» — /track/{id} — это маршрут SPA, а её index.html одинаков
для всех путей: боты Telegram/WhatsApp/iMessage JS не исполняют и видели бы
общую заглушку. Основной nginx отдаёт /track/{id} сюда: берём тот же index.html
у фронтенд-контейнера и дописываем в <head> мета-теги трека. Браузер получает
обычное приложение (react-router дальше разбирается сам), бот — карточку с
обложкой и названием. Без разбора User-Agent: список ботов всегда неполон.

Если index.html не достать — 502, и nginx отдаёт страницу как раньше, через
фронтенд (error_page в snippets/app-locations.conf): ссылка без превью лучше
неоткрывающейся ссылки.
"""
import html
import logging
import os
import time

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.email_verification import PUBLIC_URL
from app.models import Track

logger = logging.getLogger(__name__)

router = APIRouter()

FRONTEND_INTERNAL_URL = os.getenv("FRONTEND_INTERNAL_URL", "http://frontend:3000").rstrip("/")
SITE_NAME = "bolt"

# index.html меняется только с деплоем фронтенда. Минута кэша снимает поход во
# фронтенд-контейнер с каждого бота и почти не задерживает новый билд.
_INDEX_TTL = 60.0
_index_cache: dict = {"html": None, "at": 0.0}


async def _load_index() -> str:
    now = time.monotonic()
    if _index_cache["html"] and now - _index_cache["at"] < _INDEX_TTL:
        return _index_cache["html"]
    async with httpx.AsyncClient(timeout=3.0) as client:
        resp = await client.get(f"{FRONTEND_INTERNAL_URL}/index.html")
        resp.raise_for_status()
    _index_cache["html"] = resp.text
    _index_cache["at"] = now
    return resp.text


def _absolute_cover(cover_url: str | None) -> str | None:
    """og:image обязан быть абсолютным: бот не знает, от чего считать путь."""
    if not cover_url:
        return None
    if cover_url.startswith(("http://", "https://")):
        return cover_url
    return f"{PUBLIC_URL}/{cover_url.lstrip('/')}"


def _format_duration(seconds: int | None) -> str | None:
    if not seconds or seconds <= 0:
        return None
    return f"{seconds // 60}:{seconds % 60:02d}"


def track_meta_tags(track: Track) -> str:
    title = f"{track.artist} — {track.title}" if track.artist else track.title
    details = [part for part in (track.album, _format_duration(track.duration)) if part]
    description = " · ".join(["Слушать в bolt", *details])
    url = f"{PUBLIC_URL}/track/{track.id}"
    image = _absolute_cover(track.cover_url)

    tags = [
        ("property", "og:type", "music.song"),
        ("property", "og:site_name", SITE_NAME),
        ("property", "og:title", title),
        ("property", "og:description", description),
        ("property", "og:url", url),
        ("name", "description", description),
        ("name", "twitter:card", "summary_large_image" if image else "summary"),
        ("name", "twitter:title", title),
        ("name", "twitter:description", description),
    ]
    if track.duration:
        tags.append(("property", "music:duration", str(track.duration)))
    if image:
        tags += [
            ("property", "og:image", image),
            ("property", "og:image:alt", title),
            ("name", "twitter:image", image),
        ]
    lines = [
        f'<meta {attr}="{key}" content="{html.escape(value, quote=True)}">'
        for attr, key, value in tags
    ]
    lines.append(f'<link rel="canonical" href="{html.escape(url, quote=True)}">')
    return "\n    ".join(lines)


def inject_track_meta(index_html: str, track: Track) -> str:
    """Мета-теги — сразу за <head>, заголовок вкладки — название трека."""
    title = f"{track.artist} — {track.title}" if track.artist else track.title
    page = index_html.replace("<head>", f"<head>\n    {track_meta_tags(track)}", 1)
    start = page.find("<title>")
    end = page.find("</title>", start)
    if start != -1 and end != -1:
        page = f"{page[:start]}<title>{html.escape(title)} · {SITE_NAME}</title>{page[end + len('</title>'):]}"
    return page


@router.get("/track/{track_id}", response_class=HTMLResponse, include_in_schema=False)
async def share_track_page(track_id: int, db: Session = Depends(get_db)):
    try:
        index_html = await _load_index()
    except httpx.HTTPError as exc:
        logger.warning("share: index.html недоступен: %s", exc)
        raise HTTPException(status_code=502, detail="Frontend unavailable") from exc

    track = db.query(Track).filter(Track.id == track_id).first()
    # Нет трека — обычная страница без превью: «Трек не найден» покажет SPA.
    page = inject_track_meta(index_html, track) if track else index_html
    # Как у index.html во фронтенд-nginx: он ссылается на хэшированные бандлы,
    # и закэшированная копия после деплоя тянула бы удалённые файлы.
    return HTMLResponse(page, headers={"Cache-Control": "no-store"})
