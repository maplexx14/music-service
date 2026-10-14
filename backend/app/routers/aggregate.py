import asyncio
import logging
import re
from types import SimpleNamespace
from typing import List, Tuple

from fastapi import APIRouter, Query, Request

from app import censorship
from app.artist_utils import is_derivative_title
from app.cache import get_cache_async, set_cache_async
from app.routers import soulseek, soundcloud, ytdlp
from app.routers.ytdlp import clean_title
from app.schemas import (
    ExternalPlaylistResponse,
    ExternalSearchGrouped,
    ExternalTrackResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter()

# TTL кэша поиска внешних плейлистов (как _SEARCH_TTL в search.py: выдача
# не от пользователя, сиды на главной меняются редко).
_EXTERNAL_PLAYLISTS_TTL = 180

# Приоритет источников при дедупе одинаковых треков.
# В гибриде по умолчанию показываем быстрый ytmusic, но lossless (soulseek)
# считаем «лучше» и оставляем именно его, если нашёлся дубль.
# ВАЖНО: это приоритет качества при склейке дублей, а НЕ порядок выдачи.
# Порядок задаёт только очерёдность списков, переданных в _merge_sources.
_SOURCE_RANK = {"soulseek": 3, "ytmusic": 2, "soundcloud": 1}

# Маркеры цензурной редакции в названии. У одной записи в YouTube Music часто
# лежат обе версии — оригинал (isExplicit=True) и clean — с одинаковым
# названием, и отличить их по названию нельзя. Но clean-редакции, у которых
# нет explicit-флага, часто подписаны явно. Паттерн блочный: «(Clean)» — да,
# «Clean Bandit» (артист) — нет.
_CLEAN_MARKER = re.compile(
    r"[\(\[][^\)\]]*\b(?:clean|radio\s*edit|edited\s*version)\b[^\)\]]*[\)\]]",
    re.IGNORECASE,
)


def is_clean_edit(text: str) -> bool:
    """В названии (или имени файла) есть маркер цензурной редакции."""
    return bool(_CLEAN_MARKER.search(text or ""))


def _mark_clean(track: ExternalTrackResponse) -> ExternalTrackResponse:
    """Проставляет is_clean по маркерам в названии (для бейджа на фронте).

    Копия, а не мутация: одни и те же объекты приходят из провайдерских кэшей.
    """
    if track.is_clean:
        return track
    if is_clean_edit(track.title):
        return track.model_copy(update={"is_clean": True})
    return track


def _collapse_versions(tracks: List[ExternalTrackResponse]) -> List[ExternalTrackResponse]:
    """«Song» и «Song (Clean)» — одна запись в двух редакциях.

    Схлопываем по базовому ключу (clean-маркер вырезается): побеждает
    explicit-версия и сохраняет позицию первой встреченной. Попутно
    проставляем is_clean (бейдж на фронте).
    """
    marked = [_mark_clean(t) for t in tracks]

    best: dict = {}
    order: list = []
    for t in marked:
        key = _base_key(t)
        prev = best.get(key)
        if prev is None:
            best[key] = t
            order.append(key)
        elif t.is_explicit and not prev.is_explicit:
            best[key] = t

    return [best[k] for k in order]


def _prefer_uncensored(tracks: List[ExternalTrackResponse]) -> List[ExternalTrackResponse]:
    """Нецензурированные версии одного трека — раньше цензурных.

    Схлопывает редакции одной записи (см. _collapse_versions), затем
    стабильной сортировкой отправляет оставшиеся clean-версии в конец
    секции — не вытесняя чужие треки.
    """
    return sorted(_collapse_versions(tracks), key=lambda t: t.is_clean)


def _censored(track: ExternalTrackResponse) -> bool:
    """Явно цензурированная версия — clean-маркер в названии.

    ytmusic-трек без explicit-флага цензурированным не считаем: для трека,
    который вовсе не explicit, флага и не бывает (см. isExplicit в ytdlp.py).
    """
    return bool(track.is_clean)


def _suspect(track: ExternalTrackResponse) -> bool:
    """ytmusic-трек, которому доверять нельзя: clean ИЛИ explicit.

    По опыту YTM отдаёт цензурный звук и под explicit-флагом, поэтому для
    замены «подозрительными» считаем оба вида. SoundCloud не цензурит — его
    копия той же записи всегда предпочтительнее.
    """
    return bool(track.is_explicit or track.is_clean)


def replace_censored(
    tracks: List[ExternalTrackResponse],
    replacements: List[ExternalTrackResponse],
) -> Tuple[List[ExternalTrackResponse], List[ExternalTrackResponse]]:
    """Замещает подозрительные ytmusic-треки той же записью из SoundCloud.

    Общий код выдачи поиска и страницы артиста. Замена на месте: порядок
    выдачи не меняется, трек просто меняет источник (и дальше стримится
    движком SoundCloud). explicit-флаг переносится на замену — бейдж E на
    фронте остаётся. Эквивалента нет — трек остаётся как есть: лучше
    цензурный трек, чем дырка в выдаче.

    Возвращает (замещённый список, невостребованные замены) — вторым зовущий
    дедупит остаток SoundCloud в отдельную секцию/хвост выдачи.
    """
    sc_replacement = {dedup_key(t): t for t in replacements if not t.is_clean}

    def _uncensored(t: ExternalTrackResponse) -> ExternalTrackResponse:
        if not _suspect(t):
            return t
        sc = sc_replacement.get(_base_key(t))
        if sc is None:
            return t
        if t.is_explicit:
            # бейдж E сохраняем — трек остаётся explicit, просто источник
            # теперь нецензурированный
            return sc.model_copy(update={"is_explicit": True})
        return sc

    replaced = [_uncensored(t) for t in tracks]
    shown = {dedup_key(t) for t in replaced}
    return replaced, [t for t in replacements if dedup_key(t) not in shown]


def _base_key(track) -> tuple:
    """Ключ «та же запись» без учёта clean-маркера: «Song» и «Song (Clean)»."""
    stripped = _CLEAN_MARKER.sub("", track.title or "")
    if stripped == (track.title or ""):
        return dedup_key(track)
    # dedup_key читает только .artist/.title — хватает простой подставки,
    # не трогая (возможно, закэшированный) объект провайдера.
    shim = SimpleNamespace(artist=track.artist, title=stripped)
    return dedup_key(shim)


def dedup_key(track) -> tuple:
    """Ключ «тот же трек» — по нормализованным исполнителю и названию.

    Принимает любой объект с .artist/.title: и ExternalTrackResponse из
    провайдеров, и ORM-модель Track (страница артиста склеивает выдачу
    источников с уже сохранённой библиотекой).
    """
    def norm(s: str) -> str:
        s = clean_title(s or "").lower()
        s = re.sub(r"\bfeat\.?\b.*$", "", s)  # убрать "feat. ..."
        s = re.sub(r"[^\w\s]", "", s)          # пунктуация
        s = re.sub(r"\s+", " ", s).strip()
        return s

    return (norm(track.artist), norm(track.title))


def _merge_sources(
    sources: List[List[ExternalTrackResponse]], limit: int
) -> List[ExternalTrackResponse]:
    """Дедуп + честная склейка выдач разных источников.

    Внутри источника порядок релевантности сохраняется, между источниками идём
    round-robin в порядке аргументов: обрезка до limit срезает хвосты у всех
    сразу, а не выкидывает источник целиком.

    Регрессия, ради которой это написано: выдача сортировалась по _SOURCE_RANK
    по возрастанию, то есть soundcloud (ранг 1) шёл первым, а limit==len(выдачи
    одного источника). SoundCloud занимал все слоты, и треков артиста из
    YouTube Music в результатах не оставалось вовсе — «выходят не все треки».
    """
    # Дедуп: при коллизии оставляем источник с более высоким рангом. При равном
    # ранге выигрывает тот, кто встретился раньше (список стоит выше по порядку).
    # Цензура — исключение из правила рангов: нецензурированная версия всегда
    # лучше цензурированной, пусть даже источник «хуже» (SoundCloud вместо YTM).
    sources = [[_mark_clean(t) for t in tracks] for tracks in sources]
    best: dict = {}
    for tracks in sources:
        for t in tracks:
            key = _base_key(t)
            prev = best.get(key)
            if prev is None:
                best[key] = t
                continue
            if (
                _censored(t) and not _censored(prev)
            ):
                continue
            if (
                _censored(prev) and not _censored(t)
            ) or _SOURCE_RANK.get(t.source, 0) > _SOURCE_RANK.get(prev.source, 0):
                best[key] = t

    # Уцелевшие после дедупа, по своим спискам и в исходном порядке.
    queues = [[t for t in tracks if best.get(_base_key(t)) is t] for tracks in sources]

    merged: List[ExternalTrackResponse] = []
    depth = 0
    while len(merged) < limit and any(depth < len(q) for q in queues):
        for q in queues:
            if depth < len(q):
                merged.append(q[depth])
                if len(merged) >= limit:
                    break
        depth += 1
    return merged


def dedup_sequential(
    tracks: List[ExternalTrackResponse],
    limit: int = 0,
    seen: set | None = None,
) -> List[ExternalTrackResponse]:
    """Дедуп с сохранением исходного порядка (без round-robin).

    Нужен там, где источники показываются отдельными блоками и перемешивать их
    нельзя: выдача поиска (сначала YouTube Music, потом SoundCloud) и страница
    артиста. `seen` позволяет вычесть уже показанное — например, треки, которые
    у пользователя и так есть в библиотеке.
    """
    seen = seen if seen is not None else set()
    out: List[ExternalTrackResponse] = []
    for track in tracks:
        key = dedup_key(track)
        if key in seen:
            continue
        seen.add(key)
        out.append(track)
        if limit and len(out) >= limit:
            break
    return out


_TOP_LIMIT = 5

# Каталог артиста — три последовательных вызова YouTube Music (2–5 с холодный),
# самый медленный источник выдачи. Ждём его не дольше, чем остальные два плюс
# небольшой запас (и не меньше минимального окна): опоздавший каталог доходит в
# фоне до кэша, и следующий такой же запрос получает его целиком.
_CATALOG_MIN_WAIT = 1.2
_CATALOG_GRACE = 0.25


def originals_first(tracks: list, q: str) -> list:
    """Оригинальные записи раньше ремиксов, ускорений и каверов.

    Сортировка стабильная: внутри групп порядок провайдера. Запрос, который
    сам просит версию («numb remix», «sped up»), выдачу не переставляет.
    """
    if is_derivative_title(q):
        return list(tracks)
    return sorted(tracks, key=lambda t: is_derivative_title(getattr(t, "title", "")))


def _relevance(track: ExternalTrackResponse, q_norm: str, tokens: List[str]) -> int:
    """Насколько трек совпал с запросом: 3 — точно название или «артист название»,
    2 — все слова запроса есть в артисте/названии, 0 — совпало лишь частично."""
    def norm(s: str) -> str:
        return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", (s or "").lower())).strip()

    title, artist = norm(clean_title(track.title or "")), norm(track.artist)
    if q_norm in (title, f"{artist} {title}", f"{title} {artist}"):
        return 3
    # По целым словам: подстрока дала бы совпадение «q» с «quiet».
    words = set(f"{artist} {title}".split())
    return 2 if all(t in words for t in tokens) else 0


def split_top(
    ytmusic: List[ExternalTrackResponse],
    soundcloud: List[ExternalTrackResponse],
    q: str,
    limit: int = _TOP_LIMIT,
) -> Tuple[List[ExternalTrackResponse], List[ExternalTrackResponse], List[ExternalTrackResponse]]:
    """Выносит самые релевантные треки в отдельный блок над секциями источников.

    Берём только реальные совпадения с запросом (score >= 2), лучшие первыми;
    при равном счёте порядок прежний (YouTube Music раньше SoundCloud, внутри
    источника — как выдал провайдер). Вынесенное из секций убирается, чтобы не
    дублироваться. Возвращает (top, ytmusic, soundcloud).
    """
    q_norm = re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", q.lower())).strip()
    tokens = q_norm.split()
    if not tokens:
        return [], ytmusic, soundcloud

    scored = [
        (_relevance(t, q_norm, tokens), t) for t in [*ytmusic, *soundcloud]
    ]
    want_derivative = is_derivative_title(q)
    best = sorted(
        (item for item in scored if item[0] >= 2),
        key=lambda item: (
            -item[0],
            not want_derivative and is_derivative_title(item[1].title),
        ),
    )[:limit]
    top = [t for _, t in best]
    ids = {id(t) for t in top}
    return (
        top,
        [t for t in ytmusic if id(t) not in ids],
        [t for t in soundcloud if id(t) not in ids],
    )


@router.get("/external", response_model=List[ExternalTrackResponse])
async def search_external(
    request: Request,
    q: str = Query(..., min_length=1),
    limit: int = Query(30, ge=1, le=60),
):
    """Единый поиск по внешним источникам (YouTube Music + SoundCloud).

    Порядок источников в выдаче: каталог артиста (если запрос — это его имя),
    затем обычный поиск YouTube Music, затем SoundCloud. Склейка round-robin,
    см. _merge_sources.

    Soulseek отключён (медленный поллинг slskd подвешивал ответ) — вернуть
    строку в gather, когда понадобится lossless.
    """
    per_source = max(10, limit)

    results = await asyncio.gather(
        ytdlp.ytmusic_artist_catalog(request, q, limit=per_source),
        ytdlp.search_ytmusic(request, q, limit=per_source),
        soundcloud.search_soundcloud(request, q, limit=per_source),
        return_exceptions=True,
    )

    sources: List[List[ExternalTrackResponse]] = []
    for res in results:
        if isinstance(res, Exception):
            logger.warning("external provider failed: %s", res)
            continue
        sources.append(res)

    # Бейдж clean и приоритет нецензурированных версий — см. _prefer_uncensored.
    # Названия оригиналов у треков, зацензуренных по закону РФ (см.
    # app/censorship.py), — до склейки: иначе оригинал из SoundCloud не
    # схлопнулся бы с ними как дубль.
    sources = [
        originals_first(_prefer_uncensored(await censorship.apply_overrides(tracks)), q)
        for tracks in sources
    ]
    return _merge_sources(sources, limit)


async def _await_catalog(task: asyncio.Future, started: float, loop) -> list | Exception:
    """Результат каталога артиста, если он успел к дедлайну (см. _CATALOG_MIN_WAIT).

    Не успел — пустой список, а сама задача доживает в фоне (shield) и кладёт
    результат в кэш внутри ytmusic_artist_catalog.
    """
    timeout = max(_CATALOG_MIN_WAIT - (loop.time() - started), _CATALOG_GRACE)
    try:
        return await asyncio.wait_for(asyncio.shield(task), timeout)
    except asyncio.TimeoutError:
        logger.info("artist catalog late (>%.2fs), answering without it", loop.time() - started)
        # Исключение фоновой задачи некому забрать — гасим, чтобы asyncio не
        # ругался «Task exception was never retrieved».
        task.add_done_callback(lambda t: t.cancelled() or t.exception())
        return []
    except Exception as exc:  # noqa: BLE001 — провайдер, агрегатор падать не должен
        return exc


@router.get("/external/grouped", response_model=ExternalSearchGrouped)
async def search_external_grouped(
    request: Request,
    q: str = Query(..., min_length=1),
    limit: int = Query(30, ge=1, le=60),
):
    """То же, что /external, но выдача каждого источника — отдельным списком.

    Поиск показывает источники разными секциями в фиксированном порядке
    (библиотека → YouTube Music → SoundCloud), поэтому round-robin-склейка
    /external ему только мешает: она перемешивает то, что потом всё равно
    придётся разбирать обратно по source. Дубли между источниками схлопываются
    в пользу YouTube Music; исключение — цензура: явная (clean) или
    подозрительная (explicit — YTM может отдавать цензурный звук и под
    флагом) версия заменяется записью из SoundCloud, см. _uncensored.
    """
    per_source = max(10, limit)

    loop = asyncio.get_running_loop()
    started = loop.time()
    catalog_task = asyncio.ensure_future(
        ytdlp.ytmusic_artist_catalog(request, q, limit=per_source)
    )
    songs, sc = await asyncio.gather(
        ytdlp.search_ytmusic(request, q, limit=per_source),
        soundcloud.search_soundcloud(request, q, limit=per_source),
        return_exceptions=True,
    )
    catalog = await _await_catalog(catalog_task, started, loop)

    def ok(res) -> List[ExternalTrackResponse]:
        if isinstance(res, Exception):
            logger.warning("external provider failed: %s", res)
            return []
        return res

    # Каталог артиста идёт перед обычным поиском: на запрос-имя это его
    # собственная дискография, а search подмешивает чужие треки с этим именем
    # в названии (см. ytmusic_artist_catalog).
    #
    # Цензура: редакции одной записи схлопываем (_collapse_versions), затем
    # «подозрительные» ytmusic-версии заменяем той же записью из SoundCloud.
    # Подозрительные — обе: clean-меченые (явная цензура) и explicit (по опыту
    # YTM отдаёт цензурный звук и под explicit-флагом); SoundCloud не цензурит.
    ytmusic = dedup_sequential(
        _collapse_versions(await censorship.apply_overrides(ok(catalog) + ok(songs))), limit
    )

    # Цензура: см. replace_censored. Замещённые clean-версии уже не clean,
    # поэтому хвостовая сортировка — после замены.
    ytmusic, sc_rest = replace_censored(ytmusic, _collapse_versions(ok(sc)))
    ytmusic = originals_first(sorted(ytmusic, key=lambda t: t.is_clean), q)
    soundcloud_tracks = originals_first(dedup_sequential(sc_rest, limit), q)

    top, ytmusic, soundcloud_tracks = split_top(ytmusic, soundcloud_tracks, q)

    return ExternalSearchGrouped(top=top, ytmusic=ytmusic, soundcloud=soundcloud_tracks)


@router.get("/external/playlists", response_model=List[ExternalPlaylistResponse])
async def search_external_playlists(
    q: str = Query(..., min_length=1),
    limit: int = Query(10, ge=1, le=30),
):
    """Поиск плейлистов во внешних источниках (пока только SoundCloud).

    Главная дёргает этот эндпоинт веером по сидам вкуса на КАЖДЫЙ заход, а
    каждый запрос — это ход через прокси к api-v2 (~1с и платный трафик).
    Выдача от пользователя не зависит и меняется редко: короткий кэш, как у
    /api/search (см. search.py).
    """
    normalized_q = " ".join(q.lower().split())
    cache_key = f"search:external:playlists:{normalized_q}:{limit}"
    cached = await get_cache_async(cache_key)
    if cached is not None:
        return [ExternalPlaylistResponse(**item) for item in cached]
    try:
        playlists = await soundcloud.search_soundcloud_playlists(q, limit)
    except Exception:  # noqa: BLE001
        logger.exception("external playlist search failed")
        return []
    await set_cache_async(
        cache_key,
        [p.model_dump(mode="json") for p in playlists],
        expire=_EXTERNAL_PLAYLISTS_TTL,
    )
    return playlists
