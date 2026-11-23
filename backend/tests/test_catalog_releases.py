"""Regressions for disappearing discographies and video-only new releases."""
import asyncio
from copy import deepcopy
from types import SimpleNamespace

import pytest
from starlette.requests import Request

from app import catalog_releases as releases
from app.artist_utils import translit_key
from app.routers import ytdlp
from app.schemas import ExternalAlbumResponse, ExternalTrackResponse

pytestmark = pytest.mark.real_external_pools

ARTIST = "Врата Овертона"


def request(host="testserver"):
    return Request({"type": "http", "scheme": "https", "server": (host, 443),
                    "path": "/", "headers": []})


def album_item(album_id="44853444", title="Соколы", **extra):
    return {"id": album_id, "title": title, "year": 2026, "type": "single",
            "artists": [{"id": 17324542, "name": ARTIST}], "trackCount": 1,
            "coverUri": "avatars.yandex.net/sokoly/%%", **extra}


def song_item(**extra):
    return {"id": "158024650", "title": "Соколы", "durationMs": 239770,
            "artists": [{"name": ARTIST}], "albums": [album_item()], **extra}


def video_item(**extra):
    return {"videoId": "Ct4OHJ0veo8", "title": "Врата Овертона — Соколы",
            "artists": [{"name": "Vanguard SOF"}], "duration_seconds": 237, **extra}


def yt_album(title="Запальничка", album_id="old"):
    return ExternalAlbumResponse(id=f"ytmusic:{album_id}", source="ytmusic",
                                 external_id=album_id, title=title, artist=ARTIST,
                                 year="2026", album_type="Single")


def track(title="Запальничка", source="ytmusic", external_id="old", **extra):
    return ExternalTrackResponse(id=f"{source}:{external_id}", source=source,
                                 external_id=external_id, title=title, artist=ARTIST,
                                 duration=239, stream_url="", **extra)


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    values, writes = {}, {}

    async def get(key):
        return deepcopy(values.get(key))

    async def set_value(key, value, expire=3600):
        values[key] = deepcopy(value)
        writes[key] = expire

    async def api(*_args, **_kwargs):
        return None

    async def no_sc(*_args, **_kwargs):
        return []

    for module in (releases, ytdlp):
        monkeypatch.setattr(module, "get_cache_async", get)
        monkeypatch.setattr(module, "set_cache_async", set_value)
    monkeypatch.setattr(releases.yandex_music, "_api", api)
    monkeypatch.setattr(releases.soundcloud, "search_soundcloud", no_sc)
    monkeypatch.setattr(ytdlp, "_ytmusic", SimpleNamespace(search=lambda *_a, **_kw: []))
    monkeypatch.setattr(ytdlp, "_schedule_audio_matches", lambda *_a: None)
    return values, writes


def test_new_release_comes_from_exact_artist_even_when_search_top_is_wrong(monkeypatch):
    async def api(path, params=None, **_kwargs):
        if path == "search":
            return {"artists": {"results": [{"id": 1, "name": "Врата"},
                                            {"id": 17324542, "name": ARTIST}]}}
        assert path == "artists/17324542/direct-albums"
        return {"albums": [album_item(), album_item("2", "Запальничка"),
                            album_item("3", "Чужой", artists=[{"name": "Other"}])]}

    monkeypatch.setattr(releases.yandex_music, "_api", api)
    albums = asyncio.run(releases.yandex_artist_albums(ARTIST))
    assert [a.title for a in albums] == ["Соколы", "Запальничка"]
    assert albums[0].source == "yandex"


def test_provider_timeout_keeps_last_good_discography(monkeypatch, offline):
    values, _ = offline
    key = f"artist_releases:yandex:v1:{translit_key(ARTIST)}:last_good"
    values[key] = [yt_album().model_dump()]

    async def slow(*_a, **_kw):
        await asyncio.sleep(1)

    monkeypatch.setattr(releases.yandex_music, "_api", slow)
    monkeypatch.setattr(releases, "_CATALOG_BUDGET", 0.01)
    albums = asyncio.run(releases.yandex_artist_albums(ARTIST))
    assert [a.title for a in albums] == ["Запальничка"]
    assert values[key][0]["title"] == "Запальничка"


