"""Жанровые знания beets как второй словарь после genre_keywords.

genre_keywords.py — 12 ключей и список слов на каждый. Этого хватает на
основной вкус сервиса (фонк, рэп, русское) и НЕ хватает на всё остальное:
провайдер отдаёт "Dark Wave", "Eurodance", "Drum & Bass", "Witch House", а
словарь их не знает и `infer_genre_from_text` возвращает None. Дальше в
taste.py срабатывает пункт 4 («жанр неопределим»), где решает грубый языковой
прокси, а у кандидата с provenance_trusted — вообще ничего: похожий артист
проходит без жанровой проверки. Именно так в волну и просачивалось
постороннее.

beets (менеджер музыкальной коллекции) держит для своего плагина lastgenre три
файла данных, и они ровно про эту дырку:

* ``genres.txt`` — 1568 канонических имён жанров;
* ``aliases.yaml`` — регексы вариантов написания: "RnB" → "r&b",
  "hip-hop" → "hip hop", "dnb" → "drum and bass", "electronic music" →
  "electronic". Пишется руками сообществом beets — свой такой словарь мы бы
  сочиняли годами;
* ``genres-tree.yaml`` — ДЕРЕВО наследования: "dark wave" → "electronic rock"
  → "electronic", "witch house" → "industrial" → "electronic", "rock and roll"
  → "rock". Оно и переводит незнакомое имя в один из наших 12 ключей.

Всё это работает ОФФЛАЙН, без конфига beets, без сети и без библиотеки на
диске: читаем файлы данных и зовём чистые функции плагина
(``flatten_tree``/``find_parents``/``normalize_genre``).

Встраивание строго ДОПОЛНЯЮЩЕЕ, и это принципиально: словарь проекта всегда
спрашивается первым, beets — только на его промахе. Причина не в вежливости, а
в конкретных расхождениях. У beets ``trap`` — это поджанр UK garage
(``trap`` → ``uk garage`` → ``electronic``), а у нас trap — хип-хоповый; отдай
мы решение beets, слушателю рэпа поехало бы техно. ``phonk`` beets не знает
вовсе, кириллицы в его словаре нет по определению. Поэтому имена, которые проект
трактует иначе, перечислены в ``_APP_OWNED`` и разбираются до обхода дерева.

Если beets в образе нет (старый образ, пока не пересобран), модуль тихо
выключается: ``available()`` возвращает False, остальные функции — None/пусто,
и поведение сервиса ровно такое, каким было до интеграции.
"""

import logging
import re
from functools import lru_cache
from typing import List, Optional

logger = logging.getLogger(__name__)

# Наши 12 ключей — это КОРНИ, к которым сводится дерево beets. Слева имя узла
# beets, справа ключ genre_keywords.GENRE_KEYWORDS. Перечислены и корни дерева
# (21 штука), и те узлы поглубже, чей смысл у нас совпадает с ключом.
# Корни beets, которых в нашем словаре нет (african, asian, blues, country,
# comedy, easy listening, kids music, soundtrack, singer-songwriter,
# world music, caribbean and latin american, r&b, avant-garde), сюда намеренно
# НЕ попадают: результат «beets жанр узнал, но он вне нашего словаря» — это
# None, то есть «мнения нет», и вызывающий остаётся при своём поведении.
_BEETS_TO_INTERNAL: dict = {
    "hip hop": "hip-hop",
    "rap": "hip-hop",
    "rock": "rock",
    "electronic": "electronic",
    "pop": "pop",
    "jazz": "jazz",
    "classical": "classical",
    "classical music": "classical",
    "reggae": "reggae",
    "folk": "folk",
    "folk music": "folk",
}

