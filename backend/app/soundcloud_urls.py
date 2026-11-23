"""SoundCloud track URLs accepted by the stream resolver and archive."""

from urllib.parse import urlparse


def is_soundcloud_track_url(track_id: str, url: str) -> bool:
    if not track_id.isdigit():
        return False
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    if parsed.scheme != "https":
        return False
    if parsed.netloc == "soundcloud.com":
        return parsed.path.startswith("/") and len(parsed.path) > 1
    # Flat yt-dlp playlist entries can contain an API URL instead of a permalink.
    # SoundcloudIE supports both; bind the API path to the ID inside the token.
    return parsed.netloc in {"api.soundcloud.com", "api-v2.soundcloud.com"} and parsed.path.rstrip("/") == f"/tracks/{track_id}"
