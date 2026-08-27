"""Похожие треки по названию (app/beets_similar.py + flow._lastfm_pool).

Зачем источник вообще нужен: похожесть на уровне ТРЕКА в потоке была только у
радио YT Music, а оно строится от videoId. У пользователя, чья библиотека
целиком в SoundCloud, сеять радио нечем, и разведка сваливалась в дискографию
уже выбранных им артистов. Last.fm ищет похожие по паре артист+название, то есть
по строкам, — и доступен в этом случае тоже.

Сеть здесь не трогаем: pylast подменяется фейком, поиск у провайдеров — тоже.
Проверяем разбор ответа, отказоустойчивость (ключа нет / Last.fm ответил
ошибкой) и то, что резолв имён у провайдеров не тащит в поток мусор
полнотекстового поиска.
"""

import asyncio

import pytest

from app import beets_similar
from app.cache import clear_pattern
from app.routers import flow
from app.schemas import ExternalTrackResponse

from tests.test_flow import _external, _liked
from tests.conftest import create_user


class _FakeArtist:
    def __init__(self, name):
        self._name = name

    def get_name(self):
        return self._name


class _FakeTrack:
    """pylast.Track, каким его собирает get_similar: строки уже извлечены."""

    def __init__(self, artist, title, artist_as_string=False):
        self._artist = artist if artist_as_string else _FakeArtist(artist)
        self._title = title

    def get_artist(self):
        return self._artist

    def get_title(self):
        return self._title


class _FakeSimilar:
    def __init__(self, item, match):
        self.item = item
        self.match = match


class _FakeSeed:
    def __init__(self, items, error=None):
        self._items = items
        self._error = error

    def get_similar(self, limit=None):
        if self._error is not None:
            raise self._error
        return self._items[:limit] if limit else self._items


class _FakeNetwork:
    def __init__(self, items, error=None):
        self._items = items
        self._error = error
        self.asked = []

    def get_track(self, artist, title):
        self.asked.append((artist, title))
        return _FakeSeed(self._items, self._error)


@pytest.fixture(autouse=True)
def _reset_similar_client():
    beets_similar.reset_cache()
    clear_pattern("flow:lastfm*")
    yield
    beets_similar.reset_cache()
    clear_pattern("flow:lastfm*")


def _network(monkeypatch, items, error=None):
    net = _FakeNetwork(items, error)
    monkeypatch.setattr(beets_similar, "_get_network", lambda: net)
    return net


def test_similar_tracks_keeps_lastfm_order(monkeypatch):
    """Порядок Last.fm — это порядок по убыванию похожести, его и сохраняем."""
    net = _network(
        monkeypatch,
        [
            _FakeSimilar(_FakeTrack("Jay-Z", "Encore"), 1.0),
            _FakeSimilar(_FakeTrack("Kanye West", "Heartless"), 0.7),
            _FakeSimilar(_FakeTrack("Lupe Fiasco", "Superstar"), 0.4),
        ],
    )

    pairs = beets_similar.similar_tracks("Kanye West", "Stronger")

    assert pairs == [
        ("Jay-Z", "Encore"),
        ("Kanye West", "Heartless"),
        ("Lupe Fiasco", "Superstar"),
    ]
    assert net.asked == [("Kanye West", "Stronger")]


def test_weak_similarity_is_dropped(monkeypatch):
    """Хвост выдачи держится на единичных совместных прослушиваниях — это шум."""
    _network(
        monkeypatch,
        [
            _FakeSimilar(_FakeTrack("Strong", "Match"), 0.9),
            _FakeSimilar(_FakeTrack("Weak", "Match"), 0.01),
            # Last.fm иногда отдаёт match пустым — считаем нулём, а не падаем.
            _FakeSimilar(_FakeTrack("Broken", "Match"), None),
            _FakeSimilar(_FakeTrack("NotANumber", "Match"), "nope"),
        ],
    )

    assert beets_similar.similar_tracks("A", "B") == [("Strong", "Match")]