# Имена, которые проект трактует ИНАЧЕ, чем дерево beets, — разбираются раньше
# обхода дерева. Каждая строка здесь означает конкретное расхождение:
#
# * trap: у beets это поджанр UK garage (→ electronic), у нас — хип-хоповый
#   трэп, отдельный ключ. Без этой записи «Trap» в поле genre увело бы
#   слушателя рэпа в электронику;
# * phonk: beets о нём не знает (в whitelist его нет), а у нас это ключ №1;
# * lo-fi: beets вешает его под avant-garde, у нас это самостоятельный lofi;
# * chillout/downtempo/ambient: у beets ветка electronic, у нас отдельный
#   ключ chill (см. GENRE_KEYWORDS["chill"]).
_APP_OWNED: dict = {
    "trap": "trap",
    "trap music": "trap",
    "phonk": "phonk",
    "drift phonk": "phonk",
    "lo-fi": "lofi",
    "lofi": "lofi",
    "chill": "chill",
    "chillout": "chill",
    "downtempo": "chill",
    "ambient": "chill",
}

# Разделители «жанр или жанр» в свободной строке провайдера: "Hip-Hop & Rap",
# "Electronic / House", "Rock, Metal". Целиком такая строка ни в whitelist, ни
# в алиасы не попадает, поэтому при промахе разбираем её на части.
_SPLIT_RE = re.compile(r"\s*[/,;|+&·•]\s*|\s+[-–—]\s+")

# Границы слов внутри составного имени жанра ("drum and bass", "k-pop").
_WORD_SEP_RE = re.compile(r"[\s\-]+")

# Минимальная длина имени жанра, которое ищем в СВОБОДНОМ тексте (названии
# трека). Одиночные короткие слова из whitelist beets ("acid", "dub", "juke",
# "emo") в прозе ловят что попало, а на кириллице не ловят ничего полезного —
# см. историю ложных срабатываний в genre_keywords._KEYWORD_PATTERNS
# ("warehouse" → house, "grape" → rap). В тексте ищем только СОСТАВНЫЕ имена
# ("dark wave", "witch house", "drum and bass", "k-pop") — их 826 из 1568, и
# случайно совпасть словосочетанием проза не может.
_TEXT_MIN_LEN = 4


class _Vocabulary:
    """Загруженные данные beets: алиасы, whitelist, ветки дерева."""

    def __init__(self, alias_patterns, whitelist: set, branches: list, find_parents):
        self.alias_patterns = alias_patterns
        self.whitelist = whitelist
        self.branches = branches
        self._find_parents = find_parents
        self._log = None
        self._phrase_re = None

    def normalize(self, genre: str) -> str:
        """Вариант написания → каноническое имя beets (через aliases.yaml)."""
        from beetsplug.lastgenre.utils import normalize_genre

        return normalize_genre(self._log, self.alias_patterns, genre)

    def parents(self, genre: str) -> List[str]:
        """Цепочка наследования: сам жанр, затем родители от близкого к корню."""
        return list(self._find_parents(genre, self.branches))

    @property
    def phrase_re(self):
        """Одна альтернатива из всех СОСТАВНЫХ имён, длинные первыми.

        Длинные первыми обязательны: альтернация в Python берёт первое
        подошедшее в данной позиции, поэтому при обратном порядке
        "old school hip hop" совпал бы как "hip hop" и потерял специфику.

        Слова внутри имени соединяем через ``[\\s\\-]*``, а не жёстким пробелом:
        в whitelist записано "dark wave", а провайдеры в названиях пишут
        "Darkwave", "Dark-Wave", "dark wave" — все три должны совпасть.
        """
        if self._phrase_re is None:
            phrases = sorted(
                (
                    g
                    for g in self.whitelist
                    if len(g) >= _TEXT_MIN_LEN and _WORD_SEP_RE.search(g)
                ),
                key=len,
                reverse=True,
            )
            self._phrase_re = re.compile(
                r"\b(?:"
                + "|".join(
                    r"[\s\-]*".join(re.escape(w) for w in _WORD_SEP_RE.split(p) if w)
                    for p in phrases
                )
                + r")\b",
                re.IGNORECASE,
            )
        return self._phrase_re


_vocab: Optional[_Vocabulary] = None
_load_failed = False


