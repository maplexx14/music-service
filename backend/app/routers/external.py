import logging
import os
from typing import List

import httpx
from fastapi import APIRouter, Query

from app.schemas import ExternalTrackResponse

logger = logging.getLogger(__name__)

router = APIRouter()

JAMENDO_API_URL = "https://api.jamendo.com/v3.0/tracks/"
JAMENDO_TIMEOUT = 8.0

# Общий клиент на модуль: новый AsyncClient на каждый запрос = свежий TCP+TLS
# хендшейк к Jamendo под каждым поиском. Keep-alive пул переживает запросы.
_client = httpx.AsyncClient(timeout=JAMENDO_TIMEOUT)


def normalize_jamendo_track(track: dict) -> ExternalTrackResponse | None:
    external_id = str(track.get("id") or "")
    stream_url = track.get("audio") or track.get("audiodownload")
    title = track.get("name") or ""
    artist = track.get("artist_name") or "Unknown Artist"

    if not external_id or not stream_url or not title:
        return None

    album = track.get("album_name") or None
    cover_url = track.get("album_image") or track.get("image") or None
    download_url = track.get("audiodownload") or None
    download_allowed_value = track.get("audiodownload_allowed")
    download_allowed = (
        str(download_allowed_value).lower() in {"1", "true", "yes"}
        and bool(download_url)
    )

    try:
        duration = int(track.get("duration") or 0)
    except (TypeError, ValueError):
        duration = 0

    return ExternalTrackResponse(
        id=f"jamendo:{external_id}",
        source="jamendo",
        external_id=external_id,
        title=title,
        artist=artist,
        album=album,
        duration=duration,
        cover_url=cover_url,
        stream_url=stream_url,
        download_url=download_url if download_allowed else None,
        download_allowed=download_allowed,
    )


@router.get("/search", response_model=List[ExternalTrackResponse])
async def search_external_tracks(
    q: str = Query(..., min_length=1),
    limit: int = Query(20, ge=1, le=50),
):
    jamendo_client_id = os.getenv("JAMENDO_CLIENT_ID")
    if not jamendo_client_id:
        return []

    params = {
        "client_id": jamendo_client_id,
        "format": "json",
        "limit": limit,
        "search": q,
        "audioformat": "mp32",
        "imagesize": 300,
        "order": "popularity_total",
    }

    try:
        response = await _client.get(JAMENDO_API_URL, params=params)
        response.raise_for_status()
    except httpx.HTTPError:
        logger.exception("Jamendo search failed")
        return []

    try:
        payload = response.json()
    except ValueError:
        logger.exception("Jamendo returned invalid JSON")
        return []

    status = payload.get("headers", {}).get("status")
    if status and status != "success":
        logger.error("Jamendo API returned error status: %s", payload.get("headers"))
        return []

    results = []
    for track in payload.get("results", []):
        normalized = normalize_jamendo_track(track)
        if normalized:
            results.append(normalized)

    return results
