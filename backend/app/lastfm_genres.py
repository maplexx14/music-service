"""Каталог жанров для выбора пользователем — теги Last.fm, а не наш словарь.

`genre_keywords.GENRE_KEYWORDS` — это 12 общих слов, которыми ДВИЖОК сводит
любое имя жанра к одному корню. Как список для выбора на онбординге они плохи:
слушателю блэк-метала предлагается «Рок», фанату мемфис-рэпа — «Хип-хоп / Рэп»,
и обратно из такого выбора не восстановить ничего конкретного. Last.fm держит
живой список тегов с настоящей популярностью ("black metal", "punk rock",
"techno", "chillout") — его и показываем.

Что здесь происходит:

* `chart.getTopTags` через pylast — 50 самых популярных тегов Last.fm (больше
  этот метод не отдаёт, страниц у него нет);
* среди них половина — НЕ жанры ("seen live", "female vocalists", "80s",
  "british", "bookmark"). Фильтр жанровости — данные beets (whitelist из 1568
  имён, дерево наследования) плюс наш словарь: см. `_is_genre_tag`;
* к отфильтрованным тегам добавляются наши ключи (`GENRE_KEYWORDS`) — в топе
  Last.fm нет ни фонка, ни трэпа, ни lo-fi, на которых стоит вкус сервиса;
* каждый тег получает ГРУППУ (внутренний ключ, к которому сводится) — UI
  раскладывает по ней чипы, а `genre_keywords.expand_user_genres` использует
  то же сведение при проверке совместимости.

Артисты по выбранным жанрам (`tag.getTopArtists`) — второй шаг онбординга:
подсказки обязаны зависеть от жанров, выбранных на первом. Топ тега сам по себе
для этого не годится: теги народные, и в «black metal» первым стоит Justin
Bieber. Поэтому каждый кандидат сверяется со своими же тегами
(`artist.getTopTags`), и мимо-жанровые уходят в хвост списка.

Ключа нет, сети нет, pylast нет — отдаём наши 12 ключей как раньше. Онбординг
обязан работать всегда, Last.fm здесь улучшение, а не зависимость.
"""

import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import List

from app import beets_genre, beets_similar
from app.cache import get_cache, set_cache
from app.genre_keywords import GENRE_KEYWORDS, GENRE_LABELS, resolve_internal_key

logger = logging.getLogger(__name__)

# Last.fm отдаёт по chart.getTopTags максимум 50 имён (проверено: limit=250
# возвращает те же 50), поэтому просим ровно столько и дополняем своими.
_TOP_TAGS_LIMIT = 50

_CATALOG_CACHE_KEY = "prefs:genre_catalog:v2"
_CATALOG_TTL = 24 * 60 * 60
# Пустой ответ (Last.fm лежит) кэшируем коротко — иначе один сбой держит
# онбординг на фолбэке сутки.
_CATALOG_TTL_EMPTY = 10 * 60

_TAG_ARTISTS_TTL = 7 * 24 * 60 * 60
_TAG_ARTISTS_TTL_EMPTY = 10 * 60

# Жанры артиста по его тегам: кэш на месяц (они не меняются), пустой ответ —
# на час. Берём только верхние теги: ниже начинается тот же народный шум, от
# которого эта проверка и защищает.
_ARTIST_TAGS_TTL = 30 * 24 * 60 * 60
_ARTIST_TAGS_TTL_EMPTY = 60 * 60
_ARTIST_TAG_DEPTH = 5
# Вес тега артиста (0..100, у главного тега всегда 100), с которого считаем тег
# определяющим. 85 — потому что настоящий жанр у артиста весит 90-100, а
# шуточный тег заметно ниже: у Justin Bieber «black metal» это 58 при «pop» 100.
_AFFINITY_STRONG = 85
# Сколько кандидатов вообще проверяем за запрос и в сколько потоков. Мало и то
# и то намеренно: Last.fm отвечает на всплеск запросов 403 на час-другой.
_VERIFY_BUDGET = 24
_VERIFY_WORKERS = 3

