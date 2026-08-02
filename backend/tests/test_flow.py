"""/api/recommendations/flow: выдача продолжает работать после того, как
эндпоинт отдаёт соединение БД обратно в пул перед сетевой разведкой.

Регрессия, которую ловим: flow закрывает сессию сразу после _taste_profile
(иначе соединение висит в `idle in transaction` все секунды ожидания YT
Music/SoundCloud). После этого он всё ещё обращается к БД в
_local_candidates и к current_user.id — если закрытие что-то ломает, тест
падает на пустой выдаче или на DetachedInstanceError.
"""

import pytest

from app.cache import clear_pattern
from app.models import Track, Playlist, playlist_tracks
from app.schemas import ExternalTrackResponse

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
    monkeypatch.setattr("app.routers.flow._similar_pool", _empty)
    monkeypatch.setattr("app.routers.flow._artist_seed_videos", _empty)
    monkeypatch.setattr("app.routers.flow._soundcloud_pool", _empty)
    monkeypatch.setattr("app.routers.flow._tag_pool", _empty)


def _external(artist, title, external_id):
    return ExternalTrackResponse(
        id=f"ytmusic:{external_id}",
        source="ytmusic",
        external_id=external_id,
        title=title,
        artist=artist,
        duration=180,
        stream_url="",
    )


def _liked(db, user, artist="GoodArtist", title="liked-song"):
    """Курированный трек — минимальный профиль вкуса (артист с весом > 0)."""
    playlist = Playlist(name="Понравившиеся", is_public=False, is_liked=True, owner_id=user.id)
    db.add(playlist)
    db.commit()
    db.refresh(playlist)
    track = Track(title=title, artist=artist, duration=100, source="local")
    db.add(track)
    db.commit()
    db.execute(
        playlist_tracks.insert().values(
            playlist_id=playlist.id, track_id=track.id, position=0
        )
    )
    db.commit()
    return playlist, track


def test_flow_returns_local_tracks_after_session_close(client, db):
    user = create_user(db)

    liked_pl = Playlist(name="Понравившиеся", is_public=False, is_liked=True, owner_id=user.id)
    db.add(liked_pl)
    db.commit()
    db.refresh(liked_pl)

    # file_path обязателен: без него _media_available отбрасывает локальный трек
    # как «нечего играть», и тест про сессию БД падал бы на пустой выдаче по
    # совершенно посторонней причине. minio-путь не требует файла на диске.
    liked = Track(
        title="liked-song",
        artist="GoodArtist",
        duration=100,
        source="local",
        file_path="minio://music/liked-song.mp3",
    )
    same_artist = Track(
        title="another-song",
        artist="GoodArtist",
        duration=100,
        source="local",
        file_path="minio://music/another-song.mp3",
    )
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


def test_flow_includes_similar_artists(client, db, monkeypatch):
    """В волне должны появляться НОВЫЕ артисты, а не только выбранные юзером.

    Боевая регрессия: единственный источник похожести (радио YT Music) молчал,
    а вкусовой фильтр отбраковывал всё, что не курировано, — поэтому поток
    состоял ровно из тех 4 артистов, которых юзер выбрал при регистрации.
    Здесь радио пусто (как на проде), похожесть даёт граф артистов.
    """
    user = create_user(db)
    _liked(db, user)

    neighbours = [
        _external("UnknownNeighbour", "Ночная смена", "vid1"),
        _external("AnotherNeighbour", "Второй трек", "vid2"),
    ]

    async def _similar(artist):
        return neighbours

    monkeypatch.setattr("app.routers.flow._similar_pool", _similar)

    resp = client.get("/api/recommendations/flow?limit=5", headers=auth_headers(client))
    assert resp.status_code == 200, resp.text

    artists = {t["artist"] for t in resp.json()}
    assert artists & {"UnknownNeighbour", "AnotherNeighbour"}, (
        f"похожие артисты не дошли до выдачи: {artists}"
    )


def test_flow_spreads_dominant_artist(client, db, monkeypatch):
    """Артист, у которого треков больше всех, не идёт в выдаче блоком.

    Боевой симптом: `kizaru, kizaru, kizaru` в конце порции и 8 треков Trapt из
    15. Причина — последний резерв (take_overflow) сортировал по занятости один
    раз и резал срезом, отдавая весь остаток одного артиста подряд.
    Пул специально беднее выдачи по числу артистов: полностью избежать повторов
    тут невозможно, но три подряд — уже дефект.
    """
    user = create_user(db)
    _liked(db, user)

    pool = [_external("Solo", f"track {i}", f"solo{i}") for i in range(10)]
    pool += [_external("Other", f"other {i}", f"other{i}") for i in range(3)]
    pool += [_external("Third", f"third {i}", f"third{i}") for i in range(3)]

    async def _similar(artist):
        return pool

    monkeypatch.setattr("app.routers.flow._similar_pool", _similar)

    resp = client.get("/api/recommendations/flow?limit=8", headers=auth_headers(client))
    assert resp.status_code == 200, resp.text

    order = [t["artist"] for t in resp.json()]
    assert order, "flow вернул пустую выдачу"
    longest = best = 1
    for i in range(1, len(order)):
        longest = longest + 1 if order[i] == order[i - 1] else 1
        best = max(best, longest)
    assert best < 3, f"артист идёт блоком: {order}"
    # Миноритарные артисты не должны быть вытеснены доминирующим целиком.
    assert len(set(order)) >= 3, f"выдача выродилась в одного-двух артистов: {order}"
