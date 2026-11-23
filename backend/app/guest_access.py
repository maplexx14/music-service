"""Guests may search the catalog and fetch track audio and artwork only."""

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies import get_current_user, oauth2_scheme_optional


GUEST_GET_ROUTES = frozenset({
    "/", "/api/health",
    "/api/search/", "/api/search/external", "/api/search/external/grouped",
    "/api/artists/search", "/api/search/external/playlists",
    "/api/external/search", "/api/ytdlp/search", "/api/soundcloud/search",
    "/api/soulseek/search", "/api/spotify/search", "/api/yandex/search",
    "/api/import/search/{provider}",
    "/api/spotify/status", "/api/yandex/status", "/api/deezer/status",
    "/api/tracks/{track_id}/stream", "/api/tracks/cover-proxy",
    "/api/tracks/cover/{key:path}",
    "/api/ytdlp/stream/{video_id}", "/api/soundcloud/stream/{token}",
    "/api/soulseek/stream/{token}",
    "/api/ytdlp/prefetch/{video_id}/ready", "/api/soundcloud/prefetch/{token}/ready",
})
GUEST_POST_ROUTES = frozenset({
    "/api/ytdlp/prefetch/{video_id}", "/api/soundcloud/prefetch/{token}",
})


def enforce_guest_access(
    request: Request,
    token: str | None = Depends(oauth2_scheme_optional),
    db: Session = Depends(get_db),
) -> None:
    # Route templates avoid treating reserved names such as "me" as track IDs.
    path = request.scope["route"].path
    if path.startswith("/api/auth/") or path.startswith("/api/share/"):
        return
    if request.method == "GET" and path in GUEST_GET_ROUTES:
        return
    if request.method == "POST" and path in GUEST_POST_ROUTES:
        return
    if not token:
        raise HTTPException(
            status_code=401,
            detail="Registration required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    user = get_current_user(request, token, db)
    if not user.is_active:
        raise HTTPException(status_code=400, detail="Inactive user")
