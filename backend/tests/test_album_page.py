"""Дискография на странице исполнителя и страница альбома.

Регрессии, ради которых написано:
1. Релизов у исполнителя на странице не было вовсе — каталог показывался одним
   плоским списком треков, и попасть в конкретный альбом было некуда.
2. Провайдер отдаёт альбомы и синглы двумя секциями, в произвольном порядке и с
   пересечениями (один и тот же browseId в обеих) — карусель должна получать
   список без дублей и от новых к старым.
3. Сохранение альбома в медиатеку не должно плодить копии плейлиста при
   повторном нажатии.
"""
import pytest

from app.routers.ytdlp import _albums_from_info
from app.schemas import ExternalAlbumDetail, ExternalAlbumResponse, ExternalTrackResponse

from tests.conftest import auth_headers, create_user


def album_item(browse_id: str, title: str, year=None, **extra) -> dict:
    """Элемент секции albums/singles в формате ytmusicapi."""
    return {
        "browseId": browse_id,
        "title": title,
        "year": year,
        "thumbnails": [{"url": f"http://img/{browse_id}.jpg"}],
        **extra,
    }


def ext(title: str, external_id: str) -> ExternalTrackResponse:
    return ExternalTrackResponse(
        id=f"ytmusic:{external_id}",
        source="ytmusic",
        external_id=external_id,
        title=title,
        artist="Linkin Park",
        album="Meteora",
        duration=185,
        cover_url="http://img/meteora.jpg",
        stream_url="http://test/api/ytdlp/stream/" + external_id,
    )


def album_detail(track_count: int = 2) -> ExternalAlbumDetail:
    return ExternalAlbumDetail(
        album=ExternalAlbumResponse(
            id="ytmusic:MPREb_meteora",
            source="ytmusic",
            external_id="MPREb_meteora",
            title="Meteora",
            artist="Linkin Park",
            year="2003",
            cover_url="http://img/meteora.jpg",
            track_count=track_count,
            album_type="Album",
        ),
        tracks=[ext(f"Track {i}", f"vid{i}") for i in range(track_count)],
    )


class TestAlbumsFromInfo:
    """Секции albums/singles страницы артиста → список для карусели."""

    def test_albums_first_then_singles_newest_first(self):
        info = {
            "albums": {"results": [
                album_item("A1", "Minutes to Midnight", 2007),
                album_item("A2", "Meteora", 2003),
                album_item("A3", "Living Things", 2012),
            ]},
            "singles": {"results": [album_item("S1", "Numb", 2003)]},
        }

        albums = _albums_from_info(info, "Linkin Park")

        assert [a.title for a in albums] == [
            "Living Things", "Minutes to Midnight", "Meteora", "Numb",
        ]

    def test_release_type_falls_back_to_section(self):
        info = {
            "albums": {"results": [album_item("A1", "Meteora", 2003)]},
            "singles": {"results": [
                album_item("S1", "Numb", 2003),
                album_item("S2", "Nobody's Listening", 2003, type="EP"),
            ]},
        }

        by_title = {a.title: a for a in _albums_from_info(info, "Linkin Park")}

        # Тип нужен фронту, чтобы разложить релизы по двум каруселям.
        assert by_title["Meteora"].album_type == "Album"
        assert by_title["Numb"].album_type == "Single"
        # Провайдер прислал свой тип — он точнее секции.
        assert by_title["Nobody's Listening"].album_type == "EP"

    def test_same_release_in_both_sections_appears_once(self):
        info = {
            "albums": {"results": [album_item("A1", "Meteora", 2003)]},
            "singles": {"results": [album_item("A1", "Meteora", 2003)]},
        }

        assert [a.external_id for a in _albums_from_info(info, "Linkin Park")] == ["A1"]

    def test_skips_items_without_id_or_title(self):
        info = {"albums": {"results": [
            album_item("A1", "Meteora", 2003),
            {"title": "Нет browseId", "year": 2001},   # открыть нечем
            album_item("A2", "", 2001),                # подписать нечем
        ]}}

        assert [a.external_id for a in _albums_from_info(info, "Linkin Park")] == ["A1"]

    def test_no_sections_is_empty_not_an_error(self):
        # Страница артиста обязана открываться и без дискографии.
        assert _albums_from_info({}, "Linkin Park") == []
        assert _albums_from_info({"albums": None, "singles": {}}, "X") == []

    def test_releases_without_year_go_last(self):
        info = {"albums": {"results": [
            album_item("A1", "Без года"),
            album_item("A2", "Meteora", 2003),
        ]}}

        assert [a.title for a in _albums_from_info(info, "LP")] == ["Meteora", "Без года"]


