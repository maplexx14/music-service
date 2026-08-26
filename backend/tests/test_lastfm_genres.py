"""Каталог жанров из Last.fm: фильтр мета-тегов, группы, фолбэк, артисты.

Сеть в тестах не трогаем: подменяем `_top_tags` / `tag_artists` — они и есть
единственные точки выхода модуля в Last.fm. Проверяем именно то, из-за чего
каталог нельзя было брать «как есть»: половина топа Last.fm — это «seen live»
и «female vocalists», а без наших ключей в списке нет ни фонка, ни трэпа.
"""

import pytest

from app import beets_similar, lastfm_genres
from app.genre_keywords import GENRE_KEYWORDS
from app.models import Track

from tests.conftest import auth_headers, create_user


# Настоящий топ-50 Last.fm вперемешку с мета-метками, которые в него входят.
FAKE_TOP_TAGS = [
    ("rock", 4000),
    ("seen live", 3900),
    ("electronic", 3500),
    ("female vocalists", 3400),
    ("black metal", 3000),
    ("80s", 2900),
    ("british", 2800),
    ("soul", 2700),
    ("techno", 2600),
    ("Awesome", 2500),
    ("under 2000 listeners", 2400),
    ("bookmark", 2300),
]


@pytest.fixture(autouse=True)
def _clear_genre_cache():
    """Каталог живёт в Redis сутки и переживает конец теста.

    Без очистки тест с подменённым топом получает каталог, собранный настоящим
    Last.fm в предыдущем прогоне (или в работающем приложении).
    """
    from app.cache import clear_pattern

    clear_pattern("prefs:genre_catalog:*")
    clear_pattern("prefs:tag_artists:*")
    clear_pattern("prefs:artist_tags:*")
    yield
    clear_pattern("prefs:genre_catalog:*")
    clear_pattern("prefs:tag_artists:*")
    clear_pattern("prefs:artist_tags:*")


@pytest.fixture()
def top_tags(monkeypatch):
    """Каталог собирается из подменённого топа, а не из сети."""
    monkeypatch.setattr(lastfm_genres, "_top_tags", lambda: list(FAKE_TOP_TAGS))
    return FAKE_TOP_TAGS


def test_catalog_drops_meta_tags(top_tags):
    keys = [option["key"] for option in lastfm_genres.build_catalog()]
    assert "rock" in keys
    assert "black metal" in keys
    assert "techno" in keys
    for junk in ("seen live", "female vocalists", "80s", "british", "awesome",
                 "under 2000 listeners", "bookmark"):
        assert junk not in keys


def test_catalog_keeps_our_keys(top_tags):
    """Вкус сервиса стоит на фонке/трэпе/lo-fi, а в топе Last.fm их нет."""
    keys = {option["key"] for option in lastfm_genres.build_catalog()}
    assert set(GENRE_KEYWORDS) <= keys


def test_catalog_order_is_lastfm_popularity(top_tags):
    catalog = lastfm_genres.build_catalog()
    populars = [o["popularity"] for o in catalog if o["popularity"]]
    assert populars == sorted(populars, reverse=True)
    assert catalog[0]["key"] == "rock"


def test_catalog_groups_by_genre_family(top_tags):
    groups = {o["key"]: o["group"] for o in lastfm_genres.build_catalog()}
    # Наш словарь узнаёт поджанр — группа его внутренний ключ.
    assert groups["black metal"] == "rock"
    assert groups["techno"] == "electronic"
    # Словарь не узнаёт — берём корень ветки beets, а не свалку «другое».
    assert groups["soul"] == "r&b"


def test_catalog_labels_are_localized(top_tags):
    labels = {o["key"]: o["label"] for o in lastfm_genres.build_catalog()}
    assert labels["black metal"] == "Блэк-метал"
    assert labels["techno"] == "Техно"


def test_catalog_falls_back_without_network(monkeypatch):
    """Ключа/сети нет — онбординг всё равно показывает наши 12 жанров."""
    monkeypatch.setattr(beets_similar, "get_network", lambda: None)
    catalog = lastfm_genres.genre_catalog()
    assert {o["key"] for o in catalog} == set(GENRE_KEYWORDS)
    assert all(o["label"] for o in catalog)


def test_catalog_falls_back_on_lastfm_error(monkeypatch):
    class Boom:
        def get_top_tags(self, limit=0):
            raise RuntimeError("last.fm 403")

    monkeypatch.setattr(beets_similar, "get_network", lambda: Boom())
    assert {o["key"] for o in lastfm_genres.genre_catalog()} == set(GENRE_KEYWORDS)


@pytest.mark.parametrize("value", ["phonk", "black metal", "Techno", "punk rock"])
def test_is_known_genre_accepts_genres(value):
    assert lastfm_genres.is_known_genre(value)


@pytest.mark.parametrize("value", ["seen live", "female vocalists", "80s", "", None])
def test_is_known_genre_rejects_meta_tags(value):
    assert not lastfm_genres.is_known_genre(value)


def test_artists_for_genres_round_robin(monkeypatch):
    """Выбрал фонк и джаз — в подсказках оба, а не только первый жанр."""
    per_tag = {
        "phonk": ["MADK1D", "Kordhell", "DVRST"],
        "jazz": ["Miles Davis", "MADK1D", "Bill Evans"],
    }
    monkeypatch.setattr(
        lastfm_genres, "tag_artists", lambda tag, limit=30: per_tag.get(tag, [])
    )
    # Теги артистов не спрашиваем: проверяем именно чередование, а порядок
    # внутри жанра проверяют тесты про _genre_affinity ниже.
    monkeypatch.setattr(lastfm_genres, "artist_tags", lambda name: [])
    names = lastfm_genres.artists_for_genres(["phonk", "jazz"], limit=5)
    # По кругу: сначала первые артисты каждого жанра, потом вторые. MADK1D есть
    # в обоих списках, но в выдаче один раз — на своём первом месте.
    assert names == ["MADK1D", "Miles Davis", "Kordhell", "DVRST", "Bill Evans"]