# Теги, которые фильтр жанровости не пропускает (их нет в whitelist beets и
# наш словарь их не знает), но это всё-таки жанры, а не мета-метки. Мода/
# десятилетия/страны/языки сюда НЕ попадают намеренно.
_EXTRA_GENRE_TAGS = {
    "dance",
    "soundtrack",
    "experimental",
    "psychedelic",
    "trance",
    "drum and bass",
    "phonk",
    "hyperpop",
    "k-pop",
    "j-pop",
    "shoegaze",
    "grime",
    "drill",
}

# Русские подписи для тегов, которые реально приходят в топе Last.fm.
# Неизвестный тег показываем как есть (с заглавной) — врать переводом хуже,
# чем оставить английское имя жанра, оно и так узнаваемо.
_RU_LABELS = {
    "alternative": "Альтернатива",
    "alternative rock": "Альтернативный рок",
    "ambient": "Эмбиент",
    "black metal": "Блэк-метал",
    "blues": "Блюз",
    "chillout": "Чилаут",
    "classic rock": "Классический рок",
    "classical": "Классика",
    "dance": "Танцевальная",
    "death metal": "Дэт-метал",
    "drum and bass": "Drum & Bass",
    "electronic": "Электроника",
    "electronica": "Электроника (electronica)",
    "experimental": "Экспериментальная",
    "folk": "Фолк",
    "hard rock": "Хард-рок",
    "hardcore": "Хардкор",
    "heavy metal": "Хеви-метал",
    "hip-hop": "Хип-хоп / Рэп",
    "hip hop": "Хип-хоп",
    "house": "Хаус",
    "indie": "Инди",
    "indie rock": "Инди-рок",
    "industrial": "Индастриал",
    "jazz": "Джаз",
    "metal": "Метал",
    "metalcore": "Металкор",
    "pop": "Поп",
    "post-rock": "Пост-рок",
    "progressive metal": "Прогрессив-метал",
    "progressive rock": "Прогрессив-рок",
    "psychedelic": "Психоделика",
    "punk": "Панк",
    "punk rock": "Панк-рок",
    "rap": "Рэп",
    "reggae": "Регги",
    "rock": "Рок",
    "singer-songwriter": "Авторская песня",
    "soul": "Соул",
    "soundtrack": "Саундтреки",
    "techno": "Техно",
    "thrash metal": "Трэш-метал",
    "trance": "Транс",
}

def _label_for(tag: str) -> str:
    """Русская подпись тега, иначе он же с заглавной буквы."""
    low = tag.strip().lower()
    if low in _RU_LABELS:
        return _RU_LABELS[low]
    if low in GENRE_LABELS:
        return GENRE_LABELS[low]
    return tag.strip()[:1].upper() + tag.strip()[1:]


def _is_genre_tag(name: str) -> bool:
    """Тег Last.fm — это жанр, а не мета-метка?

    Топ Last.fm наполовину состоит из «seen live», «female vocalists», «80s»,
    «british», «bookmark» — в списке жанров им делать нечего. Проверяем по
    ОФФЛАЙН-данным: имя есть в whitelist beets, либо дерево beets знает его как
    поджанр, либо его узнаёт наш словарь. Мета-метки не проходят ни один из
    этих тестов (проверено на реальном топ-50: отсеялись все).
    """
    if not name or not name.strip():
        return False
    low = name.strip().lower()
    if low in GENRE_KEYWORDS or low in _EXTRA_GENRE_TAGS:
        return True
    if beets_genre.canonical(name):
        return True
    # Дерево beets знает имя как ПОДЖАНР (len>1 — есть родитель): так проходят
    # "folk"/"hardcore", которых нет в whitelist, но есть в genres-tree.
    if len(beets_genre.lineage(low)) > 1:
        return True
    return resolve_internal_key(low) is not None