def test_duplicates_and_blanks_are_dropped(monkeypatch):
    """Один трек дважды и запись без имени в поток попасть не должны."""
    _network(
        monkeypatch,
        [
            _FakeSimilar(_FakeTrack("Artist", "Song"), 0.9),
            _FakeSimilar(_FakeTrack("ARTIST", "SONG"), 0.8),
            _FakeSimilar(_FakeTrack("", "No Artist"), 0.8),
            _FakeSimilar(_FakeTrack("No Title", ""), 0.8),
            # Старые версии pylast кладут в artist строку, а не объект.
            _FakeSimilar(_FakeTrack("Other", "Track", artist_as_string=True), 0.7),
        ],
    )

    assert beets_similar.similar_tracks("A", "B") == [
        ("Artist", "Song"),
        ("Other", "Track"),
    ]


def test_lastfm_failure_is_not_fatal(monkeypatch):
    """Отказ резервного источника не должен ронять подгрузку потока."""
    _network(monkeypatch, [], error=RuntimeError("Access Denied"))
    assert beets_similar.similar_tracks("A", "B") == []


def test_disabled_without_client(monkeypatch):
    monkeypatch.setattr(beets_similar, "_get_network", lambda: None)
    assert beets_similar.available() is False
    assert beets_similar.similar_tracks("A", "B") == []


def test_no_api_key_means_source_is_off(monkeypatch):
    """Ключа нет — источник молчит. Встроенный ключ beets Last.fm отвергает,
    поэтому опираться на него нельзя (см. модульный docstring beets_similar)."""
    pytest.importorskip("beets.plugins")
    monkeypatch.delenv("LASTFM_API_KEY", raising=False)
    monkeypatch.setattr("beets.plugins.LASTFM_KEY", "", raising=False)
    beets_similar.reset_cache()

    assert beets_similar.available() is False
    assert beets_similar.similar_tracks("Kanye West", "Stronger") == []


def test_missing_seed_names_are_not_asked(monkeypatch):
    net = _network(monkeypatch, [_FakeSimilar(_FakeTrack("X", "Y"), 0.9)])
    assert beets_similar.similar_tracks("", "Title") == []
    assert beets_similar.similar_tracks("Artist", "") == []
    assert net.asked == []


# --- резолв имён в играбельные треки (flow) ---


def test_same_track_check_rejects_full_text_junk():
    """Поиск у провайдеров полнотекстовый и охотно отдаёт чужие треки.

    Ровно та проблема, из-за которой фильтруется _soundcloud_pool: слова
    запроса встречаются в названии совсем другого автора.
    """
    right = _external("Jay-Z", "Encore", "v1")
    assert flow._is_same_track("Jay-Z", "Encore", right)

    # Тот же артист, но название другое — это не искомый трек.
    assert not flow._is_same_track("Jay-Z", "Encore", _external("Jay-Z", "99 Problems", "v2"))
    # Название совпало, автор — перезаливщик/сборник.
    assert not flow._is_same_track(
        "Jay-Z", "Encore", _external("Best Hits Channel", "Encore", "v3")
    )
    # Фичеринг и уточнения в названии совпадению не мешают.
    assert flow._is_same_track(
        "Jay-Z", "Encore", _external("Jay-Z, Linkin Park", "Encore (Official Video)", "v4")
    )
    # Пустые метаданные — не совпадение.
    assert not flow._is_same_track("Jay-Z", "Encore", _external("", "", "v5"))


def _resolver(monkeypatch, yt=None, sc=None):
    async def _yt(request, query, limit=10):
        return list(yt or [])

    async def _sc(request, query, limit=10):
        return list(sc or [])

    monkeypatch.setattr(flow.ytdlp, "search_ytmusic", _yt)
    monkeypatch.setattr(flow.soundcloud, "search_soundcloud", _sc)


