"""/api/users/me/taste отдаёт предпочтения, выведенные из прослушиваний.

Смысл ручки — показать в настройках то, что сервис понял сам (по лайкам и
истории), а не только явный выбор юзера. Проверяем, что жанр угадывается по
названию (у внешних треков Track.genre пуст) и что произвольные строки от
провайдеров в выдачу не протекают — в предпочтениях хранятся только ключи
GENRE_KEYWORDS.
"""

from app.models import Playlist, Track, playlist_tracks

from tests.conftest import auth_headers, create_user


def test_detected_taste_from_liked_tracks(client, db):
    user = create_user(db)
    liked_pl = Playlist(name="Понравившиеся", is_liked=True, owner_id=user.id)
    db.add(liked_pl)
    db.commit()

    # genre пуст — жанр должен вывестись из названия ("Phonk").
    phonk = Track(title="Night Drive Phonk", artist="MADK1D", duration=100, source="local")
    # Произвольный жанр от провайдера — не ключ словаря, в выдачу не идёт.
    weird = Track(
        title="Something", artist="Someone", duration=100, source="local",
        genre="Alternative/Indie",
    )
    db.add_all([phonk, weird])
    db.commit()
    db.execute(playlist_tracks.insert().values([
        {"playlist_id": liked_pl.id, "track_id": phonk.id, "position": 0},
        {"playlist_id": liked_pl.id, "track_id": weird.id, "position": 1},
    ]))
    db.commit()

    resp = client.get("/api/users/me/taste", headers=auth_headers(client))
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert "phonk" in data["genres"]
    assert "Alternative/Indie" not in data["genres"]
    assert "MADK1D" in data["artists"]
