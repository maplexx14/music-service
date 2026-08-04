"""Поиск по артисту: в выдаче должны быть ЕГО треки, и не десяток из сотни.

Две регрессии, ради которых написано:

1. `/search/external` склеивал источники сортировкой по _SOURCE_RANK по
   возрастанию, то есть soundcloud (ранг 1) шёл первым, а limit равнялся
   размеру выдачи одного источника. SoundCloud занимал все слоты целиком, и
   треков артиста из YouTube Music в результатах не оставалось вообще.

2. Локальный `/api/search` искал всю строку запроса одним LIKE и ранжировал
   выдачу только по play_count: многословный запрос не находил ничего, а на
   имени артиста лимит съедали чужие треки, где это имя мелькнуло в названии.
"""

from app.models import Track
from app.routers.aggregate import _merge_sources
from app.routers.ytdlp import _query_names_artist
from app.schemas import ExternalTrackResponse


def _ext(source: str, title: str, artist: str = "Artist") -> ExternalTrackResponse:
    return ExternalTrackResponse(
        id=f"{source}:{title}",
        source=source,
        external_id=title,
        title=title,
        artist=artist,
        duration=180,
        stream_url="",
    )


def _titles(tracks):
    return [t.title for t in tracks]


def test_truncation_does_not_drop_a_whole_source():
    """Лимит меньше выдачи одного источника — представлены всё равно оба."""
    ytmusic = [_ext("ytmusic", f"y{i}") for i in range(10)]
    soundcloud = [_ext("soundcloud", f"s{i}") for i in range(10)]

    merged = _merge_sources([ytmusic, soundcloud], limit=6)

    assert len(merged) == 6
    assert {t.source for t in merged} == {"ytmusic", "soundcloud"}


def test_first_source_leads_and_keeps_relevance_order():
    """Round-robin: первый список идёт первым, порядок внутри списка сохранён."""
    catalog = [_ext("ytmusic", f"c{i}") for i in range(3)]
    soundcloud = [_ext("soundcloud", f"s{i}") for i in range(3)]

    merged = _merge_sources([catalog, soundcloud], limit=6)

    assert _titles(merged) == ["c0", "s0", "c1", "s1", "c2", "s2"]


def test_short_source_does_not_waste_slots():
    """Кончился один список — оставшиеся слоты добирает другой, а не пустота."""
    catalog = [_ext("ytmusic", "c0")]
    soundcloud = [_ext("soundcloud", f"s{i}") for i in range(4)]

    merged = _merge_sources([catalog, soundcloud], limit=5)

    assert _titles(merged) == ["c0", "s0", "s1", "s2", "s3"]


def test_duplicate_keeps_better_source_and_stays_in_output():
    """Дубль схлопывается в вариант с более высоким рангом — и не пропадает."""
    ytmusic = [_ext("ytmusic", "Numb")]
    soundcloud = [_ext("soundcloud", "Numb"), _ext("soundcloud", "Faint")]

    merged = _merge_sources([ytmusic, soundcloud], limit=10)

    assert _titles(merged) == ["Numb", "Faint"]
    assert merged[0].source == "ytmusic"


def test_artist_catalog_gate_accepts_partial_name():
    """«weeknd» — это The Weeknd: каталог артиста подтягиваем."""
    assert _query_names_artist("weeknd", "The Weeknd")
    assert _query_names_artist("Linkin Park", "Linkin Park")


def test_artist_catalog_gate_rejects_track_title():
    """Искали название трека — каталог случайного артиста протечь не должен."""
    assert not _query_names_artist("numb", "Linkin Park")
    assert not _query_names_artist("", "Linkin Park")


def _add_tracks(db, *specs):
    for title, artist, plays in specs:
        db.add(Track(title=title, artist=artist, duration=180, play_count=plays))
    db.commit()


# Запросы в тестах разные: ключ кэша поиска — это строка запроса, и на машине
# с живым Redis одинаковые запросы протекали бы из теста в тест.


def test_local_search_ranks_artist_tracks_first(client, db):
    """Чужой хит с большим play_count не должен вытеснять треки артиста."""
    _add_tracks(
        db,
        ("Numb", "Linkin Park", 1),
        ("Faint", "Linkin Park", 2),
        ("Linkin Park Tribute", "Cover Band", 9999),
    )

    resp = client.get("/api/search", params={"q": "linkin park", "limit": 50})

    assert resp.status_code == 200, resp.text
    titles = [t["title"] for t in resp.json()["tracks"]]
    assert titles[:2] == ["Faint", "Numb"], titles
    assert "Linkin Park Tribute" in titles


def test_local_search_matches_words_in_different_columns(client, db):
    """'deftones digital bath' — имя в artist, название в title: раньше 0 результатов."""
    _add_tracks(db, ("Digital Bath", "Deftones", 0), ("Change", "Deftones", 0))

    resp = client.get("/api/search", params={"q": "deftones digital bath", "limit": 50})

    assert resp.status_code == 200, resp.text
    assert [t["title"] for t in resp.json()["tracks"]] == ["Digital Bath"]


def test_local_search_returns_whole_discography(client, db):
    """Дискография длиннее старого лимита в 20 — отдаём её целиком."""
    _add_tracks(db, *[(f"Song {i}", "Portishead", 0) for i in range(30)])

    resp = client.get("/api/search", params={"q": "portishead", "limit": 50})

    assert resp.status_code == 200, resp.text
    assert len(resp.json()["tracks"]) == 30


def test_local_search_treats_wildcards_as_literals(client, db):
    """'%' в запросе — это символ, а не «покажи всё подряд»."""
    _add_tracks(db, ("Teardrop", "Massive Attack", 0))

    resp = client.get("/api/search", params={"q": "%", "limit": 50})

    assert resp.status_code == 200, resp.text
    assert resp.json()["tracks"] == []


def test_local_search_ignores_blank_query(client, db):
    """Запрос из пробелов — пустая выдача, а не вся библиотека."""
    _add_tracks(db, ("Teardrop", "Massive Attack", 0))

    resp = client.get("/api/search", params={"q": "   ", "limit": 50})

    assert resp.status_code == 200, resp.text
    assert resp.json()["tracks"] == []