@pytest.mark.real_external_pools
def test_lastfm_pool_resolves_names_into_playable_tracks(monkeypatch):
    """Last.fm отдаёт только имена — играбельными их делает поиск."""

    async def _names(artist, title, limit=20):
        return [("Jay-Z", "Encore")]

    monkeypatch.setattr(beets_similar, "similar_tracks_async", _names)
    _resolver(
        monkeypatch,
        yt=[_external("Some Reuploader", "Encore cover", "junk"),
            _external("Jay-Z", "Encore", "real")],
    )

    pool = asyncio.run(flow._lastfm_pool(None, "Kanye West", "Stronger"))

    assert [t.external_id for t in pool] == ["real"]


def test_lastfm_pool_drops_names_nobody_has(monkeypatch):
    """Имя, которого у провайдеров нет, просто выпадает — пул не мусорится."""

    async def _names(artist, title, limit=20):
        return [("Обскюрный Артист", "Неизвестный трек")]

    monkeypatch.setattr(beets_similar, "similar_tracks_async", _names)
    _resolver(monkeypatch, yt=[_external("Кто-то другой", "Совсем другое", "junk")])

    assert asyncio.run(flow._lastfm_pool(None, "A", "B")) == []


@pytest.mark.real_external_pools
def test_lastfm_pool_falls_back_to_soundcloud(monkeypatch):
    """YT Music предпочитаем, но имя может быть только в SoundCloud."""

    async def _names(artist, title, limit=20):
        return [("Jay-Z", "Encore")]

    monkeypatch.setattr(beets_similar, "similar_tracks_async", _names)
    _resolver(monkeypatch, yt=[], sc=[_external("Jay-Z", "Encore", "sc1")])

    pool = asyncio.run(flow._lastfm_pool(None, "A", "B"))
    assert [t.external_id for t in pool] == ["sc1"]


def test_soundcloud_pool_matches_legacy_uploader_by_effective_artist(monkeypatch):
    """Legacy uploader metadata must not hide a real artist's SoundCloud track."""
    async def _empty_cache(_key):
        return None

    async def _set_cache(*_args, **_kwargs):
        return None

    async def _search(_request, _artist, limit=10):
        return [
            ExternalTrackResponse(
                id="soundcloud:legacy-kordhell",
                source="soundcloud",
                external_id="legacy-kordhell",
                title="Kordhell - Murder In My Mind",
                artist="TrapNation",
                duration=180,
                stream_url="https://soundcloud.test/legacy-kordhell",
            ),
            ExternalTrackResponse(
                id="soundcloud:unrelated",
                source="soundcloud",
                external_id="unrelated",
                title="Kordhell mix",
                artist="OtherUploader",
                duration=180,
                stream_url="https://soundcloud.test/unrelated",
            ),
        ]

    monkeypatch.setattr(flow, "get_cache_async", _empty_cache)
    monkeypatch.setattr(flow, "set_cache_async", _set_cache)
    monkeypatch.setattr(flow.soundcloud, "search_soundcloud", _search)

    pool = asyncio.run(flow._soundcloud_pool(None, "Kordhell"))

    assert [track.external_id for track in pool] == ["legacy-kordhell"]


def test_lastfm_pool_survives_provider_errors(monkeypatch):
    """Упавший провайдер не должен ронять подгрузку."""

    async def _names(artist, title, limit=20):
        return [("Jay-Z", "Encore")]

    async def _boom(request, query, limit=10):
        raise RuntimeError("provider down")

    monkeypatch.setattr(beets_similar, "similar_tracks_async", _names)
    monkeypatch.setattr(flow.ytdlp, "search_ytmusic", _boom)
    monkeypatch.setattr(flow.soundcloud, "search_soundcloud", _boom)

    assert asyncio.run(flow._lastfm_pool(None, "A", "B")) == []


def test_seed_tracks_are_curated_tracks(db):
    """Сиды похожести — курированные треки, а не videoId.

    Именно поэтому источник работает у SoundCloud-библиотеки: сид — это пара
    артист+название, и ytmusic-трек в профиле для него не нужен.
    """
    user = create_user(db)
    _liked(db, user, artist="GoodArtist", title="liked-song")

    profile = flow._taste_profile(db, user.id)

    assert ("GoodArtist", "liked-song") in profile["seed_tracks"]
