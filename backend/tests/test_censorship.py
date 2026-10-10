"""Оригиналы вместо треков, зацензуренных по закону РФ (app/censorship.py).

Реальный случай: СЕРЕГА ПИРАТ — «В этой траве» в YouTube Music заменён
цензурной версией «В этой оу е», оригинал лежит на SoundCloud у артиста.
"""

import asyncio

import pytest
from starlette.requests import Request

from app import censorship
from app.models import CensorOverride, Track
from app.routers import ytdlp
from app.schemas import ExternalTrackResponse
from tests.conftest import TestingSessionLocal, auth_headers, create_user


@pytest.fixture(autouse=True)
def _isolated(monkeypatch):
    store = {}

    async def get_cache(key):
        return store.get(key)

    async def set_cache(key, value, expire=None):
        store[key] = value

    monkeypatch.setattr(censorship, "SessionLocal", TestingSessionLocal)
    monkeypatch.setattr(censorship, "get_cache_async", get_cache)
    monkeypatch.setattr(censorship, "set_cache_async", set_cache)
    monkeypatch.setattr(censorship, "_deezer_indexed", {})
    censorship.invalidate()
    yield store
    censorship.invalidate()


def _override(db, status="confirmed", video_id="CENSORED01"):
    row = CensorOverride(
        source="ytmusic",
        external_id=video_id,
        censored_title="В этой оу е",
        censored_artist="СЕРЕГА ПИРАТ",
        censored_key=censorship.censored_key("СЕРЕГА ПИРАТ", "В этой оу е"),
        original_id="1788382411",
        original_permalink="https://soundcloud.com/seregapirat/v-etoi-trave",
        original_title="В этой траве",
        original_artist="СЕРЕГА ПИРАТ",
        original_duration=129,
        status=status,
    )
    db.add(row)
    db.commit()
    return row


def _yt(video_id, title="В этой оу е", artist="СЕРЕГА ПИРАТ"):
    return ExternalTrackResponse(
        id=f"ytmusic:{video_id}", source="ytmusic", external_id=video_id,
        title=title, artist=artist, duration=133,
        stream_url=f"/api/ytdlp/stream/{video_id}", is_explicit=True,
    )


def test_apply_overrides_shows_original_title_by_id_and_by_key(db, _isolated):
    _override(db)
    other = _yt("ALBUMVER01")  # та же цензурная запись под другим id
    unrelated = _yt("UNRELATED1", title="Шизоид")

    result = asyncio.run(censorship.apply_overrides([_yt("CENSORED01"), other, unrelated]))

    assert [(t.title, t.duration) for t in result] == [
        ("В этой траве", 129), ("В этой траве", 129), ("Шизоид", 133),
    ]
    # Оригинальные объекты не тронуты: они живут в провайдерских кэшах.
    assert other.title == "В этой оу е"
    # Второй id запомнен — стрим знает только id.
    assert _isolated["censor:alias:ALBUMVER01"] == "CENSORED01"
    assert asyncio.run(censorship.override_for_video("ALBUMVER01"))["original_id"] == "1788382411"


def test_suggested_override_is_not_applied(db):
    _override(db, status="suggested")

    assert asyncio.run(censorship.override_for_video("CENSORED01")) is None
    assert asyncio.run(censorship.apply_overrides([_yt("CENSORED01")]))[0].title == "В этой оу е"


def test_apply_overrides_handles_flow_dicts(db):
    _override(db)
    item = {"source": "ytmusic", "external_id": "CENSORED01", "title": "В этой оу е", "duration": 133}

    assert asyncio.run(censorship.apply_overrides([item]))[0]["title"] == "В этой траве"
    assert item["title"] == "В этой оу е"


def _request(query=b""):
    return Request({
        "type": "http", "method": "GET", "path": "/api/ytdlp/stream/CENSORED01",
        "query_string": query, "headers": [], "server": ("test", 80),
        "scheme": "http", "root_path": "",
    })


def test_stream_redirects_to_original_before_local_copy(db, monkeypatch):
    _override(db)
    monkeypatch.setattr(ytdlp, "_ytmusic", object())

    async def must_not_run(*_a, **_kw):
        raise AssertionError("цензурную копию не смотрим, если есть оригинал")

    monkeypatch.setattr(ytdlp, "_local_copy_path", must_not_run)

    response = asyncio.run(ytdlp.stream_ytmusic("CENSORED01", _request()))

    assert response.status_code == 307
    location = response.headers["location"]
    assert location.startswith("/api/soundcloud/stream/")
    assert location.endswith("?vid=CENSORED01")