def _top_tags() -> List[tuple]:
    """[(имя тега, вес), ...] из chart.getTopTags. Ошибка/нет ключа — пусто."""
    net = beets_similar.get_network()
    if net is None:
        return []
    try:
        items = net.get_top_tags(limit=_TOP_TAGS_LIMIT)
    except Exception as exc:  # noqa: BLE001
        logger.warning("last.fm top tags failed: %s", exc)
        return []

    tags: List[tuple] = []
    for item in items:
        try:
            name = item.item.get_name() or ""
            weight = int(item.weight or 0)
        except Exception:  # noqa: BLE001
            continue
        if name.strip():
            tags.append((name.strip(), weight))
    return tags


def _fallback_catalog() -> List[dict]:
    """Наши 12 ключей — каталог, когда Last.fm недоступен."""
    return [
        {
            "key": key,
            "label": GENRE_LABELS.get(key, _label_for(key)),
            "group": key,
            "group_label": GENRE_LABELS.get(key, _label_for(key)),
            "popularity": 0,
        }
        for key in GENRE_KEYWORDS
    ]


def _group_for(tag: str) -> tuple:
    """(ключ группы, подпись группы) для тега.

    Сначала наш внутренний ключ — им же пользуется
    `genre_keywords.expand_user_genres`, так что UI группирует ровно так, как
    движок сводит вкус. Наш словарь имя не узнал — берём КОРЕНЬ ветки beets
    ("blues" для "delta blues", "r&b" для "soul"): корней у дерева 21, и это
    честная жанровая группировка вместо свалки «Другое». Не узнал никто — тег
    сам себе группа.
    """
    low = tag.strip().lower()
    internal = resolve_internal_key(low)
    if internal:
        return internal, GENRE_LABELS.get(internal, _label_for(internal))
    chain = beets_genre.lineage(beets_genre.canonical(low) or low)
    root = chain[-1] if chain else low
    return root, _label_for(root)


def build_catalog(limit: int = 0) -> List[dict]:
    """Каталог жанров: теги Last.fm (жанровые) + наши ключи. БЛОКИРУЮЩАЯ.

    Порядок: сначала популярность Last.fm, затем наши ключи, которых в топе не
    было (фонк, трэп, lo-fi и т.п.) — они нужны всегда, вкус сервиса стоит
    на них. limit=0 — весь каталог.
    """
    seen = set()
    catalog: List[dict] = []

    for name, weight in _top_tags():
        low = name.lower()
        if low in seen or not _is_genre_tag(name):
            continue
        seen.add(low)
        group, group_label = _group_for(low)
        catalog.append(
            {
                "key": low,
                "label": _label_for(name),
                "group": group,
                "group_label": group_label,
                "popularity": weight,
            }
        )

    for key in GENRE_KEYWORDS:
        if key in seen:
            continue
        seen.add(key)
        catalog.append(
            {
                "key": key,
                "label": GENRE_LABELS.get(key, _label_for(key)),
                "group": key,
                "group_label": GENRE_LABELS.get(key, _label_for(key)),
                "popularity": 0,
            }
        )

    return catalog[:limit] if limit else catalog


def genre_catalog(limit: int = 0) -> List[dict]:
    """Каталог жанров с кэшем в Redis. БЛОКИРУЮЩАЯ.

    Промах Last.fm не роняет онбординг: отдаём фолбэк из наших ключей и
    кэшируем его коротко, чтобы следующий заход попробовал сеть снова.
    """
    cached = get_cache(_CATALOG_CACHE_KEY)
    if cached:
        return cached[:limit] if limit else cached

    catalog = build_catalog()
    from_lastfm = len(catalog) > len(GENRE_KEYWORDS)
    if not from_lastfm:
        catalog = catalog or _fallback_catalog()
    set_cache(
        _CATALOG_CACHE_KEY,
        catalog,
        expire=_CATALOG_TTL if from_lastfm else _CATALOG_TTL_EMPTY,
    )
    return catalog[:limit] if limit else catalog


async def genre_catalog_async(limit: int = 0) -> List[dict]:
    """То же, но не блокируя event loop: pylast синхронный."""
    return await asyncio.to_thread(genre_catalog, limit)


