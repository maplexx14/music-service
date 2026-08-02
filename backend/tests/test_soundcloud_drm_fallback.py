"""DRM-треки SoundCloud (policy=MONETIZE, FairPlay-HLS) играть с самого
SoundCloud нечем — прогрессивный пресет числится в метаданных, но отдаёт 404.
Вместо скипа такой трек подменяется той же записью из YouTube Music, но ТОЛЬКО
при точном совпадении: кавер/ремикс/другая версия молча подсунуться не должны.
"""

from app.routers.soundcloud import (
    _is_exact_match,
    _match_key,
    _youtube_entry_matches,
)
from app.schemas import ExternalTrackResponse


def _candidate(title: str, artist: str, duration: int) -> ExternalTrackResponse:
    return ExternalTrackResponse(
        id=f"ytmusic:{title}",
        source="ytmusic",
        external_id="vid",
        title=title,
        artist=artist,
        album=None,
        duration=duration,
        cover_url=None,
        stream_url="",
        download_url=None,
        download_allowed=False,
    )


# Реальный случай: sc/1526183035 «Succession - Andante Risoluto» (148 c).
_TITLE = "Succession - Andante Risoluto"
_ARTIST = "Nicholas Britell"
_DURATION = 148


def test_exact_same_recording_matches():
    """Та же запись в YouTube Music: 149 c против 148 c у SoundCloud."""
    cand = _candidate("Succession - Andante Risoluto", "Nicholas Britell", 149)
    assert _is_exact_match(cand, _TITLE, _ARTIST, _DURATION)


def test_title_prefix_difference_still_matches():
    """У SoundCloud в названии префикс релиза, в YouTube Music его нет."""
    cand = _candidate("Andante Risoluto", "Nicholas Britell", 148)
    assert _is_exact_match(cand, _TITLE, _ARTIST, _DURATION)


def test_cover_by_other_artist_rejected():
    """London Music Works, 87 c — то же название, но чужая запись."""
    cand = _candidate("Succession - Andante Risoluto", "London Music Works", 87)
    assert not _is_exact_match(cand, _TITLE, _ARTIST, _DURATION)


def test_piano_cover_with_same_artist_name_rejected():
    """Длительность за порогом — даже при похожем названии это другая версия."""
    cand = _candidate("Andante Risoluto (Piano Cover)", "Nicholas Britell", 153)
    assert not _is_exact_match(cand, _TITLE, _ARTIST, _DURATION)


def test_different_track_of_same_artist_rejected():
    """Другой трек того же композитора с близкой длительностью."""
    cand = _candidate("Andante in C Minor", "Nicholas Britell", 148)
    assert not _is_exact_match(cand, _TITLE, _ARTIST, _DURATION)


def test_unknown_duration_rejected():
    """Без длительности отсечь кавер нечем — подмену не делаем."""
    cand = _candidate("Succession - Andante Risoluto", "Nicholas Britell", 0)
    assert not _is_exact_match(cand, _TITLE, _ARTIST, _DURATION)
    assert not _is_exact_match(
        _candidate("Succession - Andante Risoluto", "Nicholas Britell", 148),
        _TITLE, _ARTIST, 0,
    )


# --- Второй этап: обычный YouTube -----------------------------------------
# Каталог YouTube Music — подмножество YouTube. Реальный случай: sc/1809571188
# «Врата Овертона — Небратья» (240 c) в ytmusic отсутствует вовсе, а на YouTube
# лежит той же длительности реаплоад (MdnrHiOSIn4) — его и играем.
_YT_TITLE = "Небратья"
_YT_ARTIST = "Врата Овертона"
_YT_DURATION = 240


def _entry(title: str, uploader: str, duration):
    return {"id": "vid", "title": title, "uploader": uploader, "duration": duration}


def test_youtube_reupload_matches():
    """Канал произвольный — важно, что артист и название есть в тексте."""
    entry = _entry("врата овертона - небратья", "CuberGuesser", 240)
    assert _youtube_entry_matches(entry, _YT_TITLE, _YT_ARTIST, _YT_DURATION)


def test_youtube_artist_in_channel_name_matches():
    entry = _entry("Небратья", "Врата Овертона", 241)
    assert _youtube_entry_matches(entry, _YT_TITLE, _YT_ARTIST, _YT_DURATION)


def test_youtube_edit_and_slowed_rejected():
    """Длительность отсекает Edit (282 c) и Slowed + reverb (290 c)."""
    for title, dur in (
        ("Врата Овертона - Небратья (Edit)", 282),
        ("Врата Овертона - Небратья (Slowed + reverb)", 290),
        ("Врата Овертона - Небратья (Анонс)", 67),
    ):
        assert not _youtube_entry_matches(
            _entry(title, "X", dur), _YT_TITLE, _YT_ARTIST, _YT_DURATION
        )


def test_youtube_other_song_same_duration_rejected():
    entry = _entry("Врата Овертона - Цветет герань", "X", 240)
    assert not _youtube_entry_matches(entry, _YT_TITLE, _YT_ARTIST, _YT_DURATION)


def test_youtube_same_title_other_artist_rejected():
    """Одноимённый трек другого исполнителя — артист в тексте не встречается."""
    entry = _entry("Небратья - другая группа", "Кто-то", 240)
    assert not _youtube_entry_matches(entry, _YT_TITLE, _YT_ARTIST, _YT_DURATION)


def test_youtube_entry_without_duration_rejected():
    """Без длительности отсечь версии нечем (extract_flat её иногда не даёт)."""
    entry = _entry("врата овертона - небратья", "X", None)
    assert not _youtube_entry_matches(entry, _YT_TITLE, _YT_ARTIST, _YT_DURATION)


def test_match_key_ignores_punctuation_and_case():
    assert _match_key("Succession - Andante Risoluto") == _match_key(
        "SUCCESSION: Andante, Risoluto!"
    )
    assert _match_key("") == ""
