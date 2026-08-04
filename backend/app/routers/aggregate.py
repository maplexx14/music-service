import asyncio
import logging
import re
from typing import List

from fastapi import APIRouter, Query, Request

from app.routers import soulseek, soundcloud, ytdlp
from app.routers.ytdlp import clean_title
from app.schemas import (
    ExternalPlaylistResponse,
    ExternalSearchGrouped,
    ExternalTrackResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter()

# Приоритет источников при дедупе одинаковых треков.
# В гибриде по умолчанию показываем быстрый ytmusic, но lossless (soulseek)
# считаем «лучше» и оставляем именно его, если нашёлся дубль.
# ВАЖНО: это приоритет качества при склейке дублей, а НЕ порядок выдачи.
# Порядок задаёт только очерёдность списков, переданных в _merge_sources.
_SOURCE_RANK = {"soulseek": 3, "ytmusic": 2, "soundcloud": 1}


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
    best: dict = {}
    for tracks in sources:
        for t in tracks:
            key = dedup_key(t)
            prev = best.get(key)
            if prev is None or _SOURCE_RANK.get(t.source, 0) > _SOURCE_RANK.get(prev.source, 0):
                best[key] = t

    # Уцелевшие после дедупа, по своим спискам и в исходном порядке.
    queues = [[t for t in tracks if best.get(dedup_key(t)) is t] for tracks in sources]

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
    seen: set = set()
    ytmusic = dedup_sequential(ok(catalog) + ok(songs), limit, seen)
    # seen прокинут дальше: дубль, уже показанный в YouTube Music, в секции
    # SoundCloud второй раз не появится.
    soundcloud_tracks = dedup_sequential(ok(sc), limit, seen)

    return ExternalSearchGrouped(ytmusic=ytmusic, soundcloud=soundcloud_tracks)


@router.get("/external/playlists", response_model=List[ExternalPlaylistResponse])
async def search_external_playlists(
    q: str = Query(..., min_length=1),
    limit: int = Query(10, ge=1, le=30),
):
    """Поиск плейлистов во внешних источниках (пока только SoundCloud)."""
    try:
        return await soundcloud.search_soundcloud_playlists(q, limit)
    except Exception:  # noqa: BLE001
        logger.exception("external playlist search failed")
        return []
