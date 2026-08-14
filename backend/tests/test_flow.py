"""/api/recommendations/flow: выдача продолжает работать после того, как
эндпоинт отдаёт соединение БД обратно в пул перед сетевой разведкой.

Регрессия, которую ловим: flow закрывает сессию сразу после _taste_profile
(иначе соединение висит в `idle in transaction` все секунды ожидания YT
Music/SoundCloud). После этого он всё ещё обращается к БД в
_local_candidates и к current_user.id — если закрытие что-то ломает, тест
падает на пустой выдаче или на DetachedInstanceError.
"""

from datetime import datetime, timedelta, timezone

import pytest

from app.cache import clear_pattern
from app.models import Track, Playlist, playlist_tracks, user_track_plays
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
    monkeypatch.setattr("app.routers.flow._favorite_artist_pool", _empty)
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


def test_flow_excludes_played_tracks_but_keeps_new_tracks_by_same_artist(client, db):
    """Старая история не повторяется, но знакомый артист остаётся источником."""
    user = create_user(db, username="history-user")
    played = [
        Track(
            title=f"played-{i}",
            artist="KnownArtist",
            duration=100,
            source="local",
            file_path=f"minio://music/played-{i}.mp3",
        )
        for i in range(101)
    ]
    fresh = Track(
        title="fresh-from-known-artist",
        artist="KnownArtist",
        duration=100,
        source="local",
        file_path="minio://music/fresh.mp3",
    )
    db.add_all([*played, fresh])
    db.commit()

    now = datetime.now(timezone.utc)
    db.execute(
        user_track_plays.insert(),
        [
            {
                "user_id": user.id,
                "track_id": track.id,
                "play_count": 1,
                "last_played": now - timedelta(minutes=i),
            }
            for i, track in enumerate(played)
        ],
    )
    db.commit()
    fresh_id = fresh.id
    played_ids = {track.id for track in played}

    resp = client.get(
        "/api/recommendations/flow?limit=5",
        headers=auth_headers(client, username="history-user"),
    )
    assert resp.status_code == 200, resp.text

    ids = {t["id"] for t in resp.json() if isinstance(t["id"], int)}
    assert fresh_id in ids, "новый трек знакомого артиста должен попасть в flow"
    assert ids.isdisjoint(played_ids), (
        "flow вернул уже прослушанный трек вместо другой композиции артиста"
    )


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


def test_flow_prefers_new_tracks_from_loved_artists(client, db, monkeypatch):
    """Похожие артисты не вытесняют непрослушанные треки любимого автора."""
    user = create_user(db)
    _liked(db, user, artist="LovedArtist")

    async def _favorite(request, artist):
        return [
            _external("LovedArtist", f"новый любимый {i}", f"loved{i}")
            for i in range(8)
        ]

    async def _similar(artist):
        return [
            _external(f"RandomNeighbour{i}", f"чужой {i}", f"random{i}")
            for i in range(8)
        ]

    monkeypatch.setattr("app.routers.flow._favorite_artist_pool", _favorite)
    monkeypatch.setattr("app.routers.flow._similar_pool", _similar)

    resp = client.get(
        "/api/recommendations/flow?limit=10", headers=auth_headers(client)
    )
    assert resp.status_code == 200, resp.text
    artists = [t["artist"] for t in resp.json()]
    assert artists.count("LovedArtist") >= 5, artists


