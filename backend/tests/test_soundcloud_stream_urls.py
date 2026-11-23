"""Imported flat playlists must remain streamable with SoundCloud API URLs."""

import pytest
from fastapi import HTTPException, Request, Response
from yt_dlp.extractor.soundcloud import SoundcloudIE

from app import external_archive
from app.models import Track
from app.routers import soundcloud


TRACK_ID = "2439471876"
URLS = [
    f"https://api-v2.soundcloud.com/tracks/{TRACK_ID}",
    f"https://api.soundcloud.com/tracks/{TRACK_ID}",
    "https://soundcloud.com/artist/song",
    f"https://api-v2.soundcloud.com/tracks/{TRACK_ID}?secret_token=s-private",
]


@pytest.mark.parametrize("url", URLS)
def test_imported_track_url_is_accepted_by_stream_and_archive(url):
    assert SoundcloudIE.suitable(url)
    token = soundcloud._encode_token(TRACK_ID, url)
    assert soundcloud._decode_token(token) == (TRACK_ID, url)
    track = Track(source="soundcloud", external_id=TRACK_ID, stream_url=f"https://old-host.test/api/soundcloud/stream/{token}")
    assert external_archive._sc_permalink_from_track(track) == url


@pytest.mark.parametrize("url", URLS)
def test_flat_playlist_normalization_produces_a_streamable_token(url):
    request = Request({"type": "http", "scheme": "http", "server": ("testserver", 80), "path": "/", "headers": []})
    track = soundcloud._normalize(request, {"id": TRACK_ID, "webpage_url": url, "title": "Song", "uploader": "Artist", "duration": 180})
    assert track is not None
    assert soundcloud._decode_token(track.stream_url.rsplit("/", 1)[1]) == (TRACK_ID, url)


@pytest.mark.parametrize("url", [
    f"https://api-v2.soundcloud.com/tracks/{int(TRACK_ID) + 1}",
    "https://api-v2.soundcloud.com/playlists/42",
    f"http://api-v2.soundcloud.com/tracks/{TRACK_ID}",
    f"https://api-v2.soundcloud.com.example.org/tracks/{TRACK_ID}",
    f"https://example.org/?url=https://soundcloud.com/tracks/{TRACK_ID}",
    "https://soundcloud.com.example.org/artist/song",
    f"https://attacker@api-v2.soundcloud.com/tracks/{TRACK_ID}",
    "not-a-url",
])
def test_malformed_and_unrelated_urls_are_rejected(url):
    token = soundcloud._encode_token(TRACK_ID, url)
    with pytest.raises(HTTPException) as error:
        soundcloud._decode_token(token)
    assert error.value.status_code == 400


def test_existing_playlist_download_follows_api_url_token_to_audio(client, db, monkeypatch):
    from tests.conftest import auth_headers, create_user

    create_user(db)
    headers = auth_headers(client)
    url = URLS[0]
    token = soundcloud._encode_token(TRACK_ID, url)
    track = Track(title="Song", artist="Artist", duration=180, source="soundcloud", external_id=TRACK_ID,
                  stream_url=f"https://old-host.test/api/soundcloud/stream/{token}")
    db.add(track)
    db.commit()
    db.refresh(track)
    calls = []

    async def stream_audio(request, cache_id, resolve, **kwargs):
        calls.append(cache_id)
        resolved = await resolve(False)
        assert resolved[0] == "https://audio.test/song.mp3"
        return Response(b"complete audio", media_type="audio/mpeg")

    async def resolve(track_id, permalink, force=False):
        assert (track_id, permalink) == (TRACK_ID, url)
        return "https://audio.test/song.mp3", ".mp3", 14, True

    monkeypatch.setattr(soundcloud, "stream_cached_audio", stream_audio)
    monkeypatch.setattr(soundcloud, "_resolve_cached", resolve)
    monkeypatch.setattr(external_archive, "schedule_archive", lambda *args: None)
    monkeypatch.setattr(external_archive, "schedule_archive_external", lambda *args: None)
    response = client.get(f"/api/tracks/{track.id}/stream", headers=headers)
    assert response.status_code == 200, response.text
    assert response.content == b"complete audio"
    assert calls == [f"sc{TRACK_ID}"]
