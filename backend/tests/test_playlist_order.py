"""Порядок треков на странице плейлиста: по play_count, самое заигранное сверху.

Исключение — «Понравившиеся»: там порядок добавления пользователя, свежий
лайк сверху (см. _paginated_playlist_response).

Порядок должен быть детерминированным и на границе страниц — страница
подгружается тем же запросом со skip/limit (пейджер фронта и очередь плеера),
и «плавающий» ORDER BY отдал бы один трек дважды, а другой пропустил.
"""

from app.models import Playlist, Track, playlist_tracks
from tests.conftest import create_user, auth_headers


def make_playlist(db, owner, plays, origin="manual"):
    """Плейлист с треками, добавленными в порядке, ОБРАТНОМ популярности.

    position растёт вместе с индексом, play_count — убывает, поэтому
    сортировка по position дала бы ровно перевёрнутый ожидаемый порядок:
    тест отличает новый ORDER BY от старого.
    """
    playlist = Playlist(name="pl", owner_id=owner.id, is_public=False, origin=origin)
    db.add(playlist)
    db.commit()
    db.refresh(playlist)

    for position, play_count in enumerate(plays):
        track = Track(
            title=f"t{position}",
            artist="Artist",
            duration=120,
            file_path=f"/music_files/{position}.mp3",
            play_count=play_count,
        )
        db.add(track)
        db.commit()
        db.refresh(track)
        db.execute(playlist_tracks.insert().values(
            playlist_id=playlist.id, track_id=track.id, position=position))
    db.commit()
    return playlist


def test_playlist_tracks_sorted_by_play_count(client, db):
    user = create_user(db, "sorter")
    playlist = make_playlist(db, user, plays=[1, 50, 7, 300])
    headers = auth_headers(client, "sorter")

    resp = client.get(f"/api/playlists/{playlist.id}", headers=headers)
    assert resp.status_code == 200, resp.text
    counts = [t["play_count"] for t in resp.json()["tracks"]]
    assert counts == [300, 50, 7, 1]


def test_playlist_pagination_stable_with_equal_play_counts(client, db):
    user = create_user(db, "pager")
    # Одинаковый play_count у всех: порядок целиком держится на тай-брейкерах.
    playlist = make_playlist(db, user, plays=[5, 5, 5, 5, 5, 5])
    headers = auth_headers(client, "pager")

    ids = []
    for skip in (0, 2, 4):
        resp = client.get(
            f"/api/playlists/{playlist.id}",
            headers=headers,
            params={"skip": skip, "limit": 2},
        )
        assert resp.status_code == 200, resp.text
        ids.extend(t["id"] for t in resp.json()["tracks"])

    assert len(ids) == 6
    assert len(set(ids)) == 6


def test_liked_playlist_sorted_by_add_order(client, db):
    """«Понравившиеся» — по добавлению, а не по заигранности.

    Лайки ставятся в порядке 2 → 90 → 40: порядок добавления отличим от
    сортировки по play_count ([90, 40, 2]) — тест ловит возврат к старому
    ORDER BY. Свежий лайк сверху, как и в /tracks/me/liked.
    """
    create_user(db, "liker")
    headers = auth_headers(client, "liker")

    for play_count in (2, 90, 40):
        track = Track(
            title=f"t{play_count}",
            artist="Artist",
            duration=120,
            file_path=f"/music_files/{play_count}.mp3",
            play_count=play_count,
        )
        db.add(track)
        db.commit()
        db.refresh(track)
        assert client.post(f"/api/tracks/{track.id}/like", headers=headers).status_code == 200

    resp = client.get("/api/playlists/me/liked", headers=headers)
    assert resp.status_code == 200, resp.text
    assert [t["play_count"] for t in resp.json()["tracks"]] == [40, 90, 2]


def test_adding_track_bumps_playlist_updated_at(client, db):
    """Окно «Добавить в плейлист» сортирует плейлисты по updated_at. Трек
    вставляется в таблицу связей напрямую, мимо ORM-объекта, и onupdate сам не
    срабатывает — эндпоинт обязан обновить отметку явно."""
    user = create_user(db, "adder")
    playlist = make_playlist(db, user, plays=[])
    assert playlist.updated_at is None
    track = Track(title="new", artist="Artist", duration=120, file_path="/music_files/new.mp3")
    db.add(track)
    db.commit()
    db.refresh(track)

    resp = client.post(
        f"/api/playlists/{playlist.id}/tracks/{track.id}",
        headers=auth_headers(client, "adder"),
    )
    assert resp.status_code == 200, resp.text

    db.refresh(playlist)
    assert playlist.updated_at is not None

    summary = client.get("/api/playlists/me", headers=auth_headers(client, "adder")).json()
    assert summary[0]["updated_at"] is not None


def test_add_and_remove_track_check_membership(client, db):
    """Повторное добавление и удаление отсутствующего трека — 400, удаление
    убирает ровно одну связь и не трогает остальные треки плейлиста."""
    user = create_user(db, "remover")
    playlist = make_playlist(db, user, plays=[5, 3])
    headers = auth_headers(client, "remover")
    url = f"/api/playlists/{playlist.id}/tracks"
    track_ids = [
        track_id
        for (track_id,) in db.query(playlist_tracks.c.track_id).filter(
            playlist_tracks.c.playlist_id == playlist.id
        )
    ]

    assert client.post(f"{url}/{track_ids[0]}", headers=headers).status_code == 400

    resp = client.delete(f"{url}/{track_ids[0]}", headers=headers)
    assert resp.status_code == 200, resp.text
    assert client.delete(f"{url}/{track_ids[0]}", headers=headers).status_code == 400

    remaining = [
        track_id
        for (track_id,) in db.query(playlist_tracks.c.track_id).filter(
            playlist_tracks.c.playlist_id == playlist.id
        )
    ]
    assert remaining == track_ids[1:]

    assert client.post(f"{url}/{track_ids[0]}", headers=headers).status_code == 200


def test_imported_playlist_keeps_source_order(client, db):
    """Импорт пишет position в порядке источника — его и отдаём, а не
    заигранность: иначе импортированный плейлист перемешивается."""
    user = create_user(db, "importer")
    playlist = make_playlist(db, user, plays=[1, 50, 7, 300], origin="imported")
    headers = auth_headers(client, "importer")

    resp = client.get(f"/api/playlists/{playlist.id}", headers=headers)
    assert resp.status_code == 200, resp.text
    titles = [t["title"] for t in resp.json()["tracks"]]
    assert titles == ["t0", "t1", "t2", "t3"]