def test_failed_later_page_does_not_cache_a_truncated_catalogue(monkeypatch, offline):
    values, writes = offline
    key = f"artist_releases:yandex:v1:{translit_key(ARTIST)}"
    values[f"{key}:last_good"] = [yt_album("Previously available").model_dump()]

    async def api(path, params=None, **_kw):
        if path == "search":
            return {"artists": {"results": [{"id": 1, "name": ARTIST}]}}
        if params["page"] == 0:
            return {"albums": [album_item(str(i + 1), f"Release {i}") for i in range(50)],
                    "pager": {"total": 75}}
        return None

    monkeypatch.setattr(releases.yandex_music, "_api", api)
    albums = asyncio.run(releases.yandex_artist_albums(ARTIST))
    assert [a.title for a in albums] == ["Previously available"]
    assert key not in writes


def test_merge_keeps_new_single_first_and_uses_existing_playable_releases():
    primary = [yt_album(), yt_album("Полетели (feat. grust200)", "flight")]
    secondary = [releases._album(album_item()), releases._album(album_item("2", "Запальничка")),
                 releases._album(album_item("3", "Полетели"))]
    albums = releases.merge_artist_albums(primary, secondary)
    assert [(a.title, a.source) for a in albums] == [
        ("Соколы", "yandex"), ("Запальничка", "ytmusic"),
        ("Полетели (feat. grust200)", "ytmusic"),
    ]


def test_same_title_in_different_release_years_is_preserved():
    older = yt_album("Соколы")
    older.year = "2024"
    latest = releases._album(album_item())
    albums = releases.merge_artist_albums([older], [latest])
    assert [a.year for a in albums] == ["2026", "2024"]


def test_album_metadata_survives_a_provider_outage(offline):
    values, _ = offline
    key = "artist_releases:yandex_album:v1:44853444:last_good"
    values[key] = album_item(volumes=[[song_item()]])
    assert asyncio.run(releases._album_metadata("44853444"))["title"] == "Соколы"


def test_slow_recent_release_does_not_delay_or_hide_completed_ones(monkeypatch):
    async def album(_request, album_id):
        if album_id == "2":
            await asyncio.sleep(1)
        return SimpleNamespace(tracks=[track("Соколы")])

    monkeypatch.setattr(releases, "yandex_album", album)
    monkeypatch.setattr(releases, "_RECENT_TRACK_BUDGET", 0.01)
    albums = [releases._album(album_item()), releases._album(album_item("2", "Slow"))]
    tracks = asyncio.run(releases.recent_artist_tracks(request(), albums, []))
    assert [t.title for t in tracks] == ["Соколы"]


def test_video_only_single_uses_release_metadata_instead_of_uploader(monkeypatch):
    monkeypatch.setattr(ytdlp._ytmusic, "search", lambda _q, filter, limit: (
        [video_item()] if filter == "videos" else []
    ))
    matched = asyncio.run(releases._match_track(request(), song_item()))
    assert (matched.title, matched.artist, matched.external_id) == ("Соколы", ARTIST, "Ct4OHJ0veo8")
    assert matched.album == "Соколы"
    assert matched.cover_url == "https://avatars.yandex.net/sokoly/400x400"


@pytest.mark.parametrize("video", [
    video_item(duration_seconds=270),
    video_item(title="Other Artist — Соколы"),
    video_item(title="Врата Овертона — Соколы (slowed)"),
])
def test_video_match_rejects_other_recordings(monkeypatch, video):
    monkeypatch.setattr(ytdlp._ytmusic, "search", lambda _q, filter, limit: (
        [video] if filter == "videos" else []
    ))
    assert asyncio.run(releases._match_track(request(), song_item())) is None


def test_short_artist_name_does_not_match_a_substring(monkeypatch):
    monkeypatch.setattr(ytdlp._ytmusic, "search", lambda _q, filter, limit: (
        [video_item(title="System — Соколы")] if filter == "videos" else []
    ))
    assert asyncio.run(releases._match_track(request(), song_item(artists=[{"name": "ST"}]))) is None


def test_soundcloud_recording_keeps_its_stream_endpoint(monkeypatch):
    async def sc(*_a, **_kw):
        return [track("Соколы", "soundcloud", "123")]

    async def api(*_a, **_kw):
        return album_item(volumes=[[song_item()]])

    monkeypatch.setattr(releases.soundcloud, "search_soundcloud", sc)
    monkeypatch.setattr(releases.yandex_music, "_api", api)
    detail = asyncio.run(releases.yandex_album(request("one.example"), "44853444"))
    assert detail.tracks[0].stream_url == "https://one.example/api/soundcloud/stream/123"
    cached = asyncio.run(releases.yandex_album(request("two.example"), "44853444"))
    assert cached.tracks[0].stream_url == "https://two.example/api/soundcloud/stream/123"