def test_stream_falls_back_to_catalog_when_original_failed(db, monkeypatch):
    # scfallback=1 — SoundCloud не отдал оригинал: лучше цензура, чем тишина,
    # и без бесконечного круга редиректов.
    _override(db)
    monkeypatch.setattr(ytdlp, "_ytmusic", object())

    async def local_copy(_video_id):
        return "/cache/CENSORED01.mp3"

    async def cached_audio(request, cache_id, resolver, archive_key=None):
        return "catalog"

    monkeypatch.setattr(ytdlp, "_local_copy_path", local_copy)
    monkeypatch.setattr(ytdlp, "stream_cached_audio", cached_audio)

    assert asyncio.run(ytdlp.stream_ytmusic("CENSORED01", _request(b"scfallback=1"))) == "catalog"


# skyline ryodan (shadowraze, jzxdx): аудиодорожка и Deezer зацензурены,
# клип того же релиза — нет. Оригинал привязан к аудиодорожке, а клип с другим
# написанием артиста в выдачу с подменой не попадал и играл цензурный Deezer.
# Общее у них — трек Deezer.
def _deezer_index(monkeypatch, matches):
    """matches: id ytmusic → трек Deezer (найденный матч)."""
    from app.routers import deezer

    monkeypatch.setattr(deezer, "enabled", lambda: True)

    async def await_match(video_id, timeout=3.0):
        return matches.get(video_id)

    async def cached_match(video_id):
        return matches.get(video_id)

    monkeypatch.setattr(deezer, "await_deezer_match", await_match)
    monkeypatch.setattr(deezer, "deezer_match_for", cached_match)
    asyncio.run(censorship._index_by_deezer(["CENSORED01"]))
    return deezer


def test_other_id_of_same_record_plays_original(db, monkeypatch, _isolated):
    _override(db)
    _deezer_index(monkeypatch, {"CENSORED01": "2299983955", "MUSICVIDEO": "2299983955"})
    monkeypatch.setattr(ytdlp, "_ytmusic", object())

    async def must_not_run(*_a, **_kw):
        raise AssertionError("цензурную копию не смотрим, если есть оригинал")

    monkeypatch.setattr(ytdlp, "_local_copy_path", must_not_run)

    response = asyncio.run(ytdlp.stream_ytmusic("MUSICVIDEO", _request()))

    assert response.status_code == 307
    assert response.headers["location"].endswith("?vid=MUSICVIDEO")
    # Матч Deezer живёт неделю — id запомнен как другой id той же записи.
    assert _isolated["censor:alias:MUSICVIDEO"] == "CENSORED01"


def test_other_record_in_deezer_is_not_redirected(db, monkeypatch):
    _override(db)
    _deezer_index(monkeypatch, {"CENSORED01": "2299983955", "UNRELATED1": "111"})

    assert asyncio.run(censorship.override_for_video("UNRELATED1")) is None
    assert asyncio.run(censorship.override_for_video("NOMATCH001")) is None


def test_cold_id_turns_to_original_once_deezer_match_found(db, monkeypatch):
    # На проверке в начале стрима матча ещё нет в кэше — он находится в шаге
    # Deezer, и цензурный трек Deezer не играет.
    _override(db)
    deezer = _deezer_index(monkeypatch, {"CENSORED01": "2299983955"})

    async def found(video_id, timeout=3.0):
        return "2299983955"

    async def no_edited(_video_id):
        return False

    async def download(video_id, sng_id, request, replace=False):
        return "deezer"

    monkeypatch.setattr(deezer, "await_deezer_match", found)
    monkeypatch.setattr(deezer, "_prefer_soundcloud_over_edited", no_edited)
    monkeypatch.setattr(deezer, "_stream_download", download)

    response = asyncio.run(deezer.stream_for_ytmusic("MUSICVIDEO", _request()))
    assert response.status_code == 307
    assert response.headers["location"].endswith("?vid=MUSICVIDEO")
    # Оригинал не отдался — играет что есть, без круга редиректов.
    assert asyncio.run(deezer.stream_for_ytmusic("MUSICVIDEO", _request(b"scfallback=1"))) == "deezer"


