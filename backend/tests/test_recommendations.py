"""Рекомендации /api/recommendations: учёт скипов и отказ от слепой добивки.

Сценарий воспроизводит регрессию из-за внешних (безжанровых) треков: сид —
артист из лайков, надоевший артист ушёл в минус по скипам, а несвязанный хит
сервиса не должен занимать место в выдаче.
"""

import pytest

from app.cache import clear_pattern
from app.models import Track, Playlist, playlist_tracks, user_track_plays, user_track_skips

from tests.conftest import auth_headers, create_user


@pytest.fixture(autouse=True)
def _clear_recs_cache():
    # Тесты пересоздают БД, но Redis общий: юзеры получают одинаковые id, и кэш
    # recs:{id} протекает между тестами. Чистим до и после.
    clear_pattern("recs:*")
    yield
    clear_pattern("recs:*")


def _track(db, title, artist, play_count=0, genre=None):
    t = Track(title=title, artist=artist, duration=100, source="ytmusic",
              external_id=title, play_count=play_count, genre=genre)
    db.add(t)
    db.commit()
    db.refresh(t)
    return t


def test_recommendations_respect_taste_and_skips(client, db):
    user = create_user(db)

    liked_pl = Playlist(name="Понравившиеся", is_public=False, is_liked=True, owner_id=user.id)
    db.add(liked_pl)
    db.commit()
    db.refresh(liked_pl)

    liked = _track(db, "liked-good", "GoodArtist", play_count=1)
    more_good = _track(db, "more-good", "GoodArtist", play_count=5)      # ждём в выдаче
    annoying_seed = _track(db, "annoying-seed", "AnnoyingArtist", play_count=2)
    annoying_more = _track(db, "annoying-more", "AnnoyingArtist", play_count=100)  # не ждём
    unrelated_hit = _track(db, "mega-hit", "PopStar", play_count=1000)   # не ждём (без добивки)

    # liked-good лежит в плейлисте лайков
    db.execute(playlist_tracks.insert().values(
        playlist_id=liked_pl.id, track_id=liked.id, position=0))
    # annoying-seed играли дважды (попадает в сид часто-играемых)
    db.execute(user_track_plays.insert().values(
        user_id=user.id, track_id=annoying_seed.id, play_count=2))
    # ...и его же трижды скипнули — артист уходит в минус
    db.execute(user_track_skips.insert().values(
        user_id=user.id, track_id=annoying_seed.id, skip_count=3))
    db.commit()

    resp = client.get("/api/recommendations/", headers=auth_headers(client))
    assert resp.status_code == 200, resp.text
    ids = {t["id"] for t in resp.json()["tracks"]}

    assert more_good.id in ids, "трек любимого артиста должен рекомендоваться"
    assert annoying_seed.id not in ids, "скипнутый трек исключён"
    assert annoying_more.id not in ids, "надоевший (минусовой) артист исключён"
    assert unrelated_hit.id not in ids, "несвязанный хит не добивает выдачу"


def test_recommendations_cold_start_shows_popular(client, db):
    """Без сигналов вкуса — холодный старт: показываем популярное сервиса."""
    create_user(db, username="bob")
    hit = _track(db, "cold-hit", "Whoever", play_count=500)

    resp = client.get("/api/recommendations/", headers=auth_headers(client, username="bob"))
    assert resp.status_code == 200, resp.text
    ids = {t["id"] for t in resp.json()["tracks"]}
    assert hit.id in ids


