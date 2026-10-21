"""Полки главной (app/routers/home.py): релизы, открытия недели, давно не
слушали."""

from datetime import date, datetime, timedelta, timezone

from sqlalchemy import insert

from app import artist_cards, push
from app.models import Playlist, Track, playlist_tracks, user_track_plays, user_track_skips
from app.routers import home

from tests.conftest import auth_headers, create_user


def _track(db, title, artist, duration=200, listeners=0):
    track = Track(title=title, artist=artist, duration=duration, unique_listener_count=listeners)
    db.add(track)
    db.commit()
    db.refresh(track)
    return track


def _like(db, user, tracks):
    playlist = Playlist(name="Понравившиеся", is_liked=True, owner_id=user.id)
    db.add(playlist)
    db.commit()
    for position, track in enumerate(tracks):
        db.execute(insert(playlist_tracks).values(playlist_id=playlist.id, track_id=track.id, position=position))
    db.commit()


def _played(db, user, track, when):
    db.execute(insert(user_track_plays).values(user_id=user.id, track_id=track.id, play_count=1, last_played=when))
    db.commit()


# ─────────────────────────────── релизы ───────────────────────────────


def test_recent_releases_window_and_order():
    today = date(2026, 10, 22)
    items = [
        {"id": 1, "date": "2026-10-20"},
        {"id": 2, "date": "2026-09-01"},  # старше окна
        {"id": 3, "date": "2026-11-01"},  # анонс
        {"id": 4, "date": "2026-10-21"},
        {"id": 1, "date": "2026-10-20"},  # дубль от соавтора
    ]
    assert [r["id"] for r in home.recent_releases(items, today)] == [4, 1]


def test_releases_endpoint_uses_favorite_artists(client, db, monkeypatch):
    user = create_user(db, "listener")
    user.preferred_artists = ["Artist A"]
    db.commit()
    today = datetime.now(timezone.utc).date().isoformat()

    async def releases(name):
        return [{"id": 7, "title": "New", "type": "single", "date": today, "cover": "", "artist": name}]

    monkeypatch.setattr(push, "artist_releases", releases)
    resp = client.get("/api/home/releases", headers=auth_headers(client, "listener"))
    assert resp.status_code == 200, resp.text
    assert [(r["id"], r["artist"]) for r in resp.json()] == [(7, "Artist A")]


# ─────────────────────────────── открытия недели ───────────────────────────────


def test_pick_new_artists_round_robin_skips_heard():
    lists = [["B1", "Heard", "B2"], ["C1", "C2"]]
    assert home.pick_new_artists(lists, {"heard"}, 10) == ["b1", "c1", "c2", "b2"]
    assert home.pick_new_artists(lists, set(), 2) == ["b1", "c1"]


def test_weekly_takes_unheard_similar_artists(client, db, monkeypatch):
    user = create_user(db, "weekly")
    user.preferred_artists = ["Fav"]
    db.commit()
    heard = _track(db, "Old", "Heard")
    _played(db, user, heard, datetime.now(timezone.utc))
    fresh = []
    for i in range(6):
        for j in range(3):
            fresh.append(_track(db, f"T{i}{j}", f"New{i}", listeners=j))
    skipped = _track(db, "Skipped", "New0", listeners=99)
    db.execute(insert(user_track_skips).values(user_id=user.id, track_id=skipped.id))
    db.commit()

    async def similar(name, limit=3, exclude=()):
        return [{"name": "Heard"}] + [{"name": f"New{i}"} for i in range(6)]

    monkeypatch.setattr(artist_cards, "similar_cards", similar)
    monkeypatch.setattr(home, "WEEKLY_MIN", 4)
    resp = client.get("/api/home/weekly", headers=auth_headers(client, "weekly"))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    artists = [t["artist"] for t in body]
    assert "Heard" not in artists
    assert skipped.id not in {t["id"] for t in body}
    # Не больше двух треков артиста, самые слушаемые.
    assert max(artists.count(a) for a in set(artists)) == home.WEEKLY_PER_ARTIST
    assert len(body) == 6 * home.WEEKLY_PER_ARTIST

    # Подборка заморожена на неделю: новые похожие её не меняют.
    async def other(name, limit=3, exclude=()):
        return [{"name": "Other"}]

    monkeypatch.setattr(artist_cards, "similar_cards", other)
    again = client.get("/api/home/weekly", headers=auth_headers(client, "weekly")).json()
    assert [t["id"] for t in again] == [t["id"] for t in body]


def test_weekly_hidden_when_too_few(client, db, monkeypatch):
    user = create_user(db, "sparse")
    user.preferred_artists = ["Fav"]
    db.commit()
    _track(db, "Only", "Lonely")

    async def similar(name, limit=3, exclude=()):
        return [{"name": "Lonely"}]

    monkeypatch.setattr(artist_cards, "similar_cards", similar)
    resp = client.get("/api/home/weekly", headers=auth_headers(client, "sparse"))
    assert resp.status_code == 200
    assert resp.json() == []


# ─────────────────────────────── давно не слушали ───────────────────────────────


def test_rediscover_returns_old_likes_only(client, db):
    user = create_user(db, "fan")
    now = datetime.now(timezone.utc)
    old = [_track(db, f"Old{i}", "A") for i in range(7)]
    recent = _track(db, "Recent", "A")
    disliked = _track(db, "Disliked", "A")
    _like(db, user, old + [recent, disliked])
    for track in old[:3]:
        _played(db, user, track, now - timedelta(days=60))
    _played(db, user, recent, now - timedelta(days=2))
    db.execute(insert(user_track_skips).values(user_id=user.id, track_id=disliked.id, disliked=True))
    db.commit()

    resp = client.get("/api/home/rediscover", headers=auth_headers(client, "fan"))
    assert resp.status_code == 200, resp.text
    assert {t["id"] for t in resp.json()} == {t.id for t in old}


def test_rediscover_hidden_with_few_likes(client, db):
    user = create_user(db, "newbie")
    _like(db, user, [_track(db, "One", "A")])
    resp = client.get("/api/home/rediscover", headers=auth_headers(client, "newbie"))
    assert resp.json() == []