def _sc_item(title, uploader, duration, track_id=1, publisher=None):
    return {
        "id": track_id,
        "permalink_url": f"https://soundcloud.com/{uploader}/{track_id}",
        "title": title,
        "duration": duration * 1000,
        "user": {"username": uploader},
        "publisher_metadata": {"artist": publisher} if publisher else {},
        "media": {"transcodings": [{"format": {"protocol": "progressive"}, "snipped": False}]},
        "playback_count": 1000,
    }


def test_candidates_keep_renamed_original_and_drop_derivatives():
    title, artist = "В этой оу е", "СЕРЕГА ПИРАТ"
    original = censorship.score_candidate(_sc_item("В этой траве", "СЕРЕГА ПИРАТ", 129), title, artist, 133)
    assert original and original["official"]
    # Ускоренная версия, чужой артист и другая длительность — не оригинал.
    assert censorship.score_candidate(
        _sc_item("Серега Пират - В этой траве (speed up)", "LiNaX", 131), title, artist, 133
    ) is None
    assert censorship.score_candidate(_sc_item("В этой траве", "someone", 129), title, artist, 133) is None
    assert censorship.score_candidate(_sc_item("В этой траве", "СЕРЕГА ПИРАТ", 200), title, artist, 133) is None


def test_looks_censored_needs_changed_title():
    assert censorship.looks_censored("В этой оу е", "В этой траве")
    assert censorship.looks_censored("В ЭТ*Й Т**ВЕ", "В этой траве")
    # Название не менялось — по метаданным цензуру не отличить.
    assert not censorship.looks_censored("Клей", "Клей")
    assert not censorship.looks_censored("В этой оу е", "Шизоид")


def _stub_search(monkeypatch, *items):
    from app.routers import deezer

    monkeypatch.setattr(deezer, "_ytmusic_meta_blocking", lambda vid: ("В этой оу е", "СЕРЕГА ПИРАТ", 133))

    async def candidates(title, artist, duration):
        scored = [censorship.score_candidate(item, title, artist, duration) for item in items]
        return sorted((c for c in scored if c), key=lambda c: -c["score"])

    monkeypatch.setattr(censorship, "find_candidates", candidates)


def test_reliable_original_is_linked_automatically(db, monkeypatch):
    _stub_search(monkeypatch, _sc_item("В этой траве", "СЕРЕГА ПИРАТ", 129, 7))
    db.add(Track(title="В этой оу е", artist="СЕРЕГА ПИРАТ", duration=133,
                 source="ytmusic", external_id="CENSORED01"))
    db.commit()

    assert asyncio.run(censorship.suggest_for_video("CENSORED01"))["id"] == "7"

    row = db.query(CensorOverride).one()
    assert (row.status, row.original_title, row.created_by) == ("confirmed", "В этой траве", None)
    assert censorship._snapshot(row)["auto"] is True
    db.expire_all()
    assert db.query(Track).one().title == "В этой траве"
    assert asyncio.run(censorship.override_for_video("CENSORED01"))["original_id"] == "7"
    # Повторно тот же трек не трогаем.
    asyncio.run(censorship.suggest_for_video("CENSORED01"))
    assert db.query(CensorOverride).count() == 1


def test_doubtful_original_stays_a_suggestion(db, monkeypatch):
    # Длительность разошлась сильнее окна автопривязки — решает админ.
    _stub_search(monkeypatch, _sc_item("В этой траве", "СЕРЕГА ПИРАТ", 125, 7))

    asyncio.run(censorship.suggest_for_video("CENSORED01"))

    assert db.query(CensorOverride).one().status == "suggested"
    assert asyncio.run(censorship.override_for_video("CENSORED01")) is None


def test_auto_link_needs_single_unambiguous_candidate():
    title, artist = "В этой оу е", "СЕРЕГА ПИРАТ"
    best = censorship.score_candidate(_sc_item("В этой траве", "СЕРЕГА ПИРАТ", 131, 1), title, artist, 133)
    rival = censorship.score_candidate(_sc_item("В этой траве 2", "СЕРЕГА ПИРАТ", 132, 2), title, artist, 133)
    stranger = censorship.score_candidate(_sc_item("Шизоид", "СЕРЕГА ПИРАТ", 133, 3), title, artist, 133)

    assert censorship.auto_confirmable(title, 133, best, [best, stranger])
    assert not censorship.auto_confirmable(title, 133, best, [best, rival])


def test_version_suffix_is_not_censorship():
    assert not censorship.looks_censored("Шизоид", "Шизоид (live)")


