"""Цензура при импорте: explicit-трек не должен подменяться clean-версией ytmusic.

У одной записи в YouTube Music часто лежат обе версии: оригинал
(isExplicit=True) и clean-редакция (isExplicit=False). Матчер не различал их
и мог молча взять цензурированную. Теперь при равном счёте выигрывает
explicit-кандидат, а если источник (Spotify Web API) говорит explicit, а
ytmusic отдал только clean — ищем ту же запись на SoundCloud, где цензуры нет.
"""

import asyncio

from app.routers import importer, spotify
from app.schemas import ExternalTrackResponse


def _yt(external_id="yt1", title="Song", artist="A", duration=200, explicit=False):
    return ExternalTrackResponse(
        id=f"ytmusic:{external_id}",
        source="ytmusic",
        external_id=external_id,
        title=title,
        artist=artist,
        duration=duration,
        stream_url=f"https://example.test/stream/{external_id}",
        is_explicit=explicit,
    )


def _sc(external_id="sc1", title="Song", artist="A", duration=200):
    return ExternalTrackResponse(
        id=f"soundcloud:{external_id}",
        source="soundcloud",
        external_id=external_id,
        title=title,
        artist=artist,
        duration=duration,
        stream_url=f"https://example.test/sc/{external_id}",
    )


def _entry(explicit):
    return {
        "title": "Song",
        "artists": ["A"],
        "album": None,
        "duration": 200,
        "explicit": explicit,
    }


# --- выбор кандидата --------------------------------------------------------


def test_select_best_match_prefers_explicit_when_tied():
    clean = _yt("yt-clean", explicit=False)
    explicit = _yt("yt-orig", explicit=True)
    assert importer._select_best_match([clean, explicit], "A", "Song") is explicit
    # порядок кандидатов не важен
    assert importer._select_best_match([explicit, clean], "A", "Song") is explicit


def test_select_best_match_score_beats_explicit():
    # Explicit не должен побеждать за счёт худшего совпадения: у clean точное
    # название, у explicit — лишь вхождение.
    clean = _yt("yt-clean", title="Song", explicit=False)
    explicit = _yt("yt-orig", title="Song (Remix)", explicit=True)
    assert importer._select_best_match([explicit, clean], "A", "Song") is clean


# --- SoundCloud-фолбэк ------------------------------------------------------


def test_explicit_source_with_clean_ytmusic_match_falls_back_to_soundcloud(monkeypatch):
    async def fake_search_ytmusic(_request, query, limit=3):
        return [_yt("yt-clean", explicit=False)]

    sc_queries = []

    async def fake_search_soundcloud(_request, query, limit=10):
        sc_queries.append(query)
        return [_sc()]

    monkeypatch.setattr(importer.ytdlp, "search_ytmusic", fake_search_ytmusic)
    monkeypatch.setattr(
        importer.soundcloud, "search_soundcloud", fake_search_soundcloud
    )

    payload, matched = asyncio.run(
        importer._entry_to_import(None, "spotify", _entry(explicit=True))
    )
    assert payload is not None
    assert payload.source == "soundcloud"
    assert payload.external_id == "sc1"
    assert matched is True
    # запрос собран так же, как для ytmusic-матчинга: «артист название»
    assert sc_queries == ["A Song"]


def test_explicit_ytmusic_match_stays_on_ytmusic(monkeypatch):
    async def fake_search_ytmusic(_request, query, limit=3):
        return [_yt("yt-orig", explicit=True)]

    async def fail_sc(*_args, **_kwargs):
        raise AssertionError("SoundCloud-фолбэк не должен вызываться для explicit-матча")

    monkeypatch.setattr(importer.ytdlp, "search_ytmusic", fake_search_ytmusic)
    monkeypatch.setattr(importer.soundcloud, "search_soundcloud", fail_sc)

    payload, _ = asyncio.run(
        importer._entry_to_import(None, "spotify", _entry(explicit=True))
    )
    assert payload.source == "ytmusic"


def test_non_explicit_source_never_triggers_fallback(monkeypatch):
    # Источник не explicit (или флага нет — Yandex): non-explicit матч
    # ytmusic не считается цензурой.
    async def fake_search_ytmusic(_request, query, limit=3):
        return [_yt("yt-clean", explicit=False)]

    async def fail_sc(*_args, **_kwargs):
        raise AssertionError("SoundCloud-фолбэк не должен вызываться без explicit-источника")

    monkeypatch.setattr(importer.ytdlp, "search_ytmusic", fake_search_ytmusic)
    monkeypatch.setattr(importer.soundcloud, "search_soundcloud", fail_sc)

    payload, _ = asyncio.run(
        importer._entry_to_import(None, "spotify", _entry(explicit=False))
    )
    assert payload.source == "ytmusic"


def test_fallback_survives_soundcloud_miss(monkeypatch):
    # SoundCloud-эквивалента нет — остаёмся на цензурном ytmusic-матче:
    # лучше clean-версия, чем пропущенный трек.
    async def fake_search_ytmusic(_request, query, limit=3):
        return [_yt("yt-clean", explicit=False)]

    async def fake_search_soundcloud(_request, query, limit=10):
        return []

    monkeypatch.setattr(importer.ytdlp, "search_ytmusic", fake_search_ytmusic)
    monkeypatch.setattr(
        importer.soundcloud, "search_soundcloud", fake_search_soundcloud
    )

    payload, _ = asyncio.run(
        importer._entry_to_import(None, "spotify", _entry(explicit=True))
    )
    assert payload.source == "ytmusic"


def test_fallback_rejects_non_exact_soundcloud_match(monkeypatch):
    # «Та же запись» = артист + название + длительность; чужой трек с той же
    # длительностью подменять нельзя.
    async def fake_search_ytmusic(_request, query, limit=3):
        return [_yt("yt-clean", explicit=False)]

    async def fake_search_soundcloud(_request, query, limit=10):
        return [
            _sc("sc-remix", title="Song (slowed + reverb)"),
            _sc("sc-other", artist="Someone Else"),
            _sc("sc-longer", duration=240),
        ]

    monkeypatch.setattr(importer.ytdlp, "search_ytmusic", fake_search_ytmusic)
    monkeypatch.setattr(
        importer.soundcloud, "search_soundcloud", fake_search_soundcloud
    )

    payload, _ = asyncio.run(
        importer._entry_to_import(None, "spotify", _entry(explicit=True))
    )
    assert payload.source == "ytmusic"


# --- источник правды: Spotify -----------------------------------------------


def test_track_from_object_maps_explicit():
    obj = {
        "type": "track",
        "id": "t1",
        "name": "Song",
        "artists": [{"name": "A"}],
        "explicit": True,
    }
    assert spotify._track_from_object(obj).explicit is True
    obj["explicit"] = False
    assert spotify._track_from_object(obj).explicit is False


def test_tracks_to_entries_carries_explicit():
    track = spotify.SpotifyTrack(
        id="t1", title="Song", artist="A", duration=200, explicit=True
    )
    assert importer._tracks_to_entries([track])[0]["explicit"] is True