def tag_artists(tag: str, limit: int = 30) -> List[str]:
    """Топ артистов тега Last.fm (tag.getTopArtists). БЛОКИРУЮЩАЯ.

    Кэш на неделю: топ артистов жанра меняется медленно, а на онбординге этот
    запрос идёт на каждый выбранный жанр.
    """
    name = (tag or "").strip()
    if not name:
        return []
    cache_key = f"prefs:tag_artists:v1:{name.lower()}"
    cached = get_cache(cache_key)
    if cached is not None:
        return cached[:limit]

    net = beets_similar.get_network()
    if net is None:
        return []
    try:
        items = net.get_tag(name).get_top_artists(limit=max(limit, 30))
    except Exception as exc:  # noqa: BLE001
        logger.warning("last.fm top artists failed for tag %s: %s", name, exc)
        return []

    names: List[str] = []
    seen = set()
    for item in items:
        try:
            artist = item.item.get_name() or ""
        except Exception:  # noqa: BLE001
            continue
        low = artist.strip().lower()
        if not low or low in seen:
            continue
        seen.add(low)
        names.append(artist.strip())

    set_cache(
        cache_key,
        names,
        expire=_TAG_ARTISTS_TTL if names else _TAG_ARTISTS_TTL_EMPTY,
    )
    return names[:limit]


def artist_tags(name: str) -> List[tuple]:
    """Верхние теги артиста с весами: [(тег, вес 0..100)]. БЛОКИРУЮЩАЯ.

    Вес Last.fm нормирован на главный тег артиста (у него всегда 100), и без
    него теги бесполезны: у Justin Bieber «black metal» стоит вторым тегом с
    весом 58 при «pop» 100 — по одному факту наличия тега он проходит за
    блэк-метал-группу, по весу — нет.

    Кэш на месяц: жанр артиста не меняется, а на онбординге этим проверяется
    каждый кандидат. Пустой список — «Last.fm тегов не знает», см.
    `_genre_affinity`.
    """
    clean = (name or "").strip()
    if not clean:
        return []
    cache_key = f"prefs:artist_tags:v2:{clean.lower()}"
    cached = get_cache(cache_key)
    if cached is not None:
        return [(tag, weight) for tag, weight in cached]

    net = beets_similar.get_network()
    if net is None:
        return []
    try:
        items = net.get_artist(clean).get_top_tags(limit=_ARTIST_TAG_DEPTH)
    except Exception as exc:  # noqa: BLE001
        logger.warning("last.fm artist tags failed for %s: %s", clean, exc)
        return []

    tags: List[tuple] = []
    known = set()
    for item in items[:_ARTIST_TAG_DEPTH]:
        try:
            tag = (item.item.get_name() or "").strip().lower()
            weight = int(item.weight or 0)
        except Exception:  # noqa: BLE001
            continue
        if tag and tag not in known:
            known.add(tag)
            tags.append((tag, weight))

    set_cache(
        cache_key,
        [[tag, weight] for tag, weight in tags],
        expire=_ARTIST_TAGS_TTL if tags else _ARTIST_TAGS_TTL_EMPTY,
    )
    return tags