def test_admin_links_original_and_library_follows(client, db, monkeypatch):
    create_user(db, "admin", is_admin=True)
    create_user(db, "bob")
    db.add(Track(title="В этой оу е", artist="СЕРЕГА ПИРАТ", duration=133,
                 source="ytmusic", external_id="CENSORED01"))
    db.commit()

    async def resolve(value):
        assert value == "https://soundcloud.com/seregapirat/v-etoi-trave"
        return {**_sc_item("В этой траве", "СЕРЕГА ПИРАТ", 129, 1788382411), "kind": "track"}

    monkeypatch.setattr(censorship, "resolve_soundcloud_track", resolve)
    payload = {
        "video_id": "CENSORED01", "title": "В этой оу е", "artist": "СЕРЕГА ПИРАТ",
        "soundcloud": "https://soundcloud.com/seregapirat/v-etoi-trave",
    }

    assert client.post("/api/censorship/overrides", json=payload,
                       headers=auth_headers(client, "bob")).status_code == 403

    created = client.post("/api/censorship/overrides", json=payload, headers=auth_headers(client, "admin"))
    assert created.status_code == 200, created.text
    assert created.json()["status"] == "confirmed"
    db.expire_all()
    assert db.query(Track).one().title == "В этой траве"
    assert asyncio.run(censorship.override_for_video("CENSORED01"))["original_id"] == "1788382411"

    rejected = client.post(f"/api/censorship/overrides/{created.json()['id']}/reject",
                           headers=auth_headers(client, "admin"))
    assert rejected.json()["status"] == "rejected"
    db.expire_all()
    assert db.query(Track).one().title == "В этой оу е"
    assert asyncio.run(censorship.override_for_video("CENSORED01")) is None

    listed = client.get("/api/censorship/overrides", params={"status": "rejected"},
                        headers=auth_headers(client, "admin"))
    assert [o["external_id"] for o in listed.json()] == ["CENSORED01"]


class _Cmp:
    def __init__(self, verdict, segments=()):
        self.verdict = verdict
        self.segments = list(segments)

    def as_dict(self):
        return {"verdict": self.verdict, "segments": [list(x) for x in self.segments]}


def _stub_audio(monkeypatch, verdicts):
    """verdicts: {id кандидата SoundCloud: verdict сравнения с каталогом}."""
    from app import audio_compare

    monkeypatch.setattr(censorship, "compare_with_candidates", _real_compare_with_candidates)
    monkeypatch.setattr(audio_compare, "available", lambda: True)

    async def catalog(_video_id):
        return "/cache/catalog.mp3", None

    async def download(candidate):
        return f"/tmp/{candidate['id']}.mp3"

    monkeypatch.setattr(censorship, "_catalog_audio", catalog)
    monkeypatch.setattr(censorship, "_soundcloud_audio", download)
    monkeypatch.setattr(censorship, "_remove", lambda path: None)
    compared = []

    def compare(_catalog, audio):
        track_id = audio.rsplit("/", 1)[1].split(".")[0]
        compared.append(track_id)
        verdict = verdicts[track_id]
        return _Cmp(verdict, [(2.0, 1.4, -8.1)] if verdict == "censored" else [])

    monkeypatch.setattr(audio_compare, "compare", compare)
    return compared


_real_compare_with_candidates = censorship.compare_with_candidates


def test_audio_links_reupload_when_title_unchanged(db, monkeypatch):
    # Случай «Клей»: название цензура не тронула, оригинал — только в
    # перезаливах. Метаданные тут бессильны, звук — нет.
    from app.routers import deezer

    monkeypatch.setattr(deezer, "_ytmusic_meta_blocking", lambda vid: ("Клей", "CUPSIZE", 147))

    async def candidates(title, artist, duration):
        return [
            censorship.score_candidate(_sc_item("CUPSIZE - Клей", "everlov3d", 144, 11), title, artist, duration),
            censorship.score_candidate(_sc_item("CUPSIZE - Клей", "fluffy", 142, 12), title, artist, duration),
        ]

    monkeypatch.setattr(censorship, "find_candidates", candidates)
    compared = _stub_audio(monkeypatch, {"11": "censored", "12": "censored"})

    assert asyncio.run(censorship.suggest_for_video("KLEI000001"))["id"] == "11"

    row = db.query(CensorOverride).one()
    assert (row.status, row.original_id) == ("confirmed", "11")
    assert row.evidence["segments"] == [[2.0, 1.4, -8.1]]
    assert compared == ["11"]


