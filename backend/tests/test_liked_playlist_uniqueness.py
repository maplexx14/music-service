"""Один is_liked-плейлист на пользователя и устойчивость админ-панели.

Регресс: `get_or_create_liked_playlist` делал SELECT, потом INSERT, и два
одновременных лайка заводили пользователю второй плейлист "Понравившиеся".
Читатели брали id через `.scalar()` и падали с MultipleResultsFound. Виднее
всего это было в админ-панели: она считает профиль вкуса для КАЖДОГО
пользователя, поэтому одна дублирующая строка возвращала 500 на всю панель.
"""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.models import Playlist, Track, playlist_tracks
from app.playlist_signals import find_liked_playlist_id
from app.routers.tracks import get_or_create_liked_playlist

from tests.conftest import auth_headers, create_user


def _drop_unique_index(db):
    """Снимает уникальность, чтобы воспроизвести legacy-данные до 0021."""
    db.execute(text("DROP INDEX uq_playlists_owner_liked"))
    db.commit()


def test_second_liked_playlist_is_rejected(db):
    user = create_user(db)
    db.add(Playlist(name="Понравившиеся", is_liked=True, owner_id=user.id))
    db.commit()

    db.add(Playlist(name="Понравившиеся", is_liked=True, owner_id=user.id))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()

    # Обычные плейлисты индекс не ограничивает — их может быть сколько угодно.
    db.add_all([
        Playlist(name="Первый", is_liked=False, owner_id=user.id),
        Playlist(name="Второй", is_liked=False, owner_id=user.id),
    ])
    db.commit()


def test_find_liked_playlist_id_prefers_oldest_on_legacy_duplicates(db):
    user = create_user(db)
    _drop_unique_index(db)
    first = Playlist(name="Понравившиеся", is_liked=True, owner_id=user.id)
    second = Playlist(name="Понравившиеся", is_liked=True, owner_id=user.id)
    db.add_all([first, second])
    db.commit()

    # До фикса это был `.scalar()` и здесь падало MultipleResultsFound.
    assert find_liked_playlist_id(db, user.id) == min(first.id, second.id)
    # get_or_create выбирает тот же плейлист, иначе лайки разъехались бы.
    assert get_or_create_liked_playlist(db, user).id == min(first.id, second.id)


def test_admin_dashboard_survives_legacy_duplicate_liked_playlists(client, db):
    admin = create_user(db, "admin", is_admin=True)
    _drop_unique_index(db)
    older = Playlist(name="Понравившиеся", is_liked=True, owner_id=admin.id)
    newer = Playlist(name="Понравившиеся", is_liked=True, owner_id=admin.id)
    db.add_all([older, newer])
    db.commit()
    track = Track(title="Night Drive Phonk", artist="MADK1D", duration=100, source="local")
    db.add(track)
    db.commit()
    db.execute(playlist_tracks.insert().values(
        playlist_id=older.id, track_id=track.id, position=0,
    ))
    db.commit()

    resp = client.get("/api/users/admin/dashboard", headers=auth_headers(client, "admin"))
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["users_count"] == 1
    assert "MADK1D" in data["users"][0]["detected_artists"]


def test_admin_dashboard_survives_broken_taste_profile(client, db, monkeypatch):
    """Любая ошибка профиля вкуса не должна ронять всю панель."""
    create_user(db, "admin", is_admin=True)

    def boom(*args, **kwargs):
        raise RuntimeError("taste profile exploded")

    monkeypatch.setattr("app.routers.users._taste_profile", boom)

    resp = client.get("/api/users/admin/dashboard", headers=auth_headers(client, "admin"))
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["users"][0]["detected_artists"] == []
    assert data["users"][0]["detected_genres"] == []
