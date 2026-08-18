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
    monkeypatch.setattr("app.routers.flow._lastfm_pool", _empty)


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


def test_flow_includes_lastfm_similar_tracks(client, db, monkeypatch):
    """Похожие треки Last.fm доезжают до выдачи, когда YT-разведка молчит.

    Тот самый случай, ради которого источник и добавлен: у юзера нет ни одного
    ytmusic-трека, поэтому радио сеять нечем, а граф артистов (тоже YT) пуст.
    Похожесть по паре артист+название от videoId не зависит и работает —
    см. app/beets_similar.py и модульный docstring flow.py.
    """
    user = create_user(db)
    _liked(db, user)

    async def _lastfm(request, artist, title):
        # Курированный трек — "GoodArtist - liked-song" (см. _liked).
        assert (artist, title) == ("GoodArtist", "liked-song")
        return [_external("SimilarByName", "похожий трек", "lfm1")]

    monkeypatch.setattr("app.routers.flow._lastfm_pool", _lastfm)

    resp = client.get("/api/recommendations/flow?limit=5", headers=auth_headers(client))
    assert resp.status_code == 200, resp.text

    artists = {t["artist"] for t in resp.json()}
    assert "SimilarByName" in artists, (
        f"похожие по названию треки не дошли до выдачи: {artists}"
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


def test_flow_prioritizes_loved_artist_over_merely_played(client, db, monkeypatch):
    """Явный любимый артист идёт раньше сигнала от одного прослушивания."""
    user = create_user(db)
    _liked(db, user, artist="LovedArtist")
    played = Track(
        title="один раз прослушан",
        artist="MerelyPlayed",
        duration=100,
        source="local",
        file_path="minio://music/merely-played.mp3",
    )
    db.add(played)
    db.commit()
    db.execute(
        user_track_plays.insert().values(
            user_id=user.id,
            track_id=played.id,
            play_count=1,
            last_played=datetime.now(timezone.utc),
        )
    )
    db.commit()

    async def _favorite(request, artist):
        prefix = "loved" if artist == "LovedArtist" else "played"
        return [
            _external(artist, f"новый {artist} {i}", f"{prefix}{i}")
            for i in range(5)
        ]

    monkeypatch.setattr("app.routers.flow._favorite_artist_pool", _favorite)
    monkeypatch.setattr(
        "app.routers.flow.weighted_order", lambda keys, weights: list(keys)
    )

    resp = client.get("/api/recommendations/flow?limit=5", headers=auth_headers(client))
    assert resp.status_code == 200, resp.text
    artists = [track["artist"] for track in resp.json()]
    assert artists.count("LovedArtist") >= 4, artists


def test_flow_rotates_loved_artists_between_batches(client, db, monkeypatch):
    """Следующая порция не повторяет треки и ротирует любимых артистов."""
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
    first_ids = {track["external_id"] for track in first.json()}
    second_ids = {track["external_id"] for track in second.json()}
    assert first_ids.isdisjoint(second_ids), (first_ids, second_ids)
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


def test_flow_does_not_force_exploration_when_trusted_pool_is_rich(
    client, db, monkeypatch
):
    """Новые артисты не вытесняют точные рекомендации при богатом пуле.

    Повторы теперь исключаются историей прослушиваний и выданных порций, поэтому
    для их устранения не нужна обязательная доля разведки. У каждого из десяти
    курированных артистов есть непрослушанные треки, которых достаточно на всю
    порцию.
    """
    user = create_user(db)
    _liked(db, user)
    liked_pl = db.query(Playlist).filter_by(owner_id=user.id, is_liked=True).first()

    pos = 10
    for a in range(10):
        seed = Track(
            title=f"свой сид {a}",
            artist=f"OwnArtist{a}",
            duration=100,
            source="local",
            file_path=f"minio://music/seed{a}.mp3",
        )
        db.add(seed)
        db.commit()
        db.execute(playlist_tracks.insert().values(
            playlist_id=liked_pl.id, track_id=seed.id, position=pos))
        pos += 1
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
    assert len(artists) == 15, artists
    assert all(a.startswith("OwnArtist") for a in artists), (
        f"разведка вытеснила точные рекомендации знакомых артистов: {artists}"
    )


def test_flow_does_not_open_artist_catalog_after_one_play(client, db, monkeypatch):
    """Одно случайное прослушивание не превращает артиста в любимого."""
    user = create_user(db, username="single-play-user")
    played = Track(
        title="случайный трек",
        artist="AccidentalArtist",
        duration=100,
        source="local",
        file_path="minio://music/accidental.mp3",
    )
    db.add(played)
    db.commit()
    db.execute(
        user_track_plays.insert().values(
            user_id=user.id,
            track_id=played.id,
            play_count=1,
            last_played=datetime.now(timezone.utc),
        )
    )
    db.commit()

    requested_artists = []

    async def _favorite(request, artist):
        requested_artists.append(artist)
        return [_external(artist, "ещё один трек", "accidental-new")]

    monkeypatch.setattr("app.routers.flow._favorite_artist_pool", _favorite)

    resp = client.get(
        "/api/recommendations/flow?limit=5",
        headers=auth_headers(client, username="single-play-user"),
    )
    assert resp.status_code == 200, resp.text
    assert requested_artists == [], requested_artists


def test_flow_does_not_treat_imported_playlist_as_favorite_artists(
    client, db, monkeypatch
):
    """Импорт каталога не открывает внешний каталог каждого импортированного имени."""
    user = create_user(db, username="imported-playlist-user")
    playlist = Playlist(
        name="Imported",
        description="Импортировано из SoundCloud",
        is_public=False,
        owner_id=user.id,
    )
    track = Track(
        title="imported song",
        artist="ImportedArtist",
        duration=100,
        source="local",
        file_path="minio://music/imported.mp3",
    )
    db.add_all([playlist, track])
    db.commit()
    db.execute(
        playlist_tracks.insert().values(
            playlist_id=playlist.id,
            track_id=track.id,
            position=0,
        )
    )
    db.commit()

    requested_artists = []

    async def _favorite(request, artist):
        requested_artists.append(artist)
        return []

    monkeypatch.setattr("app.routers.flow._favorite_artist_pool", _favorite)

    resp = client.get(
        "/api/recommendations/flow?limit=5",
        headers=auth_headers(client, username="imported-playlist-user"),
    )
    assert resp.status_code == 200, resp.text
    assert requested_artists == [], requested_artists


def _imported_playlist(db, user, tracks, name="Imported"):
    """Импортированный плейлист: (артист, название) → треки в коллекции юзера."""
    playlist = Playlist(
        name=name,
        description="Импортировано из SoundCloud",
        is_public=False,
        owner_id=user.id,
    )
    db.add(playlist)
    db.commit()
    db.refresh(playlist)
    for position, (artist, title) in enumerate(tracks):
        track = Track(
            title=title,
            artist=artist,
            duration=100,
            source="local",
            file_path=f"minio://music/{artist}-{position}.mp3",
        )
        db.add(track)
        db.commit()
        db.execute(
            playlist_tracks.insert().values(
                playlist_id=playlist.id, track_id=track.id, position=position
            )
        )
    db.commit()
    return playlist


def test_flow_needs_three_playlist_tracks_to_call_an_artist_favorite(db):
    """Один трек из импорта любимым артиста не делает, три — делают.

    Импорт приводит сотни имён одним движением, и каждое становилось любимым с
    первого же трека: любимый проходит вкусовой фильтр в обход всех проверок и
    забирает гарантированную квоту разведки. Порог — по числу треков артиста в
    собственных плейлистах (_PLAYLIST_ARTIST_MIN_TRACKS).
    """
    from app.routers.flow import _taste_profile

    user = create_user(db, username="import-threshold-user")
    _imported_playlist(
        db,
        user,
        [("RealFavorite", f"песня {i}") for i in range(3)]
        + [("PassingBy", "единственная песня"), ("AlsoPassing", "тоже одна")],
    )

    profile = _taste_profile(db, user.id)
    curated = set(profile["curated_artist_keys"])
    assert "realfavorite" in curated
    assert curated.isdisjoint({"passingby", "alsopassing"}), curated
    # Гарантированная квота SC-разведки — тоже только любимым.
    assert [a.lower() for a in profile["playlist_artists"]] == ["realfavorite"]
    # Но их треки остаются СВОЕЙ библиотекой: артист не выпадает из скоупа,
    # иначе локальный пул перестал бы видеть остальной каталог этих имён.
    assert {"passingby", "alsopassing"} <= set(profile["artist_weight"])


def test_flow_keeps_import_only_library_out_of_global_top(client, db):
    """Библиотека из одиночных импортов не включает холодный старт.

    Ни один артист порога любимого не набирает, но вкус у юзера есть — чужой
    глобальный топ по play_count ему тем более противопоказан (см. регрессию в
    test_flow_ignores_other_users_library).
    """
    user = create_user(db, username="import-only-user")
    _imported_playlist(db, user, [("MineArtist", "своя песня")])
    # Второй трек того же артиста НЕ в плейлисте — иначе выдача пуста по
    # постороннему поводу (плейлистные треки исключаются как «уже в коллекции»)
    # и тест прошёл бы, ничего не проверив.
    mine_fresh = Track(
        title="ещё своя песня",
        artist="MineArtist",
        duration=100,
        source="local",
        file_path="minio://music/mine-fresh.mp3",
    )
    db.add(mine_fresh)
    db.commit()

    stranger = create_user(db, username="stranger")
    stranger_pl = Playlist(name="Импорт", is_public=False, owner_id=stranger.id)
    db.add(stranger_pl)
    db.commit()
    db.refresh(stranger_pl)
    loud = [
        Track(
            title=f"Чужой хит {i}",
            artist=f"StrangerArtist{i}",
            duration=100,
            source="local",
            file_path=f"minio://music/stranger{i}.mp3",
            play_count=900 + i,
        )
        for i in range(10)
    ]
    db.add_all(loud)
    db.commit()
    for position, track in enumerate(loud):
        db.execute(
            playlist_tracks.insert().values(
                playlist_id=stranger_pl.id, track_id=track.id, position=position
            )
        )
    db.commit()

    resp = client.get(
        "/api/recommendations/flow?limit=10",
        headers=auth_headers(client, username="import-only-user"),
    )
    assert resp.status_code == 200, resp.text
    artists = {t["artist"] for t in resp.json()}
    leaked = {a for a in artists if a.startswith("Stranger")}
    assert not leaked, f"в волну протекла чужая библиотека: {leaked}"
    assert "MineArtist" in artists, f"своя библиотека тоже пропала: {artists}"


def test_flow_searches_explicit_genres(client, db, monkeypatch):
    """Выбранный жанр создаёт внешний пул, а не остаётся слабым фильтром."""
    user = create_user(db, username="genre-user")
    user.preferred_genres = ["phonk"]
    db.commit()

    queries = []

    async def _genre_search(request, query):
        queries.append(query)
        return [
            _external(f"PhonkArtist{i}", f"phonk track {i}", f"phonk{i}")
            for i in range(6)
        ]

    monkeypatch.setattr("app.routers.flow._tag_pool", _genre_search)

    resp = client.get(
        "/api/recommendations/flow?limit=5",
        headers=auth_headers(client, username="genre-user"),
    )
    assert resp.status_code == 200, resp.text
    assert any("phonk" in query for query in queries), queries
    mix = resp.json()
    assert len(mix) == 5, mix
    assert all("phonk" in track["title"].lower() for track in mix), mix


def test_flow_discovery_never_overflows_artist_cap(client, db, monkeypatch):
    """Бедный discovery-пул не заполняет порцию одним незнакомым артистом."""
    user = create_user(db, username="discovery-cap-user")
    _liked(db, user)

    async def _similar(artist):
        return [_external("Solo", f"track {i}", f"solo-cap-{i}") for i in range(10)]

    monkeypatch.setattr("app.routers.flow._similar_pool", _similar)

    resp = client.get(
        "/api/recommendations/flow?limit=8",
        headers=auth_headers(client, username="discovery-cap-user"),
    )
    assert resp.status_code == 200, resp.text
    artists = [track["artist"] for track in resp.json()]
    assert artists.count("Solo") <= 4, artists


def test_excluded_detected_artist_stays_out_of_taste_profile(client, db):
    """Артист, убранный из автоопределения, не возвращается из истории."""
    user = create_user(db, username="excluded-detected-user")
    user.excluded_artists = ["DetectedArtist"]
    track = Track(
        title="detected track",
        artist="DetectedArtist",
        duration=100,
        source="local",
        file_path="minio://music/detected.mp3",
    )
    db.add(track)
    db.commit()
    db.execute(
        user_track_plays.insert().values(
            user_id=user.id,
            track_id=track.id,
            play_count=3,
            last_played=datetime.now(timezone.utc),
        )
    )
    db.commit()

    response = client.get(
        "/api/users/me/taste",
        headers=auth_headers(client, username="excluded-detected-user"),
    )
    assert response.status_code == 200, response.text
    assert "DetectedArtist" not in response.json()["artists"]


def test_preferences_persist_detected_artist_exclusion_and_explicit_override(client, db):
    user = create_user(db, username="excluded-preferences-user")
    headers = auth_headers(client, username="excluded-preferences-user")

    saved = client.put(
        "/api/users/me/preferences",
        headers=headers,
        json={
            "preferred_genres": [],
            "preferred_artists": [],
            "excluded_artists": ["AutoArtist", "AutoArtist"],
        },
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["excluded_artists"] == ["AutoArtist"]

    explicit = client.put(
        "/api/users/me/preferences",
        headers=headers,
        json={
            "preferred_genres": [],
            "preferred_artists": ["AutoArtist"],
            "excluded_artists": ["AutoArtist"],
        },
    )
    assert explicit.status_code == 200, explicit.text
    assert explicit.json()["preferred_artists"] == ["AutoArtist"]
    assert explicit.json()["excluded_artists"] == []
