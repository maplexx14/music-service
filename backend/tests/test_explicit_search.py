"""Цензура в поиске: /search/external/grouped предпочитает нецензурированные версии.

YouTube Music держит у одной записи обе версии — оригинал (isExplicit=True) и
clean-редакцию (False), часто с одним названием. Раньше выдача показывала
какую попало. Теперь clean-версии маркируются (бейдж на фронте), уходят вниз
секции, а при дедупе проигрывают нецензурированным независимо от источника.
"""

import asyncio

from app.routers import aggregate
from app.schemas import ExternalTrackResponse


def _ext(
    source: str,
    title: str,
    artist: str = "A",
    explicit: bool = False,
    duration: int = 200,
) -> ExternalTrackResponse:
    return ExternalTrackResponse(
        id=f"{source}:{title}",
        source=source,
        external_id=title,
        title=title,
        artist=artist,
        duration=duration,
        stream_url="",
        is_explicit=explicit,
    )


# --- маркировка и приоритет -------------------------------------------------


def test_mark_clean_detects_block_markers_only():
    assert aggregate._mark_clean(_ext("ytmusic", "Song (Clean)")).is_clean is True
    assert aggregate._mark_clean(_ext("ytmusic", "Song [Radio Edit]")).is_clean is True
    # «Clean Bandit» — артист в названии, а не маркер цензуры
    assert aggregate._mark_clean(_ext("ytmusic", "Rockabye", artist="Clean Bandit")).is_clean is False
    assert aggregate._mark_clean(_ext("ytmusic", "Song")).is_clean is False


def test_mark_clean_does_not_mutate_provider_object():
    track = _ext("ytmusic", "Song (Clean)")
    marked = aggregate._mark_clean(track)
    assert marked.is_clean is True
    assert track.is_clean is False


def test_prefer_uncensored_moves_clean_to_tail_stably():
    tracks = [
        _ext("ytmusic", "One (Clean)"),
        _ext("ytmusic", "Two"),
        _ext("ytmusic", "Three (Radio Edit)"),
    ]
    titles = [t.title for t in aggregate._prefer_uncensored(tracks)]
    assert titles == ["Two", "One (Clean)", "Three (Radio Edit)"]


# --- склейка источников (/external) ------------------------------------------


def test_merge_prefers_uncensored_over_source_rank():
    """Дубль «clean ytmusic vs обычный soundcloud» — побеждает soundcloud."""
    ytmusic = [_ext("ytmusic", "Song (Clean)")]
    soundcloud = [_ext("soundcloud", "Song")]

    merged = aggregate._merge_sources([ytmusic, soundcloud], limit=10)

    assert [t.source for t in merged] == ["soundcloud"]


def test_merge_uncensored_duplicate_replaces_clean():
    """Цензурный дубль заменяется нецензурированным из другого источника."""
    ytmusic = [_ext("ytmusic", "Song (Clean)"), _ext("ytmusic", "Other")]
    soundcloud = [_ext("soundcloud", "Song")]

    merged = aggregate._merge_sources([ytmusic, soundcloud], limit=10)

    # clean-версия исчезает, показываются обе записи — обе нецензурированные
    assert [t.title for t in merged] == ["Other", "Song"]


def test_merge_keeps_rank_when_neither_is_clean():
    """Без цензуры правило рангов прежнее: ytmusic бьёт soundcloud."""
    ytmusic = [_ext("ytmusic", "Song")]
    soundcloud = [_ext("soundcloud", "Song")]

    merged = aggregate._merge_sources([ytmusic, soundcloud], limit=10)

    assert merged[0].source == "ytmusic"


# --- группированная выдача (/external/grouped) --------------------------------


def _patch_providers(monkeypatch, *, catalog=(), songs=(), sc=()):
    async def fake_catalog(_request, q, limit=10):
        return list(catalog)

    async def fake_songs(_request, q, limit=10):
        return list(songs)

    async def fake_sc(_request, q, limit=10):
        return list(sc)

    monkeypatch.setattr(aggregate.ytdlp, "ytmusic_artist_catalog", fake_catalog)
    monkeypatch.setattr(aggregate.ytdlp, "search_ytmusic", fake_songs)
    monkeypatch.setattr(aggregate.soundcloud, "search_soundcloud", fake_sc)


def test_grouped_prefers_explicit_version_of_same_track(monkeypatch):
    """Обе версии одним названием — показываем explicit, clean не отдаём."""
    _patch_providers(
        monkeypatch,
        songs=[_ext("ytmusic", "Song", explicit=False), _ext("ytmusic", "Song", explicit=True)],
    )

    grouped = asyncio.run(aggregate.search_external_grouped(None, "song", 30))

    assert len(grouped.ytmusic) == 1
    assert grouped.ytmusic[0].is_explicit is True


def test_grouped_explicit_version_takes_the_cleans_position(monkeypatch):
    """Порядок выдачи не ломаем: explicit встаёт на место clean-версии."""
    _patch_providers(
        monkeypatch,
        songs=[
            _ext("ytmusic", "First (Clean)"),
            _ext("ytmusic", "Second"),
            _ext("ytmusic", "First", explicit=True),
        ],
    )

    grouped = asyncio.run(aggregate.search_external_grouped(None, "q", 30))

    assert [t.title for t in grouped.ytmusic] == ["First", "Second"]


def test_grouped_replaces_clean_with_soundcloud_version(monkeypatch):
    """clean-версия заменяется записью из SoundCloud на том же месте выдачи."""
    _patch_providers(
        monkeypatch,
        songs=[_ext("ytmusic", "Song (Clean)"), _ext("ytmusic", "Other")],
        sc=[_ext("soundcloud", "Song")],
    )

    grouped = asyncio.run(aggregate.search_external_grouped(None, "q", 30))

    # позиция в выдаче сохранена, источник сменился на нецензурированный
    assert [(t.title, t.source) for t in grouped.ytmusic] == [
        ("Song", "soundcloud"),
        ("Other", "ytmusic"),
    ]
    # и дублем секцией SoundCloud ниже не показывается
    assert grouped.soundcloud == []


def test_grouped_keeps_clean_without_soundcloud_equivalent(monkeypatch):
    """Эквивалента в SoundCloud нет — clean остаётся, но с бейджем и в хвосте."""
    _patch_providers(
        monkeypatch,
        songs=[_ext("ytmusic", "Song"), _ext("ytmusic", "Loud (Clean)")],
        sc=[_ext("soundcloud", "Song (slowed + reverb)")],
    )

    grouped = asyncio.run(aggregate.search_external_grouped(None, "q", 30))

    assert [t.title for t in grouped.ytmusic] == ["Song", "Loud (Clean)"]
    assert grouped.ytmusic[1].is_clean is True


def test_grouped_dedup_between_sources_unchanged(monkeypatch):
    """Регрессия: дубль SoundCloud уже показанного ytmusic-трека исчезает."""
    _patch_providers(
        monkeypatch,
        songs=[_ext("ytmusic", "Song")],
        sc=[_ext("soundcloud", "Song"), _ext("soundcloud", "Other")],
    )

    grouped = asyncio.run(aggregate.search_external_grouped(None, "q", 30))

    assert [t.title for t in grouped.ytmusic] == ["Song"]
    assert [t.title for t in grouped.soundcloud] == ["Other"]
