"""/api/recommendations/flow: выдача продолжает работать после того, как
эндпоинт отдаёт соединение БД обратно в пул перед сетевой разведкой.

Регрессия, которую ловим: flow закрывает сессию сразу после _taste_profile
(иначе соединение висит в `idle in transaction` все секунды ожидания YT
Music/SoundCloud). После этого он всё ещё обращается к БД в
_local_candidates и к current_user.id — если закрытие что-то ломает, тест
падает на пустой выдаче или на DetachedInstanceError.
"""

import pytest

from app.cache import clear_pattern, get_cache
from app.models import Track, Playlist, playlist_tracks, user_track_skips

from tests.conftest import auth_headers, create_user


@pytest.fixture(autouse=True)
def _clear_flow_cache():
    # Redis общий между тестами, а id юзеров переиспользуются — история потока
    # от прошлого прогона иначе исключает всю выдачу.
    clear_pattern("flow:*")
    yield
    clear_pattern("flow:*")


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    # Разведка flow ходит в YT Music и SoundCloud. Тест про работу с БД —
    # сеть отключаем, остаётся локальный путь (тот самый, что идёт ПОСЛЕ
    # db.close()).
    async def _empty(*args, **kwargs):
        return []

    monkeypatch.setattr("app.routers.flow._radio_pool", _empty)
    monkeypatch.setattr("app.routers.flow._soundcloud_pool", _empty)
    monkeypatch.setattr("app.routers.flow._tag_pool", _empty)


def test_flow_returns_local_tracks_after_session_close(client, db):
    user = create_user(db)

    liked_pl = Playlist(name="Понравившиеся", is_public=False, is_liked=True, owner_id=user.id)
    db.add(liked_pl)
    db.commit()
    db.refresh(liked_pl)

    liked = Track(title="liked-song", artist="GoodArtist", duration=100, source="local")
    same_artist = Track(title="another-song", artist="GoodArtist", duration=100, source="local")
    db.add_all([liked, same_artist])
    db.commit()
    db.execute(
        playlist_tracks.insert().values(playlist_id=liked_pl.id, track_id=liked.id, position=0)
    )
    db.commit()

    resp = client.get("/api/recommendations/flow?limit=5", headers=auth_headers(client))
    assert resp.status_code == 200, resp.text

    mix = resp.json()
    # Локальные кандидаты читаются из БД уже ПОСЛЕ db.close() — пустая выдача
    # означала бы, что переоткрытие сессии не сработало.
    assert mix, "flow вернул пустую выдачу — локальные кандидаты не прочитались"
    assert any(t["artist"] == "GoodArtist" for t in mix)


def test_flow_response_is_not_cacheable(client, db):
    """Ответ потока обязан быть некэшируемым.

    Регрессия: nginx-блок /api/recommendations ставил на выдачу
    Cache-Control: private, max-age=60. Браузер отдавал поток из disk cache,
    запрос не доходил до бэкенда, и каждый запуск играл одну и ту же цепочку —
    вся серверная рандомизация и история потока не участвовали.
    """
    create_user(db)
    resp = client.get("/api/recommendations/flow?limit=5", headers=auth_headers(client))
    assert resp.status_code == 200, resp.text
    assert resp.headers.get("cache-control") == "no-store"