def test_audio_same_as_artist_upload_means_not_censored(db, monkeypatch):
    # По метаданным это была бы автопривязка, но звук совпал с заливом
    # артиста целиком — трек не цензурный.
    _stub_search(monkeypatch, _sc_item("В этой траве", "СЕРЕГА ПИРАТ", 129, 7))
    _stub_audio(monkeypatch, {"7": "same"})

    assert asyncio.run(censorship.suggest_for_video("CENSORED01")) is None
    assert db.query(CensorOverride).count() == 0


def test_audio_skips_reupload_of_censored_version(db, monkeypatch):
    # Первый перезалив сделан уже с цензурной версии (совпал целиком), второй
    # — оригинал.
    from app.routers import deezer

    monkeypatch.setattr(deezer, "_ytmusic_meta_blocking", lambda vid: ("Клей", "CUPSIZE", 147))

    async def candidates(title, artist, duration):
        return [
            censorship.score_candidate(_sc_item("CUPSIZE - Клей", "copycat", 147, 21), title, artist, duration),
            censorship.score_candidate(_sc_item("CUPSIZE - Клей", "everlov3d", 144, 22), title, artist, duration),
        ]

    monkeypatch.setattr(censorship, "find_candidates", candidates)
    compared = _stub_audio(monkeypatch, {"21": "same", "22": "censored"})

    assert asyncio.run(censorship.suggest_for_video("KLEI000001"))["id"] == "22"
    assert compared == ["21", "22"]


def test_admin_check_reports_why_nothing_was_linked(client, db, monkeypatch):
    from app.routers import deezer

    create_user(db, "admin", is_admin=True)
    monkeypatch.setattr(deezer, "_ytmusic_meta_blocking", lambda vid: ("Клей", "CUPSIZE", 147))

    async def candidates(title, artist, duration):
        return [censorship.score_candidate(_sc_item("CUPSIZE - Клей", "everlov3d", 144, 11), title, artist, duration)]

    monkeypatch.setattr(censorship, "find_candidates", candidates)
    _stub_audio(monkeypatch, {"11": "same"})

    report = client.post("/api/censorship/check", json={"video_id": "KLEI000001"},
                         headers=auth_headers(client, "admin")).json()

    assert report["outcome"] == "not_found"
    assert report["comparisons"][0]["verdict"] == "same"


def test_inconclusive_background_check_is_retried_soon(db, monkeypatch, _isolated):
    # Звук не скачался — флаг «проверено» короткий, а не на месяц.
    from app.routers import deezer

    monkeypatch.setattr(deezer, "_ytmusic_meta_blocking", lambda vid: ("Клей", "CUPSIZE", 147))

    async def candidates(title, artist, duration):
        return [censorship.score_candidate(_sc_item("CUPSIZE - Клей", "everlov3d", 144, 11), title, artist, duration)]

    monkeypatch.setattr(censorship, "find_candidates", candidates)
    ttl = {}

    async def set_cache(key, value, expire=None):
        ttl[key] = expire

    monkeypatch.setattr(censorship, "set_cache_async", set_cache)

    async def run():
        censorship.schedule_suggestion("KLEI000001")
        await asyncio.sleep(0.05)

    asyncio.run(run())

    assert ttl == {"censor:checked:v2:KLEI000001": censorship._RETRY_CHECK_TTL}


def test_library_stream_schedules_censor_check(client, db, monkeypatch):
    # Трек библиотеки играет из MinIO через /tracks/{id}/stream — проверка на
    # цензуру должна запускаться и отсюда.
    from app import storage

    create_user(db, "bob")
    track = Track(title="Клей", artist="CUPSIZE", duration=147, source="ytmusic",
                  external_id="bruZDcRPOD0", file_path="minio://music/external/ytmusic/bruZDcRPOD0.m4a")
    db.add(track)
    db.commit()
    scheduled = []
    monkeypatch.setattr(censorship, "schedule_suggestion", scheduled.append)

    async def minio_response(*_a, **_kw):
        from fastapi.responses import Response

        return Response(b"audio", media_type="audio/mp4")

    monkeypatch.setattr(storage, "minio_range_response_async", minio_response)

    response = client.get(f"/api/tracks/{track.id}/stream", headers=auth_headers(client, "bob"))

    assert response.status_code == 200
    assert scheduled == ["bruZDcRPOD0"]
