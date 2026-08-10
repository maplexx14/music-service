"""Страница исполнителя и порядок секций в поиске.

Регрессии, ради которых написано:
1. У исполнителя не было своей страницы — имя в списке треков было мёртвым
   текстом, посмотреть «всё этого артиста» было негде.
2. Строка исполнителя коллаборации («A, B», «A feat. B») — это несколько
   артистов, у каждого должна быть своя страница, а не одна общая на строку.
3. Выдача поиска склеивала источники round-robin, из-за чего порядок
   «плейлисты → медиатека → ytmusic → soundcloud» выразить было нельзя.
4. Один артист приходил из источников в двух алфавитах («Zemfira» из
   SoundCloud, «Земфира» из YouTube Music) — поиск показывал две карточки, и
   каталог артиста делился между двумя страницами.
"""
import pytest

from app.artist_utils import query_names_artist, same_artist, split_artists
from app.routers.aggregate import dedup_sequential
from app.routers.artists import _by_this_artist
from app.schemas import ExternalTrackResponse


def ext(title: str, artist: str, source: str = "ytmusic") -> ExternalTrackResponse:
    return ExternalTrackResponse(
        id=f"{source}:{title}",
        source=source,
        external_id=title,
        title=title,
        artist=artist,
        duration=100,
        stream_url="http://x/stream",
    )


class TestSameArtist:
    """Одно имя в двух алфавитах — один артист."""

    def test_matches_across_scripts(self):
        assert same_artist("Земфира", "Zemfira")
        assert same_artist("Кино", "Kino")
        assert same_artist("Ленинград", "Leningrad")

    def test_matches_across_romanization_schemes(self):
        # Транскрибируют кто во что горазд: й/ы → y или i, я → ya или ia,
        # удвоение по вкусу. Для сравнения имён эта разница ничего не значит.
        assert same_artist("Каспийский Груз", "Kaspiyskiy Gruz")
        assert same_artist("Мумий Тролль", "Mumiy Troll")
        assert same_artist("Пошлая Молли", "Poshlaya Molly")
        assert same_artist("Пошлая Молли", "Poshlaia Molli")
        assert same_artist("Юлия", "Julia")
        assert same_artist("Макс Корж", "Max Korzh")

    def test_keeps_different_artists_apart(self):
        # Огрубление одностороннее: не схлопнуть два написания не страшно,
        # схлопнуть двух разных артистов — страшно.
        assert not same_artist("Жанна", "Анна")
        assert not same_artist("Mia", "Ma")
        assert not same_artist("Кино", "Кипелов")
        assert not same_artist("Cara", "Kara")
        assert not same_artist("", "Zemfira")


class TestQueryNamesArtist:
    def test_query_matches_artist_in_other_script(self):
        # Иначе страница «Zemfira» не получила бы каталог YouTube Music:
        # ytdlp сверяет с запросом каноническое имя, а оно кириллицей.
        assert query_names_artist("Zemfira", "Земфира")
        assert query_names_artist("Земфира", "Zemfira")
        assert not query_names_artist("Zemfira", "Земляне")


class TestSplitArtists:
    def test_splits_collaborations(self):
        assert split_artists("Linkin Park, Jay-Z") == ["Linkin Park", "Jay-Z"]
        assert split_artists("The Weeknd feat. Daft Punk") == ["The Weeknd", "Daft Punk"]
        assert split_artists("Skrillex x Diplo") == ["Skrillex", "Diplo"]
        assert split_artists("Simon & Garfunkel") == ["Simon", "Garfunkel"]

    def test_keeps_slash_and_hyphen_names(self):
        # «/» разделителем не считается: это часть имени, а не склейка.
        assert split_artists("AC/DC") == ["AC/DC"]
        assert split_artists("Blink-182") == ["Blink-182"]

    def test_feat_dot_does_not_leak_into_name(self):
        # Точка в «feat.» съедается: иначе второе имя было бы «. Daft Punk».
        assert split_artists("A feat. B") == ["A", "B"]
        assert split_artists("A ft B") == ["A", "B"]

    def test_x_inside_word_is_not_a_separator(self):
        assert split_artists("Xzibit") == ["Xzibit"]

    def test_dedups_and_handles_empty(self):
        assert split_artists("Drake, drake") == ["Drake"]
        assert split_artists("") == []
        # Из одних разделителей ничего осмысленного не выйдет — но и падать
        # нельзя: у трека всегда должен быть хотя бы один исполнитель.
        assert split_artists("Nirvana") == ["Nirvana"]