def _load() -> Optional[_Vocabulary]:
    """Читает файлы данных beets один раз за процесс (или запоминает отказ)."""
    global _vocab, _load_failed
    if _vocab is not None or _load_failed:
        return _vocab

    try:
        import yaml
        import beets.logging as beets_logging
        from beetsplug.lastgenre import (
            ALIASES_FILE,
            C14N_TREE,
            WHITELIST,
            find_parents,
            flatten_tree,
        )

        with open(WHITELIST, encoding="utf-8") as fh:
            whitelist = {
                line
                for raw in fh
                if (line := raw.strip().lower()) and not line.startswith("#")
            }

        with open(ALIASES_FILE, encoding="utf-8") as fh:
            raw_aliases = yaml.safe_load(fh) or {}
        # Ключ в aliases.yaml — это ШАБЛОН замены (может содержать \1), а не
        # готовое имя; подстановку делает сам normalize_genre через
        # re.Match.expand. Порядок пар сохраняем — beets опирается на него.
        alias_patterns = [
            (re.compile(pattern, re.IGNORECASE), str(canonical).lower())
            for canonical, patterns in raw_aliases.items()
            for pattern in (patterns or [])
        ]

        with open(C14N_TREE, encoding="utf-8") as fh:
            tree = yaml.safe_load(fh)
        branches: list = []
        flatten_tree(tree, [], branches)

        vocab = _Vocabulary(alias_patterns, whitelist, branches, find_parents)
        # normalize_genre пишет отладку через beets-specific extra_debug,
        # которого у logger'а stdlib нет, — берём логгер beets. Имя ОБЯЗАНО
        # отличаться от нашего __name__: beets подставляет свой класс логгера
        # только при СОЗДАНИИ, а logging.getLogger(__name__) выше уже создал
        # для этого имени обычный Logger, и beets вернул бы его же — падение
        # на AttributeError при первом же совпавшем алиасе.
        vocab._log = beets_logging.getLogger("beets.lastgenre.music_service")
        _vocab = vocab
        logger.info(
            "beets genre vocabulary loaded: %d genres, %d aliases, %d branches",
            len(whitelist),
            len(alias_patterns),
            len(branches),
        )
    except Exception:  # noqa: BLE001
        # Образ без beets (ещё не пересобран) или несовместимая версия — не
        # повод ронять рекомендации: работаем на одном genre_keywords.
        _load_failed = True
        logger.warning("beets genre vocabulary unavailable, using keywords only")
    return _vocab


def available() -> bool:
    """Данные beets загружены и словарём можно пользоваться?"""
    return _load() is not None


def reset_cache() -> None:
    """Сбрасывает мемоизацию — нужен тестам, подменяющим доступность beets."""
    global _vocab, _load_failed
    _vocab = None
    _load_failed = False
    canonical.cache_clear()
    to_internal.cache_clear()


@lru_cache(maxsize=4096)
def canonical(raw: str) -> Optional[str]:
    """Свободная строка жанра → каноническое имя из whitelist beets.

    Строка, про которую ЗАЯВЛЕНО, что она жанр (поле genre у трека), поэтому
    односложные имена здесь допустимы — в отличие от поиска по названию (см.
    ``detect``). "Rock & Roll" → "rock and roll", "RnB" → "r&b",
    "Hip-Hop & Rap" → "hip hop" (разбором по разделителю). Возвращает None,
    если такого жанра beets не знает.
    """
    vocab = _load()
    if vocab is None or not raw or not raw.strip():
        return None

    for candidate in [raw, *_SPLIT_RE.split(raw)]:
        candidate = candidate.strip()
        if not candidate:
            continue
        name = vocab.normalize(candidate)
        if name in vocab.whitelist:
            return name
    return None


def lineage(genre: str) -> List[str]:
    """Цепочка наследования жанра по дереву beets: сам жанр, затем родители.

    "dark wave" → ["dark wave", "electronic rock", "electronic"]. Незнакомое
    дереву имя возвращает само себя одним элементом (так работает
    beets.find_parents), пустой словарь — пустой список.
    """
    vocab = _load()
    if vocab is None or not genre:
        return []
    return vocab.parents(genre)