def _genre_affinity(tag: str, tags_of_artist) -> int:
    """Насколько артист похож на выбранный жанр: 2 — точно, 1 — рядом, 0 — мимо.

    Судим ТОЛЬКО по главным тегам артиста (вес ≥ `_AFFINITY_STRONG`): слабые
    теги — это и есть шум, от которого проверка защищает. 2 — выбранный жанр
    среди главных, сам или как родитель по дереву beets («free jazz» подходит
    под «jazz»). 1 — главный тег сводится к тому же нашему ключу («metal» для
    «black metal»): ошибиться тут не страшно. 0 — мимо. Тегов нет — 1: Last.fm
    просто не знает артиста, наказывать нечем.

    Сравнивать по одним нашим 12 ключам нельзя («black metal» и «pop rock» оба
    сводятся к `rock`), по одному наличию тега — тоже: шуточные теги Last.fm
    висят и на самом артисте («black metal» у Justin Bieber с весом 58).
    """
    wanted = (tag or "").strip().lower()
    if not wanted or not tags_of_artist:
        return 1

    strong = [name for name, weight in tags_of_artist if weight >= _AFFINITY_STRONG]
    if not strong:
        return 1

    canon_wanted = beets_genre.canonical(wanted) or wanted
    for name in strong:
        if name == wanted:
            return 2
        chain = beets_genre.lineage(beets_genre.canonical(name) or name)
        if wanted in chain or canon_wanted in chain:
            return 2

    key = resolve_internal_key(wanted)
    if key and any(resolve_internal_key(name) == key for name in strong):
        return 1
    return 0


def _artist_tag_map(names) -> dict:
    """{имя: его теги} для кандидатов, запросами в несколько потоков.

    pylast синхронный, а ждать пару десятков запросов подряд онбординг не может.
    Потоков намеренно мало: Last.fm отвечает на всплеск запросов с одного ключа
    403 на час-другой, и подсказки артистов того не стоят.
    """
    todo = list(dict.fromkeys(names))[:_VERIFY_BUDGET]
    if not todo:
        return {}
    with ThreadPoolExecutor(max_workers=min(_VERIFY_WORKERS, len(todo))) as pool:
        return dict(zip(todo, pool.map(artist_tags, todo)))


def _round_robin(lists, limit: int) -> List[str]:
    """Берёт по одному из каждого списка по кругу, без повторов."""
    picked: List[str] = []
    seen = set()
    depth = max((len(names) for names in lists), default=0)
    for row in range(depth):
        for names in lists:
            if row >= len(names):
                continue
            low = names[row].lower()
            if low in seen:
                continue
            seen.add(low)
            picked.append(names[row])
            if len(picked) >= limit:
                return picked
    return picked


def artists_for_genres(genres, limit: int = 24, per_genre: int = 12) -> List[str]:
    """Артисты по выбранным жанрам, по кругу из каждого. БЛОКИРУЮЩАЯ.

    Обход по кругу (а не подряд по жанрам) — чтобы в подсказках были все
    выбранные жанры, а не только первый: юзер, выбравший «фонк» и «джаз»,
    должен увидеть и то и то.

    Внутри каждого жанра порядок правится проверкой на соответствие: теги
    Last.fm народные, и топ ими испорчен — первый артист тега «black metal» это
    Justin Bieber, четвёртый NAV. Мимо-жанровых не выбрасываем, а опускаем в
    конец: пустой список подсказок хуже неточного, а сортировка стабильная,
    так что внутри одной оценки остаётся популярность Last.fm.
    """
    wanted = [str(g).strip() for g in (genres or []) if str(g).strip()]
    if not wanted:
        return []

    per_tag = [(tag, tag_artists(tag, limit=per_genre)) for tag in wanted]
    tag_map = _artist_tag_map([name for _, names in per_tag for name in names])
    ranked = [
        sorted(names, key=lambda n: -_genre_affinity(tag, tag_map.get(n)))
        for tag, names in per_tag
    ]
    return _round_robin(ranked, limit)


async def artists_for_genres_async(
    genres, limit: int = 24, per_genre: int = 12
) -> List[str]:
    """То же, но не блокируя event loop."""
    return await asyncio.to_thread(artists_for_genres, genres, limit, per_genre)


def is_known_genre(key: str) -> bool:
    """Ключ можно сохранить в предпочтения?

    Свои 12 ключей — всегда. Тег Last.fm принимаем, если его узнают ОФФЛАЙН
    данные (beets/наш словарь): валидация не должна зависеть от сети, иначе
    сохранение предпочтений ломается вместе с Last.fm.
    """
    if not key or not str(key).strip():
        return False
    low = str(key).strip().lower()
    return low in GENRE_KEYWORDS or _is_genre_tag(low)