class TestDedupSequential:
    def test_preserves_order_unlike_round_robin(self):
        # Порядок блоков — это и есть смысл функции: секции в выдаче идут
        # фиксированно, перемешивать источники нельзя.
        tracks = [ext("a", "X"), ext("b", "X"), ext("c", "X")]
        assert [t.title for t in dedup_sequential(tracks)] == ["a", "b", "c"]

    def test_drops_duplicates_across_calls_via_seen(self):
        seen: set = set()
        first = dedup_sequential([ext("Numb", "Linkin Park")], 0, seen)
        second = dedup_sequential(
            [ext("Numb", "Linkin Park", "soundcloud"), ext("Faint", "Linkin Park", "soundcloud")],
            0,
            seen,
        )
        assert [t.title for t in first] == ["Numb"]
        # «Numb» уже показан в первой секции — во второй его быть не должно.
        assert [t.title for t in second] == ["Faint"]

    def test_respects_limit(self):
        tracks = [ext(str(i), "X") for i in range(10)]
        assert len(dedup_sequential(tracks, limit=3)) == 3

    def test_limit_zero_means_unlimited(self):
        tracks = [ext(str(i), "X") for i in range(10)]
        assert len(dedup_sequential(tracks, limit=0)) == 10


class TestByThisArtist:
    def test_keeps_tracks_of_the_artist(self):
        assert _by_this_artist(ext("Numb", "Linkin Park"), "Linkin Park")
        # Коллаборация: искомый артист — одна из частей строки.
        assert _by_this_artist(ext("Numb/Encore", "Linkin Park, Jay-Z"), "Jay-Z")

    def test_rejects_covers_and_unrelated_matches(self):
        # SoundCloud ищет по всему тексту: на «Nirvana» он отдаёт каверы чужих
        # исполнителей — на странице артиста им не место.
        assert not _by_this_artist(ext("Smells Like Teen Spirit", "Some Coverband"), "Nirvana")
        assert not _by_this_artist(ext("Nirvana", "Sam Smith"), "Nirvana")


class TestArtistEndpoint:
    """Эндпоинт целиком: БД настоящая, внешние источники замоканы."""

    @pytest.fixture(autouse=True)
    def _stub_providers(self, monkeypatch):
        from app.routers import artists as artists_router

        async def fake_profile(request, name, limit=60):
            return {
                "name": "Linkin Park",
                "cover_url": "http://img/lp.jpg",
                "tracks": [ext("Faint", "Linkin Park"), ext("Numb", "Linkin Park")],
            }

        async def fake_sc(request, q, limit=20):
            return [
                ext("In The End", "Linkin Park", "soundcloud"),
                ext("Numb", "Linkin Park", "soundcloud"),   # дубль ytmusic
                ext("Numb (cover)", "Coverband", "soundcloud"),  # чужой
            ]

        monkeypatch.setattr(artists_router.ytdlp, "ytmusic_artist_profile", fake_profile)
        monkeypatch.setattr(artists_router.soundcloud, "search_soundcloud", fake_sc)

    def test_orders_library_then_ytmusic_then_soundcloud(self, client, db):
        from app.models import Track

        db.add(Track(title="Papercut", artist="Linkin Park", duration=185, source="local"))
        db.commit()

        r = client.get("/api/artists", params={"name": "Linkin Park"})
        assert r.status_code == 200
        data = r.json()

        assert data["name"] == "Linkin Park"
        assert data["cover_url"] == "http://img/lp.jpg"
        # Библиотека — отдельным списком (у этих треков числовой id).
        assert [t["title"] for t in data["tracks"]] == ["Papercut"]
        # Внешние: сначала каталог YouTube Music, затем SoundCloud.
        assert [t["title"] for t in data["external"]] == ["Faint", "Numb", "In The End"]

    def test_library_track_wins_over_external_duplicate(self, client, db):
        from app.models import Track

        db.add(Track(title="Numb", artist="Linkin Park", duration=185, source="local"))
        db.commit()

        data = client.get("/api/artists", params={"name": "Linkin Park"}).json()
        assert [t["title"] for t in data["tracks"]] == ["Numb"]
        # «Numb» уже есть в медиатеке — внешней копии в списке быть не должно.
        assert "Numb" not in [t["title"] for t in data["external"]]

    def test_survives_provider_failure(self, client, db, monkeypatch):
        from app.models import Track
        from app.routers import artists as artists_router

        async def boom(*a, **kw):
            raise RuntimeError("provider down")

        monkeypatch.setattr(artists_router.ytdlp, "ytmusic_artist_profile", boom)
        monkeypatch.setattr(artists_router.soundcloud, "search_soundcloud", boom)

        db.add(Track(title="Papercut", artist="Linkin Park", duration=185, source="local"))
        db.commit()

        r = client.get("/api/artists", params={"name": "Linkin Park"})
        # Страница обязана открыться на одной библиотеке.
        assert r.status_code == 200
        assert [t["title"] for t in r.json()["tracks"]] == ["Papercut"]
        assert r.json()["external"] == []

    def test_finds_artist_inside_collaboration_string(self, client, db):
        from app.models import Track

        db.add(Track(title="Numb/Encore", artist="Linkin Park, Jay-Z", duration=200, source="local"))
        db.commit()

        data = client.get("/api/artists", params={"name": "Jay-Z"}).json()
        # Трек записан склеенной строкой — на странице Jay-Z он тоже должен быть.
        assert [t["title"] for t in data["tracks"]] == ["Numb/Encore"]