def test_flow_rotates_loved_artists_between_batches(client, db, monkeypatch):
    """Следующая порция начинает с любимых артистов, недавно не звучавших."""
    user = create_user(db)
    user.preferred_artists = [f"Loved{i}" for i in range(8)]
    db.commit()

    async def _favorite(request, artist):
        suffix = artist.removeprefix("Loved")
        return [
            _external(artist, f"трек {artist}-{i}", f"loved{suffix}_{i}")
            for i in range(3)
        ]

    monkeypatch.setattr("app.routers.flow._favorite_artist_pool", _favorite)
    monkeypatch.setattr(
        "app.routers.flow.weighted_order", lambda keys, weights: list(keys)
    )

    headers = auth_headers(client)
    first = client.get("/api/recommendations/flow?limit=6", headers=headers)
    second = client.get("/api/recommendations/flow?limit=6", headers=headers)
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text

    first_artists = {track["artist"] for track in first.json()}
    second_artists = {track["artist"] for track in second.json()}
    assert {"Loved6", "Loved7"} <= second_artists, (
        first_artists,
        second_artists,
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
    alternating = any(
        order[i] == order[i + 2]
        and order[i + 1] == order[i + 3]
        and order[i] != order[i + 1]
        for i in range(len(order) - 3)
    )
    assert not alternating, f"два артиста чередуются A-B-A-B: {order}"
    # Миноритарные артисты не должны быть вытеснены доминирующим целиком.
    assert len(set(order)) >= 3, f"выдача выродилась в одного-двух артистов: {order}"


def test_flow_ignores_other_users_library(client, db):
    """Треки, приведённые в базу ДРУГИМ юзером, не попадают в чужую волну.

    Боевой симптом: завёлся второй юзер, импортировал плейлист на 185 треков —
    и они поехали в волну первому. Таблица tracks общая, владельца у трека нет,
    а Track.play_count — счётчик на всех юзеров сразу, поэтому страховочный
    добор (`order_by(desc(play_count))` по всей базе) возглавлял тот, кто
    последним много слушал, и его библиотека уезжала остальным.

    Приманка проходит вкусовой фильтр добора (require_signal): жанр по названию
    определяется, а жанров вкуса у Алисы нет, поэтому genre_is_compatible
    пропускает. Единственное, что её теперь останавливает, — скоуп артистов.

    Профиль Алисы намеренно БЕЗ жанрового сигнала: непустой profile["genres"]
    поднимает build_keyword_filters, а он строит Postgres-regex (`~*` с `\\y`),
    который SQLite в тестах не выполняет.
    """
    alice = create_user(db, username="alice")
    bob = create_user(db, username="bob")

    # Профиль Алисы: один курированный артист, названия нейтральные (жанр по
    # ним не угадывается).
    alice_pl = Playlist(name="Понравившиеся", is_public=False, is_liked=True, owner_id=alice.id)
    db.add(alice_pl)
    db.commit()
    db.refresh(alice_pl)
    own = Track(
        title="Мой любимый",
        artist="AliceArtist",
        duration=100,
        source="local",
        file_path="minio://music/own.mp3",
    )
    own_more = Track(
        title="Второй",
        artist="AliceArtist",
        duration=100,
        source="local",
        file_path="minio://music/own2.mp3",
    )
    db.add_all([own, own_more])
    db.commit()
    db.execute(
        playlist_tracks.insert().values(playlist_id=alice_pl.id, track_id=own.id, position=0)
    )
    db.commit()

    # Библиотека Боба: play_count намного выше, чем у Алисы, — именно она и
    # возглавляла глобальный добор.
    bob_pl = Playlist(name="Импорт", is_public=False, is_liked=False, owner_id=bob.id)
    db.add(bob_pl)
    db.commit()
    db.refresh(bob_pl)
    bob_tracks = [
        Track(
            title=f"Bob phonk {i}",
            artist=f"BobArtist{i}",
            duration=100,
            source="local",
            file_path=f"minio://music/bob{i}.mp3",
            play_count=500 + i,
        )
        for i in range(12)
    ]
    db.add_all(bob_tracks)
    db.commit()
    for pos, t in enumerate(bob_tracks):
        db.execute(
            playlist_tracks.insert().values(
                playlist_id=bob_pl.id, track_id=t.id, position=pos
            )
        )
    db.commit()

    resp = client.get("/api/recommendations/flow?limit=10", headers=auth_headers(client))
    assert resp.status_code == 200, resp.text

    mix = resp.json()
    artists = {t["artist"] for t in mix}
    leaked = {a for a in artists if a.startswith("BobArtist")}
    assert not leaked, f"в волну Алисы протекла библиотека Боба: {leaked}"
    # Иначе тест прошёл бы и на пустой выдаче, ничего не проверив.
    assert "AliceArtist" in artists, f"своя библиотека тоже пропала: {artists}"


def test_flow_response_is_not_cacheable(client, db):
    """Ответ волны уникален на каждый запрос — кэшировать его нельзя.

    Браузер, закэшировав выдачу, играл после перезагрузки ту же цепочку: запрос
    не доходил до бэкенда, серверная история flow:history не двигалась и ротация
    артистов не работала. Прокси это запрещает (см. nginx), но dev-путь через
    vite-прокси идёт мимо nginx — заголовок обязан ставить сам эндпоинт.
    """
    user = create_user(db)
    _liked(db, user)

    resp = client.get("/api/recommendations/flow?limit=5", headers=auth_headers(client))
    assert resp.status_code == 200, resp.text
    assert resp.headers.get("cache-control") == "no-store"


def test_flow_keeps_exploration_when_local_pool_is_rich(client, db, monkeypatch):
    """Разведка (новые артисты) обязана попадать в волну, даже когда локальных
    кандидатов вдоволь.

    Боевая регрессия после ограничения локального пула артистами юзера. Раньше
    страховочный добор брал глобальный топ по play_count и почти весь отсеивался
    по require_signal, поэтому локальных кандидатов не хватало и разведка
    занимала оставшиеся места сама. Стоило ограничить добор артистами самого
    юзера — и почти каждый кандидат стал «доверенным» (make_relevance_check
    возвращает True для курированного артиста ДО проверки require_signal),
    локальных кандидатов стало вдоволь, и они забирали все жанровые места.
    Волна вырождалась в каталог тех артистов, которых юзер и так слушает, —
    то есть в список бывшего раздела «Рекомендуем для вас».

    Богатый пул — это МНОГО артистов, а не много треков: _MAX_PER_ARTIST режет
    одного артиста до двух треков. Поэтому здесь 10 курированных артистов, как
    в боевом импортированном плейлисте.
    """
    user = create_user(db)
    _liked(db, user)
    liked_pl = db.query(Playlist).filter_by(owner_id=user.id, is_liked=True).first()

    pos = 10
    for a in range(10):
        for i in range(2):
            t = Track(
                title=f"свой трек {a}-{i}",
                artist=f"OwnArtist{a}",
                duration=100,
                source="local",
                file_path=f"minio://music/own{a}_{i}.mp3",
            )
            db.add(t)
            db.commit()
            db.execute(playlist_tracks.insert().values(
                playlist_id=liked_pl.id, track_id=t.id, position=pos))
            pos += 1
    db.commit()

    # Разведка живая: граф артистов даёт треки НОВЫХ артистов. Берём
    # _similar_pool, а не радио: радио строится от videoId, а ytmusic-треков у
    # юзера нет — сида не будет и радио не вызовется вовсе.
    async def _similar(artist):
        return [
            _external(f"NeighbourArtist{i}", f"новый трек {i}", f"ext{i}")
            for i in range(6)
        ]

    monkeypatch.setattr("app.routers.flow._similar_pool", _similar)

    resp = client.get("/api/recommendations/flow?limit=15", headers=auth_headers(client))
    assert resp.status_code == 200, resp.text

    mix = resp.json()
    artists = [t["artist"] for t in mix]
    external = [a for a in artists if a.startswith("NeighbourArtist")]
    # Проверяем ДОЛЮ, а не факт попадания: одно-единственное разведочное место
    # (15-е) существовало и до фикса, но 14 из 15 своих треков — это и есть
    # «вместо волны играет мой же каталог». Порог заведомо ниже _EXPLORE_SHARE,
    # чтобы тест не ломался от точной настройки доли.
    assert len(external) >= 3, (
        f"разведку вытеснил локальный пул, в волне лишь {len(external)} новых из "
        f"{len(artists)}: {artists}"
    )
    # Локальная часть при этом никуда не делась: доля разведки — это доля,
    # а не подмена волны разведкой целиком.
    assert any(a.startswith("OwnArtist") for a in artists), (
        f"своя библиотека пропала из волны: {artists}"
    )