class TestArtistPageAlbums:
    """Дискография доезжает до ответа страницы исполнителя."""

    @pytest.fixture(autouse=True)
    def _stub_providers(self, monkeypatch):
        from app.routers import artists as artists_router

        async def fake_profile(request, name, limit=60):
            return {
                "name": "Linkin Park",
                "cover_url": "http://img/lp.jpg",
                "tracks": [],
                "albums": [album_detail().album],
            }

        async def fake_sc(request, q, limit=20):
            return []

        monkeypatch.setattr(artists_router.ytdlp, "ytmusic_artist_profile", fake_profile)
        monkeypatch.setattr(artists_router.soundcloud, "search_soundcloud", fake_sc)

    def test_page_returns_albums(self, client, db):
        data = client.get("/api/artists", params={"name": "Linkin Park"}).json()

        assert [a["title"] for a in data["albums"]] == ["Meteora"]
        assert data["albums"][0]["external_id"] == "MPREb_meteora"

    def test_profile_without_albums_is_not_an_error(self, client, db, monkeypatch):
        from app.routers import artists as artists_router

        async def old_shape(request, name, limit=60):
            # Провайдер (или запись в кэше прошлой версии) без ключа albums.
            return {"name": "Linkin Park", "cover_url": None, "tracks": []}

        monkeypatch.setattr(artists_router.ytdlp, "ytmusic_artist_profile", old_shape)

        r = client.get("/api/artists", params={"name": "Linkin Park"})
        assert r.status_code == 200
        assert r.json()["albums"] == []


class TestAlbumEndpoint:
    @pytest.fixture(autouse=True)
    def _stub_album(self, monkeypatch):
        from app.routers import albums as albums_router

        async def fake_album(request, browse_id):
            return album_detail() if browse_id == "MPREb_meteora" else None

        monkeypatch.setattr(albums_router.ytdlp, "ytmusic_album", fake_album)

    def test_returns_album_with_tracks(self, client, db):
        r = client.get("/api/albums/ytmusic/MPREb_meteora")

        assert r.status_code == 200
        data = r.json()
        assert data["album"]["title"] == "Meteora"
        assert [t["title"] for t in data["tracks"]] == ["Track 0", "Track 1"]

    def test_unknown_album_is_404(self, client, db):
        assert client.get("/api/albums/ytmusic/MPREb_nope").status_code == 404

    def test_unknown_source_is_404(self, client, db):
        # Альбомы пока умеет только YouTube Music — молча отдать пустоту хуже.
        assert client.get("/api/albums/spotify/anything").status_code == 404


class TestAlbumToLibrary:
    @pytest.fixture(autouse=True)
    def _stub_album(self, monkeypatch):
        from app.routers import albums as albums_router

        async def fake_album(request, browse_id):
            return album_detail()

        monkeypatch.setattr(albums_router.ytdlp, "ytmusic_album", fake_album)

    def test_saves_album_as_playlist(self, client, db):
        create_user(db)
        payload = {"source": "ytmusic", "external_id": "MPREb_meteora"}

        r = client.post("/api/albums/library", json=payload, headers=auth_headers(client))

        assert r.status_code == 200
        data = r.json()
        assert data["created"] is True
        assert data["name"] == "Meteora"
        assert data["added"] == 2 and data["total"] == 2

        tracks = client.get(f"/api/playlists/{data['playlist_id']}", headers=auth_headers(client))
        assert [t["title"] for t in tracks.json()["tracks"]] == ["Track 0", "Track 1"]

    def test_second_save_does_not_duplicate(self, client, db):
        create_user(db)
        payload = {"source": "ytmusic", "external_id": "MPREb_meteora"}
        headers = auth_headers(client)

        first = client.post("/api/albums/library", json=payload, headers=headers).json()
        second = client.post("/api/albums/library", json=payload, headers=headers).json()

        assert second["playlist_id"] == first["playlist_id"]
        assert second["created"] is False
        assert second["added"] == 0
        assert second["total"] == 2

    def test_requires_auth(self, client, db):
        r = client.post(
            "/api/albums/library",
            json={"source": "ytmusic", "external_id": "MPREb_meteora"},
        )
        assert r.status_code == 401