class TestCrossScriptArtist:
    """Один артист в двух алфавитах — одна карточка и один каталог.

    Источники пишут имя каждый по-своему: в медиатеку трек приехал из
    SoundCloud как «Zemfira», YouTube Music зовёт её «Земфира».
    """

    @pytest.fixture
    def yt_cards(self, monkeypatch):
        """Подменяет карточки артистов из YouTube Music; возвращает сеттер."""
        from app.routers import artists as artists_router

        def setup(cards):
            async def fake_cards(q, limit=6):
                return cards

            monkeypatch.setattr(
                artists_router.ytdlp, "search_ytmusic_artist_cards", fake_cards
            )

        return setup

    def test_search_returns_one_card_with_ytmusic_name(self, client, db, yt_cards):
        from app.models import Track

        db.add(Track(title="Искала", artist="Zemfira", duration=200, source="local"))
        db.commit()
        yt_cards([{"name": "Земфира", "cover_url": "http://img/z.jpg"}])

        cards = client.get("/api/artists/search", params={"q": "Zemfira"}).json()

        assert len(cards) == 1
        # Имя — каноническое из YouTube Music, а не как назвал источник импорта.
        assert cards[0]["name"] == "Земфира"
        # Схлопнули в карточку из медиатеки — пометка обязана уцелеть.
        assert cards[0]["in_library"] is True

    def test_search_finds_library_artist_typed_in_other_script(self, client, db, yt_cards):
        from app.models import Track

        db.add(Track(title="Искала", artist="Zemfira", duration=200, source="local"))
        db.commit()
        yt_cards([])

        cards = client.get("/api/artists/search", params={"q": "Земфира"}).json()

        # ilike по «Земфира» латинскую строку не находит — артист опознан по
        # транслитерации, иначе «в медиатеке» зависело бы от раскладки.
        assert [(c["name"], c["in_library"]) for c in cards] == [("Zemfira", True)]

    def test_page_collects_library_tracks_under_both_spellings(
        self, client, db, monkeypatch, yt_cards
    ):
        from app.models import Track
        from app.routers import artists as artists_router

        async def fake_profile(request, name, limit=60):
            return {"name": "Земфира", "cover_url": None, "tracks": []}

        async def fake_sc(request, q, limit=20):
            return []

        monkeypatch.setattr(artists_router.ytdlp, "ytmusic_artist_profile", fake_profile)
        monkeypatch.setattr(artists_router.soundcloud, "search_soundcloud", fake_sc)

        db.add(Track(title="Искала", artist="Zemfira", duration=200, source="local"))
        db.add(Track(title="Ромашки", artist="Земфира", duration=210, source="local"))
        db.commit()

        data = client.get("/api/artists", params={"name": "Земфира"}).json()

        # Каталог артиста не должен делиться между двумя написаниями.
        assert sorted(t["title"] for t in data["tracks"]) == ["Искала", "Ромашки"]