def test_flow_history_tags_catalog_rows_as_local(client, db):
    """Треки каталога попадают в историю как local:<id>, а не <source>:<external_id>.

    Регрессия: у большей части каталога source == "ytmusic", и история писала
    их как "ytmusic:<videoId>". Carve-out «локальный каталог не блокируем на
    TTL истории» проверял префикс "local:" и до них не доходил — каталог
    исключался целиком на 6 часов, выдача схлопывалась в [] и поток переставал
    стартовать («поток временно недоступен»).
    """
    user = create_user(db)

    liked_pl = Playlist(name="Понравившиеся", is_public=False, is_liked=True, owner_id=user.id)
    db.add(liked_pl)
    db.commit()
    db.refresh(liked_pl)

    liked = Track(title="liked-song", artist="GoodArtist", duration=100, source="local")
    # Ровно тот случай: строка КАТАЛОГА с source="ytmusic" и external_id.
    catalog_yt = Track(
        title="catalog-song",
        artist="GoodArtist",
        duration=100,
        source="ytmusic",
        external_id="VIDEOID123",
    )
    db.add_all([liked, catalog_yt])
    db.commit()
    db.execute(
        playlist_tracks.insert().values(playlist_id=liked_pl.id, track_id=liked.id, position=0)
    )
    db.commit()
    catalog_id = catalog_yt.id

    headers = auth_headers(client)
    resp = client.get("/api/recommendations/flow?limit=5", headers=headers)
    assert resp.status_code == 200, resp.text
    assert any(t["id"] == catalog_id for t in resp.json()), "трек каталога не попал в выдачу"

    history = get_cache(f"flow:history:v3:{user.id}") or {}
    ids = history.get("ids") or []
    assert f"local:{catalog_id}" in ids, f"каталожный трек записан не как local: {ids}"
    assert "ytmusic:VIDEOID123" not in ids, (
        "строка каталога записана как внешний трек — она будет заблокирована на TTL истории"
    )


def test_flow_does_not_return_empty_when_catalog_exhausted(client, db):
    """Исчерпанный каталог не должен давать пустую выдачу.

    Свежесть (недавно играло / уже в истории потока) — мягкое ограничение.
    Когда из-за него не остаётся ни одного кандидата, поток обязан ослабить
    свежесть и повторить уже слышанное: неработающая кнопка хуже повтора.
    """
    user = create_user(db)

    liked_pl = Playlist(name="Понравившиеся", is_public=False, is_liked=True, owner_id=user.id)
    db.add(liked_pl)
    db.commit()
    db.refresh(liked_pl)

    liked = Track(title="liked-song", artist="GoodArtist", duration=100, source="local")
    db.add(liked)
    db.commit()
    db.execute(
        playlist_tracks.insert().values(playlist_id=liked_pl.id, track_id=liked.id, position=0)
    )
    db.commit()

    # Крошечный каталог: пары запусков хватает, чтобы исчерпать свежее.
    for i in range(4):
        db.add(Track(title=f"song-{i}", artist="GoodArtist", duration=100, source="local"))
    db.commit()

    headers = auth_headers(client)
    for attempt in range(6):
        resp = client.get("/api/recommendations/flow?limit=5", headers=headers)
        assert resp.status_code == 200, resp.text
        assert resp.json(), f"поток отдал пустую выдачу на запуске {attempt} — кнопка не сработает"


def test_flow_never_returns_skipped_or_disliked(client, db):
    """Ослабление свежести не должно возвращать осознанно отвергнутое.

    Скип/дизлайк — жёсткое ограничение: оно не снимается ни на какой ступени,
    даже когда иначе выдача пуста.
    """
    user = create_user(db)

    liked_pl = Playlist(name="Понравившиеся", is_public=False, is_liked=True, owner_id=user.id)
    db.add(liked_pl)
    db.commit()
    db.refresh(liked_pl)

    liked = Track(title="liked-song", artist="GoodArtist", duration=100, source="local")
    hated = Track(title="hated-song", artist="GoodArtist", duration=100, source="local")
    db.add_all([liked, hated])
    db.commit()
    db.execute(
        playlist_tracks.insert().values(playlist_id=liked_pl.id, track_id=liked.id, position=0)
    )
    db.execute(
        user_track_skips.insert().values(
            user_id=user.id, track_id=hated.id, skip_count=3, disliked=True
        )
    )
    db.commit()
    hated_id = hated.id

    headers = auth_headers(client)
    # Гоняем до исчерпания свежего — ступени ослабления обязаны включиться.
    for attempt in range(6):
        resp = client.get("/api/recommendations/flow?limit=5", headers=headers)
        assert resp.status_code == 200, resp.text
        assert all(t["id"] != hated_id for t in resp.json()), (
            f"дизлайкнутый трек вернулся в поток на запуске {attempt}"
        )