def test_recommendations_cold_start_respects_preferred_genre(
    client, db, monkeypatch
):
    """Жанр из онбординга сам по себе персонализирует первую выдачу."""
    from app.routers import recommendations as recommendations_router

    # SQLite не поддерживает Postgres-оператор ~*. Здесь проверяем основной
    # контракт через явное поле Track.genre, поэтому текстовые фильтры не нужны.
    monkeypatch.setattr(
        recommendations_router, "build_keyword_filters", lambda *_args, **_kwargs: []
    )

    user = create_user(db, username="genre-user")
    user.preferred_genres = ["rock"]
    db.commit()

    wanted = _track(db, "wanted-rock", "RockArtist", play_count=1, genre="Rock")
    unwanted = _track(db, "unwanted-pop", "PopArtist", play_count=1000, genre="pop")

    resp = client.get(
        "/api/recommendations/",
        headers=auth_headers(client, username="genre-user"),
    )
    assert resp.status_code == 200, resp.text
    ids = {t["id"] for t in resp.json()["tracks"]}

    assert wanted.id in ids
    assert unwanted.id not in ids


def test_updating_preferences_invalidates_cached_recommendations(client, db):
    """После онбординга главная не должна пять минут отдавать старый cold start."""
    create_user(db, username="pref-user")
    wanted = _track(db, "chosen-track", "ChosenArtist", play_count=1)
    unwanted = _track(db, "global-hit", "OtherArtist", play_count=1000)
    headers = auth_headers(client, username="pref-user")

    first = client.get("/api/recommendations/", headers=headers)
    assert first.status_code == 200, first.text
    assert unwanted.id in {t["id"] for t in first.json()["tracks"]}

    saved = client.put(
        "/api/users/me/preferences",
        headers=headers,
        json={"preferred_genres": [], "preferred_artists": ["ChosenArtist"]},
    )
    assert saved.status_code == 200, saved.text

    second = client.get("/api/recommendations/", headers=headers)
    assert second.status_code == 200, second.text
    ids = {t["id"] for t in second.json()["tracks"]}

    assert wanted.id in ids
    assert unwanted.id not in ids


def test_recommendations_ignore_other_users_library(client, db):
    """Библиотека другого юзера не подмешивается в рекомендации.

    Та же боевая регрессия, что и в test_flow: таблица tracks общая, владельца у
    трека нет, а Track.play_count — счётчик на всех юзеров. Юзер, импортировавший
    большой плейлист, возглавлял глобальный топ, и его треки ехали остальным
    через добор популярным (_varied_popular).

    Профиль Алисы намеренно без жанра: непустой genres поднимает
    build_keyword_filters с Postgres-regex (`~*` и `\\y`), который SQLite в
    тестах не выполняет.
    """
    alice = create_user(db, username="alice")
    bob = create_user(db, username="bob")

    liked_pl = Playlist(name="Понравившиеся", is_public=False, is_liked=True, owner_id=alice.id)
    db.add(liked_pl)
    db.commit()
    db.refresh(liked_pl)

    liked = _track(db, "мой любимый", "AliceArtist", play_count=1)
    own_more = _track(db, "второй", "AliceArtist", play_count=3)
    db.execute(playlist_tracks.insert().values(
        playlist_id=liked_pl.id, track_id=liked.id, position=0))
    db.commit()

    bob_pl = Playlist(name="Импорт", is_public=False, is_liked=False, owner_id=bob.id)
    db.add(bob_pl)
    db.commit()
    db.refresh(bob_pl)
    bob_tracks = [
        _track(db, f"bob phonk {i}", f"BobArtist{i}", play_count=500 + i)
        for i in range(12)
    ]
    for pos, t in enumerate(bob_tracks):
        db.execute(playlist_tracks.insert().values(
            playlist_id=bob_pl.id, track_id=t.id, position=pos))
    db.commit()

    resp = client.get("/api/recommendations/", headers=auth_headers(client))
    assert resp.status_code == 200, resp.text

    tracks = resp.json()["tracks"]
    leaked = {t["artist"] for t in tracks if t["artist"].startswith("BobArtist")}
    assert not leaked, f"в рекомендации Алисы протекла библиотека Боба: {leaked}"
    assert own_more.id in {t["id"] for t in tracks}, (
        "свой трек любимого артиста должен остаться в выдаче"
    )