@lru_cache(maxsize=4096)
def to_internal(genre: str) -> Optional[str]:
    """Имя жанра beets → ключ genre_keywords.GENRE_KEYWORDS, если он есть.

    Сначала имена, которые проект трактует по-своему (``_APP_OWNED``), затем
    обход дерева от специфичного к корню. None означает «жанр вне нашего
    словаря» (k-pop, country, blues) — мнения нет, а не «не подходит».
    """
    if not genre or _load() is None:
        return None
    name = canonical(genre) or genre.strip().lower()
    for step in lineage(name) or [name]:
        if step in _APP_OWNED:
            return _APP_OWNED[step]
        if step in _BEETS_TO_INTERNAL:
            return _BEETS_TO_INTERNAL[step]
    return None


def detect(text: str) -> Optional[str]:
    """Самое специфичное СОСТАВНОЕ имя жанра beets, упомянутое в тексте.

    Ищем только словосочетания ("dark wave", "drum and bass", "k-pop") —
    односложные имена в прозе дают ложные срабатывания, которыми уже болел
    genre_keywords (см. _TEXT_MIN_LEN). Из нескольких совпадений берём самое
    длинное: "old school hip hop" информативнее, чем "hip hop".
    """
    vocab = _load()
    if vocab is None or not text or not text.strip():
        return None
    matches = [m.group(0).lower() for m in vocab.phrase_re.finditer(text)]
    if not matches:
        return None
    return vocab.normalize(max(matches, key=len))


def internal_from_text(text: str) -> Optional[str]:
    """Ключ нашего словаря по составному имени жанра в свободном тексте."""
    found = detect(text)
    return to_internal(found) if found else None


def matches_user_genres(raw: str, user_genres: set) -> bool:
    """Жанр (свободная строка) сводится к одному из жанров вкуса юзера?

    Только положительный ответ: вызывающий (genre_keywords.genre_is_compatible)
    при промахе своего словаря и так отбраковывает кандидата, поэтому beets
    здесь может лишь ДОБАВИТЬ «подходит» — на жанрах, которые словарь проекта
    не знает ("Eurodance" и "Dark Wave" слушателю электроники). Отбраковок
    beets не добавляет: на его «не знаю» поведение остаётся прежним.
    """
    if not raw or not user_genres:
        return False
    internal = to_internal(raw)
    if internal is None:
        return False
    return internal in {str(g).strip().lower() for g in user_genres if g}


def subgenres(internal_genres, limit: int = 0) -> List[str]:
    """Конкретные поджанры вкуса — поисковые запросы для разведки в потоке.

    flow.py при отсутствии title_tags искал у провайдеров склейку наших
    жанровых ключей ("phonk hip-hop"): двумя общими словами разом провайдер не
    находит ничего осмысленного. Дерево beets даёт вместо этого настоящие имена
    поджанров ("memphis rap", "witch house", "dark wave"), по которым у
    SoundCloud и YT Music реально есть каталог, — то есть разведка по тегам
    начинает открывать новое, а не возвращать шум.

    Спуск по дереву делаем ТОЛЬКО от жанров, чей корень в beets совпадает с
    нашим ключом. phonk и trap исключены умышленно: phonk дерево не знает, а
    trap у beets из ветки UK garage, и его «поджанры» увели бы рэп в
    электронику (см. _APP_OWNED).

    Порядок детерминированный (обход веток дерева), список полный: выбор
    конкретного запроса на эту подгрузку — дело вызывающего, ему нужна
    ротация, а не первые N всегда одинаковых имён.
    """
    vocab = _load()
    if vocab is None:
        return []

    wanted = {str(g).strip().lower() for g in (internal_genres or []) if g}
    if not wanted:
        return []
    roots = [
        beets_name
        for beets_name, internal in _BEETS_TO_INTERNAL.items()
        if internal in wanted
    ]
    if not roots:
        return []

    found: List[str] = []
    seen = set()
    for branch in vocab.branches:
        for root in roots:
            if root not in branch:
                continue
            for name in branch[branch.index(root) + 1 :]:
                # Только имена из whitelist: в дереве есть и служебные
                # узлы-группировки ("east asian"), которые как поисковый
                # запрос бессмысленны.
                if name in seen or name not in vocab.whitelist:
                    continue
                seen.add(name)
                found.append(name)
    return found[:limit] if limit else found