def test_artist_page_includes_new_single_and_its_playable_track(client, monkeypatch, member_headers):
    async def api(path, params=None, **_kw):
        if path == "search":
            return {"artists": {"results": [{"id": 17324542, "name": ARTIST}]}}
        if "direct-albums" in path:
            return {"albums": [album_item(), album_item("2", "Запальничка")]}
        return album_item(volumes=[[song_item()]])

    async def profile(*_a, **_kw):
        return {"name": ARTIST, "cover_url": None, "tracks": [track()], "albums": [yt_album()]}

    monkeypatch.setattr(releases.yandex_music, "_api", api)
    monkeypatch.setattr(ytdlp, "ytmusic_artist_profile", profile)
    monkeypatch.setattr(ytdlp._ytmusic, "search", lambda _q, filter, limit: (
        [video_item()] if filter == "videos" else []
    ))
    response = client.get("/api/artists", params={"name": ARTIST}, headers=member_headers)
    assert response.status_code == 200
    data = response.json()
    assert [a["title"] for a in data["albums"]] == ["Соколы", "Запальничка"]
    assert data["external"][0]["title"] == "Соколы"
    assert data["external"][0]["stream_url"].endswith("/api/ytdlp/stream/Ct4OHJ0veo8")
    album = client.get("/api/albums/yandex/44853444", headers=member_headers)
    assert album.status_code == 200
    assert album.json()["tracks"][0]["artist"] == ARTIST
    assert client.get("/api/albums/yandex/not-an-id", headers=member_headers).status_code == 404


def test_partial_ytmusic_profile_keeps_albums_and_retries_soon(monkeypatch, offline):
    values, writes = offline
    good = {"name": ARTIST, "cover_url": None, "tracks": [track()], "albums": [yt_album()]}

    async def fetch(*_a):
        return deepcopy(good)

    monkeypatch.setattr(ytdlp, "_fetch_artist_profile", fetch)
    first = asyncio.run(ytdlp.ytmusic_artist_profile(request(), ARTIST))
    key = f"ytmusic:artist_profile:v3:{translit_key(ARTIST)}:60"
    assert first["albums"]
    del values[key]
    good["albums"] = []
    restored = asyncio.run(ytdlp.ytmusic_artist_profile(request(), ARTIST))
    assert restored["albums"][0].title == "Запальничка"
    assert writes[key] == ytdlp._ARTIST_PROFILE_RETRY_TTL


def test_albums_only_profile_is_cached_as_a_success(monkeypatch, offline):
    async def fetch(*_a):
        return {"name": ARTIST, "cover_url": None, "tracks": [], "albums": [yt_album()]}

    monkeypatch.setattr(ytdlp, "_fetch_artist_profile", fetch)
    asyncio.run(ytdlp.ytmusic_artist_profile(request(), ARTIST))
    _, writes = offline
    key = f"ytmusic:artist_profile:v3:{translit_key(ARTIST)}:60"
    assert writes[key] == ytdlp._ARTIST_PROFILE_TTL


@pytest.mark.parametrize("fail_full", [False, True])
def test_full_release_list_adds_new_releases_and_failure_keeps_preview(monkeypatch, fail_full):
    preview = {"songs": {}, "singles": {"browseId": "channel", "params": "single-list",
        "results": [{"browseId": "old", "title": "Запальничка", "year": "2026"}]}}

    def full(*_a, **_kw):
        if fail_full:
            raise RuntimeError("Provider unavailable")
        return [{"browseId": "new", "title": "Соколы", "year": "2026"},
                {"browseId": "old", "title": "Запальничка", "year": "2026"}]

    monkeypatch.setattr(ytdlp, "_ytmusic", SimpleNamespace(
        search=lambda *_a, **_kw: [{"artist": ARTIST, "browseId": "channel"}],
        get_artist=lambda *_a: preview, get_artist_albums=full,
    ))
    profile = asyncio.run(ytdlp._fetch_artist_profile(ARTIST, 60))
    assert [a.title for a in profile["albums"]] == (
        ["Запальничка"] if fail_full else ["Соколы", "Запальничка"]
    )
