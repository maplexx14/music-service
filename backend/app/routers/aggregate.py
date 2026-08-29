import asyncio
import logging
import re
from types import SimpleNamespace
from typing import List

from fastapi import APIRouter, Query, Request

from app.cache import get_cache, set_cache
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


def _mark_clean(track: ExternalTrackResponse) -> ExternalTrackResponse:
    """Проставляет is_clean по маркерам в названии (для бейджа на фронте).

    Копия, а не мутация: одни и те же объекты приходят из провайдерских кэшей.
    """
    if track.is_clean:
        return track
    if _CLEAN_MARKER.search(track.title or ""):
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


def _base_key(track) -> tuple:
    """Ключ «та же запись» без учёта clean-маркера: «Song» и «Song (Clean)»."""
    stripped = _CLEAN_MARKER.sub("", track.title or "")
    if stripped == (track.title or ""):
        return dedup_key(track)
    # dedup_key читает только .artist/.title — хватает простой подставки,
    # не трогая (возможно, закэшированный) объект провайдера.
    shim = SimpleNamespace(artist=track.artist, title=stripped)
    return dedup_key(shim)


def _seen_keys(tracks: List[ExternalTrackResponse]) -> set:
    """Ключи уже показанных треков — для вычитания секции SoundCloud."""
    return {dedup_key(t) for t in tracks}


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
    sources = [_prefer_uncensored(tracks) for tracks in sources]
    return _merge_sources(sources, limit)


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
    придётся разбирать обратно по source. Дедуп между источниками сохранён —
    при совпадении трека остаётся версия из YouTube Music (см. _SOURCE_RANK).
    """
    per_source = max(10, limit)

    catalog, songs, sc = await asyncio.gather(
        ytdlp.ytmusic_artist_catalog(request, q, limit=per_source),
        ytdlp.search_ytmusic(request, q, limit=per_source),
        soundcloud.search_soundcloud(request, q, limit=per_source),
        return_exceptions=True,
    )

    def ok(res) -> List[ExternalTrackResponse]:
        if isinstance(res, Exception):
            logger.warning("external provider failed: %s", res)
            return []
        return res

    # Каталог артиста идёт перед обычным поиском: на запрос-имя это его
    # собственная дискография, а search подмешивает чужие треки с этим именем
    # в названии (см. ytmusic_artist_catalog).
    #
    # Цензура: редакции одной записи схлопываем (_collapse_versions),
    # цензурную ytmusic-версию заменяем той же записью из SoundCloud —
    # там цензуры нет; оставшиеся без замены clean-версии — в хвост секции.
    ytmusic = dedup_sequential(
        _collapse_versions(ok(catalog) + ok(songs)), limit
    )
    # seen прокинут дальше: дубль, уже показанный в YouTube Music, в секции
    # SoundCloud второй раз не появится.
    soundcloud_tracks = dedup_sequential(
        _collapse_versions(ok(sc)), limit, _seen_keys(ytmusic)
    )

    # Замена на месте: порядок выдачи не меняется, трек просто меняет источник
    # (и дальше стримится движком SoundCloud). Эквивалента нет — оставляем
    # clean-версию с бейджем: лучше цензурный трек, чем дырка в выдаче.
    sc_replacement = {dedup_key(t): t for t in soundcloud_tracks if not t.is_clean}
    ytmusic = [
        sc_replacement.get(_base_key(t), t) if t.is_clean else t
        for t in ytmusic
    ]
    # Незамещённые clean-версии — в хвост (замещённые уже не clean).
    ytmusic = sorted(ytmusic, key=lambda t: t.is_clean)
    # Заменённые записи не должны дублироваться секцией SoundCloud ниже.
    shown = {dedup_key(t) for t in ytmusic}
    soundcloud_tracks = [t for t in soundcloud_tracks if dedup_key(t) not in shown]

    return ExternalSearchGrouped(ytmusic=ytmusic, soundcloud=soundcloud_tracks)


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
    cached = get_cache(cache_key)
    if cached is not None:
        return [ExternalPlaylistResponse(**item) for item in cached]
    try:
        playlists = await soundcloud.search_soundcloud_playlists(q, limit)
    except Exception:  # noqa: BLE001
        logger.exception("external playlist search failed")
        return []
    set_cache(
        cache_key,
        [p.model_dump(mode="json") for p in playlists],
        expire=_EXTERNAL_PLAYLISTS_TTL,
    )
    return playlists
