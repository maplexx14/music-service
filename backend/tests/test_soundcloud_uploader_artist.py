"""«Артисты-загрузчики» SoundCloud: аккаунт-перезаливщик не исполнитель.

Такие каналы сами ничего не исполняют, а выкладывают чужое, указывая настоящего
исполнителя прямо в названии трека («Kordhell - Murder In My Mind»). Без разбора
одна витрина уезжала в медиатеку «артистом» сотни чужих треков: её страница
собирала музыку разных людей, а профиль вкуса получал имя, которое пользователь
никогда не слушал.

Разбор осторожный — принять часть названия за артиста дороже, чем не опознать
перезаливщика, поэтому всё сомнительное остаётся на аккаунте.
"""

import pytest

from app.artist_utils import resolve_track_artist, split_title_artist
from app.routers.soundcloud import _track_from_api


class TestSplitTitleArtist:
    @pytest.mark.parametrize(
        "title, expected",
        [
            ("Kordhell - Murder In My Mind", ("Kordhell", "Murder In My Mind")),
            # Тире в любом начертании: SoundCloud отдаёт все три.
            ("Artist – En Dash", ("Artist", "En Dash")),
            ("Artist — Em Dash", ("Artist", "Em Dash")),
            ("Artist | Pipe", ("Artist", "Pipe")),
            # Промо-обвязка перед именем исполнителя.
            ("[FREE] Kordhell - Murder In My Mind", ("Kordhell", "Murder In My Mind")),
            ("PREMIERE: Some One - Deep Down", ("Some One", "Deep Down")),
            ("FREE DL | Nightcrawler - Sleepless", ("Nightcrawler", "Sleepless")),
            # Разделителей несколько — раскладываем только по первому.
            ("A - B - C", ("A", "B - C")),
        ],
    )
    def test_uploader_pattern_is_split(self, title, expected):
        assert split_title_artist(title) == expected

    @pytest.mark.parametrize(
        "title",
        [
            # Разделителя нет — трек назван как обычно.
            "Murder In My Mind",
            # Дефис внутри слова: «Sub-Zero», «K-391» — это имя, а не два поля.
            "Sub-Zero",
            "K-391",
            # Справа только пометка версии, значит слева НАЗВАНИЕ, не артист.
            "Midnight City - Extended Mix",
            "Midnight City - Original Mix",
            "Some Song - Remix",
            "Some Song - Radio Edit",
            # Слева номер дорожки или промо-слово.
            "01 - Intro",
            "1. - Intro",
            "FREE - Something",
            # Одна из половин пуста.
            "Track - ",
            " - Track",
            "",
            # Слева длинное описание релиза, а не имя.
            "A Really Long Release Description That Goes On And On - Song",
        ],
    )
    def test_unreliable_split_is_refused(self, title):
        assert split_title_artist(title) is None


class TestResolveTrackArtist:
    def test_reuploader_gives_way_to_artist_from_title(self):
        """Основной случай: аккаунт-витрина, исполнитель в названии."""
        assert resolve_track_artist(
            "Kordhell - Murder In My Mind", uploader="TrapNation"
        ) == ("Kordhell", "Murder In My Mind")

    def test_own_upload_keeps_account_as_artist(self):
        """Свой трек без разделителя — исполнитель это сам аккаунт."""
        assert resolve_track_artist("Murder In My Mind", uploader="Kordhell") == (
            "Kordhell",
            "Murder In My Mind",
        )

    def test_artist_prefix_duplicating_account_is_stripped(self):
        """«Kordhell - X» у аккаунта Kordhell: префикс в названии лишний."""
        assert resolve_track_artist(
            "Kordhell - Murder In My Mind", uploader="Kordhell"
        ) == ("Kordhell", "Murder In My Mind")

    def test_publisher_metadata_beats_title_and_account(self):
        """Метаданные правообладателя авторитетнее обоих источников."""
        assert resolve_track_artist(
            "Succession - Andante Risoluto",
            uploader="some-label",
            declared="Nicholas Britell",
        ) == ("Nicholas Britell", "Succession - Andante Risoluto")

    def test_publisher_metadata_strips_duplicated_prefix(self):
        assert resolve_track_artist(
            "Kordhell - Murder In My Mind",
            uploader="TrapNation",
            declared="Kordhell",
        ) == ("Kordhell", "Murder In My Mind")

    def test_release_prefix_is_not_taken_for_an_artist(self):
        """Префикс совпал с названием релиза — значит это релиз, а не имя."""
        assert resolve_track_artist(
            "Succession - Andante Risoluto",
            uploader="Nicholas Britell",
            album="Succession",
        ) == ("Nicholas Britell", "Succession - Andante Risoluto")

    def test_nothing_known_falls_back_to_unknown(self):
        assert resolve_track_artist("", uploader="") == ("Unknown Artist", "")


class _Request:
    """Минимум, который нужен _track_from_api: база для stream_url."""

    base_url = "http://testserver/"


def _api_item(title, username, publisher=None):
    item = {
        "id": 42,
        "permalink_url": "https://soundcloud.com/x/y",
        "title": title,
        "user": {"username": username},
        "duration": 180_000,
    }
    if publisher is not None:
        item["publisher_metadata"] = publisher
    return item


class TestSoundcloudApiTrack:
    """Тот же разбор на реальном входе api-v2 — единственной точке сборки трека
    для поиска, страницы плейлиста и импорта."""

    def test_reuploaded_track_gets_real_artist(self):
        track = _track_from_api(
            _Request(), _api_item("Kordhell - Murder In My Mind", "TrapNation")
        )
        assert track is not None
        assert track.artist == "Kordhell"
        assert track.title == "Murder In My Mind"

    def test_publisher_metadata_wins_over_title(self):
        track = _track_from_api(
            _Request(),
            _api_item(
                "Succession - Andante Risoluto",
                "nicholasbritell",
                publisher={"artist": "Nicholas Britell", "album_title": "Succession"},
            ),
        )
        assert track is not None
        assert track.artist == "Nicholas Britell"

    def test_plain_upload_keeps_account_name(self):
        track = _track_from_api(_Request(), _api_item("Sleepless", "Nightcrawler"))
        assert track is not None
        assert track.artist == "Nightcrawler"
        assert track.title == "Sleepless"