def test_artists_for_genres_without_genres(monkeypatch):
    monkeypatch.setattr(lastfm_genres, "tag_artists", lambda tag, limit=30: ["X"])
    assert lastfm_genres.artists_for_genres([]) == []
    assert lastfm_genres.artists_for_genres(["  "]) == []


# Живые данные Last.fm: у Бибера «black metal» второй тег с весом 58 (шуточные
# теги), у Mayhem он же главный. Именно на этом ломалась проверка по одному
# наличию тега и по нашим 12 ключам.
BIEBER_TAGS = [("pop", 100), ("black metal", 58), ("rnb", 35), ("hip-hop", 11)]
MAYHEM_TAGS = [("black metal", 100), ("norwegian black metal", 34), ("metal", 4)]
SINATRA_TAGS = [("jazz", 100), ("swing", 67), ("oldies", 26)]
LACY_TAGS = [("free jazz", 100), ("jazz", 90), ("rnb", 29)]


def test_affinity_ignores_low_weight_joke_tags():
    assert lastfm_genres._genre_affinity("black metal", MAYHEM_TAGS) == 2
    # Тег есть, но слабый (58 при поп-100) — судим по главному тегу: мимо.
    assert lastfm_genres._genre_affinity("black metal", BIEBER_TAGS) == 0


def test_affinity_broader_main_tag_is_close():
    """Главный тег — «metal» при выбранном «black metal»: рядом, но не точно."""
    assert lastfm_genres._genre_affinity("black metal", [("metal", 100)]) == 1


def test_affinity_counts_subgenre_as_match():
    """Главный тег — поджанр выбранного: «free jazz» подходит под «jazz»."""
    assert lastfm_genres._genre_affinity("jazz", LACY_TAGS) == 2
    assert lastfm_genres._genre_affinity("jazz", SINATRA_TAGS) == 2
    assert lastfm_genres._genre_affinity("jazz", BIEBER_TAGS) == 0


def test_affinity_without_tags_is_neutral():
    """Last.fm не знает артиста — не наказываем, иначе список схлопнется."""
    assert lastfm_genres._genre_affinity("jazz", []) == 1
    assert lastfm_genres._genre_affinity("", MAYHEM_TAGS) == 1


def test_artists_for_genres_sinks_mismatched(monkeypatch):
    """Bieber из топа «black metal» уходит в конец, группы — вперёд."""
    tags = {"Justin Bieber": BIEBER_TAGS, "Mayhem": MAYHEM_TAGS}
    monkeypatch.setattr(
        lastfm_genres,
        "tag_artists",
        lambda tag, limit=30: ["Justin Bieber", "Mayhem", "Darkthrone"],
    )
    monkeypatch.setattr(lastfm_genres, "artist_tags", lambda name: tags.get(name, []))
    names = lastfm_genres.artists_for_genres(["black metal"], limit=3)
    # Darkthrone тегов не имеет (нейтральный 1) и потому выше Бибера, но ниже
    # Mayhem, у которого жанр в главных тегах.
    assert names == ["Mayhem", "Darkthrone", "Justin Bieber"]


def test_genres_endpoint(client, top_tags):
    resp = client.get("/api/users/genres")
    assert resp.status_code == 200, resp.text
    options = resp.json()
    keys = [o["key"] for o in options]
    assert "black metal" in keys and "phonk" in keys
    assert "seen live" not in keys
    black = next(o for o in options if o["key"] == "black metal")
    assert black["group"] == "rock" and black["group_label"] == "Рок"


def test_artists_by_genres_endpoint(client, db, monkeypatch):
    create_user(db)
    monkeypatch.setattr(
        lastfm_genres,
        "tag_artists",
        lambda tag, limit=30: {"techno": ["Underworld"], "jazz": ["Sade"]}.get(tag, []),
    )
    monkeypatch.setattr(lastfm_genres, "artist_tags", lambda name: [])
    resp = client.get(
        "/api/users/artists/by-genres",
        params={"genres": "techno,jazz", "limit": 5},
        headers=auth_headers(client),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()[:2] == ["Underworld", "Sade"]


def test_artists_by_genres_tops_up_from_catalog(client, db, monkeypatch):
    """Last.fm молчит — подсказки не пустые: добираем каталогом по прослушкам."""
    create_user(db)
    db.add_all([
        Track(title="A", artist="Популярный", duration=100, source="local", play_count=50),
        Track(title="B", artist="Редкий", duration=100, source="local", play_count=1),
    ])
    db.commit()
    monkeypatch.setattr(lastfm_genres, "tag_artists", lambda tag, limit=30: [])

    resp = client.get(
        "/api/users/artists/by-genres",
        params={"genres": "techno", "limit": 5},
        headers=auth_headers(client),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()[0] == "Популярный"


def test_preferences_accept_lastfm_tag_and_drop_meta(client, db):
    """Каталог теперь из Last.fm, поэтому «black metal» обязан сохраняться."""
    create_user(db)
    resp = client.put(
        "/api/users/me/preferences",
        json={
            "preferred_genres": ["black metal", "seen live", "PHONK", "phonk"],
            "preferred_artists": [],
            "excluded_artists": [],
        },
        headers=auth_headers(client),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["preferred_genres"] == ["black metal", "phonk"]
