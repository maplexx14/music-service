import asyncio
import glob
import logging
import os
import re
import tempfile
import threading
from typing import List, Optional

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from app.cache import get_cache_async, set_cache_async
from app.schemas import ExternalTrackResponse

logger = logging.getLogger(__name__)

router = APIRouter()

# ytmusicapi/yt-dlp — опциональные зависимости. Если их нет, провайдер тихо
# отключается (search вернёт []), чтобы не ронять весь агрегатор.
try:
    from ytmusicapi import YTMusic

    _ytmusic: Optional["YTMusic"] = YTMusic()
except Exception:  # noqa: BLE001 — библиотека может быть не установлена / без сети
    _ytmusic = None
    logger.warning("ytmusicapi недоступен — провайдер YouTube Music отключён")

MEDIA_TYPES = {
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".opus": "audio/ogg",
    ".ogg": "audio/ogg",
    ".webm": "audio/webm",
}

# Мусор в заголовках YouTube, который мешает и показу, и дедупу с Soulseek.
_JUNK = re.compile(
    r"\s*[\(\[]\s*(?:official\s*(?:music\s*)?video|official\s*audio|lyrics?|"
    r"lyric\s*video|audio|visualizer|hd|hq|4k|mv|m/v|remaster(?:ed)?"
    r"(?:\s*\d{4})?)\s*[\)\]]",
    re.IGNORECASE,
)


def clean_title(text: str) -> str:
    """Убирает '(Official Video)', '[Lyrics]' и т.п. из названия."""
    return _JUNK.sub("", text or "").strip(" -–—")


def _upscale_thumb(url: str) -> str:
    """Просит у CDN Google обложку в большем разрешении.

    YouTube Music отдаёт превью с размером, зашитым в URL. Google-CDN ресайзит
    по запросу, поэтому достаточно переписать параметры размера:
      * lh3.googleusercontent.com: '=w544-h544-l90-rj' → '=w1200-h1200-l90-rj'
      * i.ytimg.com/vi/<id>/hqdefault.jpg → '/maxresdefault.jpg'
    """
    if not url:
        return url
    if "googleusercontent.com" in url or "ggpht.com" in url:
        # '=w544-h544-...': поднимаем ширину и высоту до 1200, хвост сохраняем.
        return re.sub(r"=w\d+-h\d+", "=w1200-h1200", url, count=1)
    if "i.ytimg.com" in url or "ytimg.com" in url:
        return re.sub(
            r"/(?:default|mqdefault|hqdefault|sddefault)\.jpg",
            "/maxresdefault.jpg",
            url,
            count=1,
        )
    return url


def _thumb(thumbnails: list) -> Optional[str]:
    if not thumbnails:
        return None
    # ytmusicapi отдаёт список по возрастанию размера — берём самую крупную
    # и просим у CDN версию в большем разрешении.
    return _upscale_thumb(thumbnails[-1].get("url"))


def _duration_seconds(item: dict) -> int:
    secs = item.get("duration_seconds")
    if isinstance(secs, int) and secs > 0:
        return secs
    # Фолбэк: строка "3:45".
    dur = item.get("duration") or ""
    parts = [p for p in dur.split(":") if p.strip().isdigit()]
    total = 0
    for p in parts:
        total = total * 60 + int(p)
    return total


def _normalize(item: dict) -> Optional[ExternalTrackResponse]:
    video_id = item.get("videoId")
    if not video_id:
        return None

    title = clean_title(item.get("title") or "Unknown")
    artists = item.get("artists") or []
    artist = ", ".join(a.get("name", "") for a in artists if a.get("name")).strip()
    if not artist:
        artist = "Unknown Artist"

    album = None
    alb = item.get("album")
    if isinstance(alb, dict):
        album = alb.get("name")

    return ExternalTrackResponse(
        id=f"ytmusic:{video_id}",
        source="ytmusic",
        external_id=video_id,
        title=title,
        artist=artist,
        album=album,
        duration=_duration_seconds(item),
        cover_url=_thumb(item.get("thumbnails")),
        stream_url="",  # заполняется ниже, где доступен Request
        download_url=None,
        download_allowed=False,
    )


async def search_ytmusic(
    request: Request,
    q: str,
    limit: int = 20,
) -> List[ExternalTrackResponse]:
    """Поиск по YouTube Music. Возвращает ExternalTrackResponse (source=ytmusic)."""
    if _ytmusic is None:
        return []

    base_url = str(request.base_url).rstrip("/")
    try:
        # ytmusicapi синхронный — уводим в тредпул, чтобы не блокировать loop.
        raw = await asyncio.to_thread(
            _ytmusic.search, q, filter="songs", limit=limit
        )
    except Exception:  # noqa: BLE001
        logger.exception("YouTube Music search failed")
        return []

    results: List[ExternalTrackResponse] = []
    for item in raw or []:
        track = _normalize(item)
        if not track:
            continue
        track.stream_url = f"{base_url}/api/ytdlp/stream/{track.external_id}"
        results.append(track)
        if len(results) >= limit:
            break
    return results


@router.get("/search", response_model=List[ExternalTrackResponse])
async def search_endpoint(
    request: Request,
    q: str = Query(..., min_length=1),
    limit: int = Query(20, ge=1, le=50),
):
    return await search_ytmusic(request, q, limit)


def _pick_audio_format(info: dict) -> Optional[dict]:
    """Выбирает лучший аудио-only формат из info['formats'] вручную.

    Надёжнее строки 'bestaudio' — не падает с 'Requested format is not
    available', когда набор форматов у ролика нестандартный.
    """
    formats = info.get("formats") or []
    audio_only = [
        f
        for f in formats
        if f.get("acodec") not in (None, "none")
        and f.get("vcodec") in (None, "none")
        and f.get("url")
    ]
    if not audio_only:
        # Фолбэк: любой формат с аудио-дорожкой и прямым URL.
        audio_only = [
            f
            for f in formats
            if f.get("acodec") not in (None, "none") and f.get("url")
        ]
    if not audio_only:
        return None
    # Больше abr (аудио-битрейт) → лучше; при равенстве предпочитаем m4a.
    audio_only.sort(
        key=lambda f: (f.get("abr") or 0, 1 if f.get("ext") == "m4a" else 0),
        reverse=True,
    )
    return audio_only[0]


# Наборы player-клиентов, которыми по очереди прикидываемся при резолве.
# "Video unavailable" часто зависит от клиента: то, что недоступно для web,
# нередко отдаётся tv/android_music/ios и наоборот. Перебираем, пока не выйдет.
#
# Primary — единственный лёгкий клиент (android_music): он не требует
# JS-расшифровки n-sig/cipher параметра googlevideo-ссылок (в отличие от web),
# поэтому обычно отвечает заметно быстрее. Остальные наборы (в т.ч. web)
# остаются fallback'ом и подключаются через хедж, если primary не ответил
# вовремя или отдал "unavailable".
_CLIENT_CANDIDATES = (
    ["android_music"],
    ["ios", "android", "web"],
    ["tv", "web_safari"],
    ["mweb", "android"],
)


# Каждую попытку резолва ограничиваем по времени: без таймаута зависшее
# соединение с YouTube тянет extract_info очень долго (жалобы «грузится вечно»).
# Попытки хеджированы (см. _resolve_audio), а не все параллельно с самого
# начала, так что 8с — с запасом для здорового ролика, а зависший клиент не
# держит резолв так долго, как раньше при последовательном переборе.
_SOCKET_TIMEOUT = 8

# Хедж-задержка: первым стартует самый надёжный набор клиентов; остальные
# подключаются параллельно, только если он не ответил за это время. Экономит
# нагрузку на YouTube в общем случае (обычно первый клиент и так отвечает),
# но не жертвует задержкой, если он подвис. Primary теперь лёгкий одиночный
# клиент (см. _CLIENT_CANDIDATES) и обычно отвечает быстро, поэтому задержку
# можно держать короче — подвисший primary не тянет резолв дольше 0.6с до
# подключения fallback-наборов.
_HEDGE_DELAY = 0.6


class TrackUnavailable(Exception):
    """Видео недоступно (удалено/приватно/регион) — резолв невозможен."""


class TransientResolveError(Exception):
    """Временный сбой резолва (таймаут/429/сеть) — стоит повторить позже."""


# Invidious-инстанс (self-hosted, с companion-сервисом для PO-token) отдаёт
# уже готовый прямой URL аудио-потока без локального n-sig/cipher-расчёта —
# резолв через него на порядок быстрее yt-dlp. Используется как основной путь
# резолва (см. _resolve_audio), yt-dlp остаётся фолбэком на случай
# недоступности/пустого ответа инстанса.
_INVIDIOUS_ENABLED = os.getenv("INVIDIOUS_ENABLED", "0") == "1"
_INVIDIOUS_API_BASES = [
    b.strip().rstrip("/") for b in os.getenv("INVIDIOUS_API_BASE", "").split(",") if b.strip()
]
_INVIDIOUS_TIMEOUT = float(os.getenv("INVIDIOUS_TIMEOUT", "10"))


async def _resolve_via_invidious(video_id: str) -> tuple[str, str, Optional[int]]:
    """Резолвит прямой URL аудио через Invidious API (/api/v1/videos/{id}).

    Пробует настроенные инстансы по очереди (первый удачный ответ побеждает).
    Кидает TrackUnavailable, если инстанс явно сообщил о недоступности видео
    (404) или явной ошибкой в теле ответа, и TransientResolveError на любую
    другую проблему (сеть/таймаут/5xx/пустой список аудио-форматов) —
    вызывающий код (см. _resolve_audio) в этом случае падает обратно на
    yt-dlp, а не считает трек мёртвым.
    """
    if not _INVIDIOUS_API_BASES:
        raise TransientResolveError(video_id)

    last_exc: Optional[Exception] = None
    async with httpx.AsyncClient(timeout=_INVIDIOUS_TIMEOUT) as client:
        for base in _INVIDIOUS_API_BASES:
            try:
                resp = await client.get(f"{base}/api/v1/videos/{video_id}")
            except httpx.HTTPError as exc:
                last_exc = exc
                continue
            if resp.status_code == 404:
                raise TrackUnavailable(video_id)
            if resp.is_error:
                last_exc = RuntimeError(f"invidious {base} returned {resp.status_code}")
                continue
            try:
                data = resp.json()
            except ValueError as exc:
                last_exc = exc
                continue
            if data.get("error"):
                # Инстанс жив, но явно сообщил о проблеме с видео (обычно
                # companion недоступен или PO-token не провалидировался) —
                # это сбой инстанса, а не факт недоступности ролика.
                last_exc = RuntimeError(f"invidious error: {data['error']}")
                continue
            formats = data.get("adaptiveFormats") or []
            streams = [
                f for f in formats
                if f.get("url") and str(f.get("type", "")).startswith("audio")
            ]
            if not streams:
                last_exc = RuntimeError("invidious: no audio formats")
                continue
            streams.sort(key=lambda f: int(f.get("bitrate") or 0), reverse=True)
            best = streams[0]
            mime = str(best.get("type", "")).lower()
            ext = ".m4a"
            if "webm" in mime or "opus" in mime:
                ext = ".opus" if "opus" in mime else ".webm"
            elif "mp4" in mime or "m4a" in mime or "aac" in mime:
                ext = ".m4a"
            total = best.get("clen")
            total = int(total) if isinstance(total, (int, float, str)) and str(total).isdigit() else None
            return best["url"], ext, total

    raise TransientResolveError(video_id) from last_exc


# Маркеры в тексте ошибки yt-dlp, означающие ИМЕННО недоступность ролика, а не
# временный сбой. Всё остальное (таймауты, 429, обрывы сети) считаем временным.
_UNAVAILABLE_MARKERS = (
    "video unavailable",
    "private video",
    "who has blocked it",
    "removed",
    "no longer available",
    "not available in your",
    "sign in to confirm",
    "content isn't available",
    "account associated with this video has been terminated",
)


def _is_unavailable_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    return any(m in msg for m in _UNAVAILABLE_MARKERS)


# Создание YoutubeDL — это не только выделение объекта: конструктор грузит
# реестр экстракторов и плагинов, и это ощутимая накладная трата на каждый
# резолв. asyncio.to_thread гоняет задачи через пул потоков-воркеров, которые
# переживают между вызовами, так что кэшируем инстанс per-thread по ключу
# опций. Используется и SoundCloud-роутером (см. soundcloud._resolve_blocking).
_thread_local = threading.local()


def cached_ydl(cache_key, opts: dict):
    """YoutubeDL с переиспользованием инстанса в рамках текущего потока.

    ``cache_key`` — hashable-ключ (например, tuple клиентов или строка) для
    различения наборов опций внутри одного потока.
    """
    import yt_dlp

    cache = getattr(_thread_local, "ydl_cache", None)
    if cache is None:
        cache = {}
        _thread_local.ydl_cache = cache
    ydl = cache.get(cache_key)
    if ydl is None:
        ydl = yt_dlp.YoutubeDL(opts)
        cache[cache_key] = ydl
    return ydl


def _warmup_ydl_blocking() -> None:
    """Прогревает yt-dlp для primary-набора клиентов.

    Основная цена здесь — process-wide: импорт модуля ``yt_dlp`` и загрузка
    реестра экстракторов/плагинов (~0.5-0.7с суммарно), это происходит один
    раз на процесс независимо от потока. Без прогрева эту цену при cold-start
    платит самый первый резолв, что ощущается как «первый трек всегда долго
    грузится». cached_ydl дополнительно кладёт готовый YoutubeDL-инстанс в
    per-thread кэш текущего потока — это уже локальный бонус, если тот же
    поток threadpool-воркера подхватит следующий запрос.
    Вызывается один раз при старте приложения (см. app.main), в отдельном
    потоке, чтобы не блокировать остальной startup.
    """
    try:
        primary = _CLIENT_CANDIDATES[0]
        cached_ydl(
            tuple(primary),
            {
                "quiet": True,
                "no_warnings": True,
                "noplaylist": True,
                "skip_download": True,
                "socket_timeout": _SOCKET_TIMEOUT,
                "format": "bestaudio/best",
                "ignore_no_formats_error": True,
                "extractor_args": {"youtube": {"player_client": primary}},
            },
        )
        logger.info("yt-dlp extractor warmed up")
    except Exception:  # noqa: BLE001 — прогрев best-effort, не должен ронять старт
        logger.warning("yt-dlp warmup failed", exc_info=True)


def _extract_with_clients(video_id: str, clients: List[str]) -> tuple[Optional[dict], bool]:
    """Одна попытка резолва набором клиентов.

    Возвращает ``(info, transient)``: ``info`` — результат или None; ``transient``
    True, если неудача выглядит временной (таймаут/сеть/429), а не «видео
    недоступно». Классификация нужна, чтобы не помечать валидный трек надолго
    недоступным из-за случайного сбоя.
    """
    import yt_dlp

    url = f"https://music.youtube.com/watch?v={video_id}"
    ydl = cached_ydl(
        tuple(clients),
        {
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "skip_download": True,
            "socket_timeout": _SOCKET_TIMEOUT,
            # Без этого yt-dlp применяет дефолтный селектор
            # 'bestvideo*+bestaudio/best' и падает с "Requested format is not
            # available" на роликах без муксированного progressive-формата —
            # ДО того, как _pick_audio_format успевает выбрать формат вручную.
            # 'bestaudio/best' всегда матчится (audio-only поток есть почти
            # всегда), а конкретный URL всё равно выбирает _pick_audio_format
            # из info['formats'].
            "format": "bestaudio/best",
            # Подстраховка к предыдущему: на некоторых клиентах (PO-token и
            # т.п.) даже 'bestaudio/best' не матчится, и extract_info кидает
            # "Requested format is not available", хотя другой клиент отдал бы
            # формат. С этим флагом yt-dlp не кидает ошибку селектора вовсе —
            # возвращает info как есть, а непригодность форматов решает
            # _pick_audio_format (нет — просто пробуем следующий клиент).
            "ignore_no_formats_error": True,
            "extractor_args": {"youtube": {"player_client": clients}},
        },
    )
    try:
        return ydl.extract_info(url, download=False), False
    except yt_dlp.utils.DownloadError as exc:
        transient = not _is_unavailable_error(exc)
        logger.info(
            "resolve via %s failed for %s (%s): %s",
            clients, video_id, "transient" if transient else "unavailable", exc,
        )
        return None, transient


async def _resolve_audio(video_id: str) -> tuple[str, str, Optional[int]]:
    """Резолвит прямой URL аудио: сперва пробует быстрый Invidious, при
    неудаче — yt-dlp (см. _resolve_via_ytdlp).

    Invidious (с companion, который сам добывает и валидирует PO-token) не
    требует локального n-sig/cipher-расчёта и обычно отвечает быстрее yt-dlp,
    поэтому используется как основной путь. Если Invidious выключен (нет
    INVIDIOUS_API_BASE), недоступен или отдал временную ошибку — молча падаем
    обратно на yt-dlp. Настоящую недоступность видео (TrackUnavailable)
    Invidious определяет так же надёжно, как yt-dlp (404 от самого YouTube),
    поэтому в этом случае fallback не нужен — сразу отдаём его наружу.
    """
    if _INVIDIOUS_ENABLED:
        try:
            return await _resolve_via_invidious(video_id)
        except TrackUnavailable:
            raise
        except Exception:  # noqa: BLE001 — любой сбой Invidious: тихо уходим в yt-dlp
            logger.info("invidious resolve failed for %s, falling back to yt-dlp", video_id)
    return await _resolve_via_ytdlp(video_id)


async def _resolve_via_ytdlp(video_id: str) -> tuple[str, str, Optional[int]]:
    """Через yt-dlp достаёт прямой URL аудио, расширение и размер.

    Хеджирование вместо постоянного запуска всех наборов клиентов разом:
    сперва пробуем только первый (самый надёжный по опыту) набор; если он не
    ответил за _HEDGE_DELAY секунд, параллельно подключаем остальные. Типичный
    случай (первый клиент и так отвечает) не создаёт лишней нагрузки на
    YouTube, а подвисший/медленный клиент не блокирует резолв дольше
    хедж-задержки — итоговая задержка ограничена сверху примерно
    _HEDGE_DELAY + _SOCKET_TIMEOUT, а не суммой по всем клиентам.
    Кидает TrackUnavailable, если все клиенты сообщили о недоступности, или
    TransientResolveError при временном сбое (его негативно кэшируем
    ненадолго, чтобы дать треку восстановиться).
    """
    primary, *rest = _CLIENT_CANDIDATES
    pending = {asyncio.create_task(asyncio.to_thread(_extract_with_clients, video_id, primary))}
    hedged = False
    info = None
    saw_transient = False
    try:
        while pending:
            done, pending = await asyncio.wait(
                pending,
                timeout=None if hedged else _HEDGE_DELAY,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if not done:
                # Хедж: первый набор не успел за _HEDGE_DELAY — подключаем остальных.
                hedged = True
                pending |= {
                    asyncio.create_task(asyncio.to_thread(_extract_with_clients, video_id, clients))
                    for clients in rest
                }
                continue
            success = False
            for t in done:
                result_info, transient = t.result()
                if result_info and _pick_audio_format(result_info):
                    info = result_info
                    success = True
                    break
                if result_info:
                    # Клиент ответил, но пригодного формата нет (обычно
                    # PO-token: URL-ы форматов отсутствуют) — это проблема
                    # конкретного клиента, а не ролика. Считаем временной,
                    # иначе трек попал бы в негативный кэш «недоступен» на
                    # 10 минут и «не грузился вообще».
                    transient = True
                saw_transient = saw_transient or transient
            if success:
                break
            if not hedged:
                # Primary набор отработал (не подвис), но не дал результата —
                # без этого фолбэки не подключились бы вовсе, т.к. эскалация
                # выше срабатывает только по таймауту ожидания, а не по
                # быстрому провалу (например, "Requested format is not
                # available" из-за PO-token требований на некоторых клиентах).
                hedged = True
                pending |= {
                    asyncio.create_task(asyncio.to_thread(_extract_with_clients, video_id, clients))
                    for clients in rest
                }
    finally:
        for t in pending:
            if not t.done():
                t.cancel()

    if info is None:
        if saw_transient:
            raise TransientResolveError(video_id)
        raise TrackUnavailable(video_id)

    fmt = _pick_audio_format(info)
    if not fmt:
        raise RuntimeError("нет доступного аудио-формата")
    ext = "." + (fmt.get("ext") or "m4a").lower()
    # Только ТОЧНЫЙ filesize годится для Content-Length; filesize_approx может
    # расходиться с реальным размером и ломает ответ ("content shorter than
    # Content-Length"). Если точного нет — вернём None и определим размер
    # пробным range-запросом к googlevideo (там размер точный).
    size = fmt.get("filesize")
    total = int(size) if isinstance(size, (int, float)) and size > 0 else None
    return fmt["url"], ext, total


# googlevideo-ссылки живут несколько часов; кэшируем результат резолва в Redis,
# чтобы не гонять медленный yt-dlp при перемотке, повторе и ретраях. TTL с
# запасом меньше реального срока жизни ссылки.
_RESOLVE_TTL = 3 * 3600
# Негативный кэш ГЕНУИННО недоступных видео (удалено/приватно): не гоняем
# yt-dlp на каждый ретрай браузера. Короткий TTL — вдруг видео вернётся.
_UNAVAILABLE_TTL = 600
# Негативный кэш ВРЕМЕННЫХ сбоев (таймаут/429/сеть): короткий, чтобы, с одной
# стороны, не долбить YouTube на каждый ретрай, а с другой — быстро дать
# валидному треку восстановиться (иначе он «не играет» до 10 минут).
_TRANSIENT_TTL = 25


# Однополётность резолва: с прогревом (prefetch текущего/следующих треков во
# flow) стало обычным делом, что несколько вызовов (прогрев + сам <audio>-GET,
# либо несколько прогревов подряд) метят в один и тот же video_id почти
# одновременно. Без дедупликации это означало бы несколько параллельных
# yt-dlp extract_info на одно и то же видео — лишняя нагрузка на YouTube и
# трата воркеров. Держим по одной in-flight задаче на video_id: все опоздавшие
# вызовы просто дожидаются результата первой.
_inflight_resolves: dict[str, asyncio.Task] = {}


async def _resolve_cached(
    video_id: str, force: bool = False
) -> tuple[str, str, Optional[int], bool]:
    """Резолв прямого URL с кэшем в Redis.

    force=True — игнорирует кэш и резолвит заново (протухшая ссылка).
    Кидает TrackUnavailable при ГЕНУИННОЙ недоступности видео (удалено/
    приватно/регион) и TransientResolveError при временном сбое (таймаут/
    сеть/429). Раньше оба случая наружу выглядели одинаково («недоступен»),
    и клиент не мог отличить «трек мёртв» от «сервер не успел» — это било по
    UX (см. stream_cached_audio: TransientResolveError теперь отдаётся как
    503 Retry-After, а не 404, и фронт не должен скипать трек на 503).
    Четвёртый элемент — ``fresh``: True, если URL только что получен от
    yt-dlp (валиден заведомо), False — если отдан из Redis-кэша (в теории
    мог протухнуть). Позволяет вызывающему коду пропустить лишний probe-запрос
    для заведомо свежей ссылки и не терять на нём время при холодном старте.
    """
    key = f"ytdlp:resolve:v2:{video_id}"
    cached = None if force else await get_cache_async(key)
    if cached:
        if cached.get("transient"):
            raise TransientResolveError(video_id)
        if cached.get("unavailable"):
            raise TrackUnavailable(video_id)
        if cached.get("url"):
            return cached["url"], cached.get("ext", ".m4a"), cached.get("total"), False

    # Однополётность: если резолв этого video_id уже идёт (например, прогрев
    # прогремел на долю секунды раньше настоящего запроса на стрим) — просто
    # дожидаемся его вместо запуска второго extract_info.
    existing = _inflight_resolves.get(video_id)
    if existing is not None:
        return await existing

    task = asyncio.ensure_future(_resolve_and_cache(video_id, key))
    _inflight_resolves[video_id] = task
    try:
        return await task
    finally:
        if _inflight_resolves.get(video_id) is task:
            del _inflight_resolves[video_id]


async def _resolve_and_cache(
    video_id: str, key: str
) -> tuple[str, str, Optional[int], bool]:
    try:
        url, ext, total = await _resolve_audio(video_id)
    except TransientResolveError:
        # Временный сбой — короткий негативный кэш отдельным маркером, чтобы
        # скорый повтор от того же клиента не долбил yt-dlp, но чтобы вызывающий
        # код (и в итоге HTTP-статус) не путал это с «трек реально недоступен».
        await set_cache_async(key, {"transient": True}, expire=_TRANSIENT_TTL)
        raise
    except Exception as exc:  # noqa: BLE001 — TrackUnavailable и прочее
        await set_cache_async(key, {"unavailable": True}, expire=_UNAVAILABLE_TTL)
        raise TrackUnavailable(video_id) from exc

    await set_cache_async(key, {"url": url, "ext": ext, "total": total}, expire=_RESOLVE_TTL)
    return url, ext, total, True


# Размер сегмента при проксировании googlevideo. Длинный одиночный GET
# googlevideo часто троттлит и обрывает (RemoteProtocolError), поэтому тянем
# файл короткими range-запросами — каждый успевает завершиться целиком.
_SEGMENT = 1 << 20  # 1 MiB
_SEGMENT_RETRIES = 3
# Буфер чтения при отдаче кэш-файла с диска. Крупнее 64 KiB — меньше переходов
# в threadpool на каждый чанк при множестве одновременных стримов.
_FILE_CHUNK = 256 * 1024

# Дисковый кэш проигранных треков: раз скачав аудио с googlevideo, храним его
# локально и при повторном прослушивании отдаём с диска — без обращения к
# YouTube и повторного скачивания.
CACHE_DIR = os.getenv(
    "YTDLP_CACHE_DIR",
    os.path.join(os.path.dirname(__file__), "..", "..", "ytdlp_cache"),
)
CACHE_MAX_BYTES = int(os.getenv("YTDLP_CACHE_MAX_MB", "4096")) * 1024 * 1024
os.makedirs(CACHE_DIR, exist_ok=True)


def _cached_file(video_id: str) -> Optional[str]:
    """Путь к готовому кэш-файлу трека (любое расширение) или None."""
    for path in glob.glob(os.path.join(CACHE_DIR, f"{video_id}.*")):
        if (
            not path.endswith(".part")
            and not path.endswith(".warm")
            and os.path.getsize(path) > 0
        ):
            return path
    return None


def _warm_file(cache_id: str, ext: str) -> str:
    """Путь к warm-файлу (первые байты трека, скачанные при префетче)."""
    return os.path.join(CACHE_DIR, f"{cache_id}{ext}.warm")


# Сколько первых байт трека скачиваем при префетче. 2 MiB — хватает на
# ~1 минуту звука при 256kbps: старт воспроизведения идёт целиком с диска,
# пока живой proxy догоняет хвост.
_WARM_BYTES = 2 * 1024 * 1024

# Ограничитель конкуренции резолва ТОЛЬКО для фоновых прогревов: фронт может
# прогреть сразу несколько треков очереди, и без лимита это означало бы залп
# параллельных yt-dlp extract_info в сторону YouTube (риск 429). Реальные
# /stream-запросы семафор не проходят — воспроизведение не троттлится.
_PREFETCH_SEM = asyncio.Semaphore(2)
# Скачивание первых байт — просто GET к CDN, узкое место не оно: параллелизм
# можно держать заметно выше, чем у yt-dlp-резолвов.
_WARM_SEM = asyncio.Semaphore(8)

# Фоновая очередь прогрева: эндпоинт /prefetch отвечает сразу, работа идёт в
# asyncio-задаче. Прогрев — best-effort, поэтому при переполнении очереди
# новые заявки молча отбрасываются (играть трек это не мешает, а «протухший»
# прогрев, доехавший через минуты, всё равно бесполезен). _prefetch_pending
# заодно дедуплицирует заявки на один и тот же трек. Сильные ссылки на задачи
# держим в _prefetch_tasks, иначе asyncio может собрать их до завершения.
_PREFETCH_QUEUE_LIMIT = 64
_prefetch_pending: set[str] = set()
_prefetch_tasks: set[asyncio.Task] = set()


async def _prefetch_job(cache_id: str, resolver, cache_key: str, ttl: int) -> None:
    try:
        async with _PREFETCH_SEM:
            url, ext, total, _ = await resolver(False)
        async with _WARM_SEM:
            warmed_total = await _warm_first_chunk(cache_id, url, ext)
        if warmed_total is not None and total is None:
            # Content-Range warm-запроса дал точный размер — дописываем его в
            # кэш резолва, чтобы стрим мог пропустить probe (см. движок).
            await set_cache_async(
                cache_key, {"url": url, "ext": ext, "total": warmed_total}, expire=ttl
            )
    except (TrackUnavailable, TransientResolveError):
        pass  # негативный результат уже закэширован резолвером
    except Exception:  # noqa: BLE001 — прогрев не должен шуметь стектрейсами
        logger.warning("prefetch job failed for %s", cache_id, exc_info=True)
    finally:
        _prefetch_pending.discard(cache_id)


def schedule_prefetch(cache_id: str, resolver, cache_key: str, ttl: int) -> str:
    """Ставит прогрев трека в фоновую очередь; возвращает статус для ответа.

    Не ждёт ни резолва, ни скачивания — вызывающий эндпоинт отвечает мгновенно
    и не держит HTTP-соединение открытым, пока очередь прогрева занята.
    """
    if _cached_file(cache_id):
        return "cached"
    if cache_id in _prefetch_pending:
        return "queued"
    if len(_prefetch_pending) >= _PREFETCH_QUEUE_LIMIT:
        return "dropped"
    _prefetch_pending.add(cache_id)
    task = asyncio.create_task(_prefetch_job(cache_id, resolver, cache_key, ttl))
    _prefetch_tasks.add(task)
    task.add_done_callback(_prefetch_tasks.discard)
    return "queued"


async def _warm_first_chunk(cache_id: str, url: str, ext: str) -> Optional[int]:
    """Скачивает первые _WARM_BYTES трека в кэш-файл ``{cache_id}{ext}.warm``.

    Вызывается из префетча best-effort: тогда первый play отдаёт начало трека
    мгновенно с диска (и без валидирующего probe — URL проверен здесь), а
    живой proxy подхватывает с позиции warm-файла. Возвращает полный размер
    файла из Content-Range (авторитетный, годится для Content-Length) или
    None, если прогрев не удался/не нужен.
    """
    warm_path = _warm_file(cache_id, ext)
    if os.path.exists(warm_path) or _cached_file(cache_id):
        return None
    total: Optional[int] = None
    fd, tmp_path = tempfile.mkstemp(dir=CACHE_DIR, suffix=".part")
    ok = False
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0, read=30.0)) as client:
            async with client.stream(
                "GET", url, headers={"Range": f"bytes=0-{_WARM_BYTES - 1}"}
            ) as resp:
                # Только 206: сервер, игнорирующий Range (200), отдал бы весь
                # файл — не хотим качать его целиком на префетче.
                if resp.status_code != 206:
                    logger.info(
                        "first-chunk warm skipped for %s: upstream %s",
                        cache_id, resp.status_code,
                    )
                    return None
                cr = resp.headers.get("content-range")
                if cr and "/" in cr:
                    tail = cr.rsplit("/", 1)[-1].strip()
                    if tail.isdigit():
                        total = int(tail)
                with os.fdopen(fd, "wb") as fh:
                    fd = None
                    async for chunk in resp.aiter_bytes(65536):
                        fh.write(chunk)
        os.replace(tmp_path, warm_path)
        ok = True
        _enforce_cache_limit()
        return total
    except (httpx.HTTPError, OSError) as exc:
        logger.info("first-chunk warm failed for %s: %s", cache_id, exc)
        return None
    finally:
        if fd is not None:
            os.close(fd)
        if not ok and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


def _enforce_cache_limit() -> None:
    """Простейший LRU по mtime: чистим самые старые файлы при переполнении."""
    try:
        files = [
            (p, os.path.getsize(p), os.path.getmtime(p))
            for p in glob.glob(os.path.join(CACHE_DIR, "*"))
            if not p.endswith(".part")
        ]
    except OSError:
        return
    total = sum(size for _, size, _ in files)
    if total <= CACHE_MAX_BYTES:
        return
    for path, size, _ in sorted(files, key=lambda f: f[2]):  # старые первыми
        try:
            os.remove(path)
        except OSError:
            continue
        total -= size
        if total <= CACHE_MAX_BYTES:
            break


def _serve_file(path: str, media_type: str, request: Request) -> StreamingResponse:
    """Отдаёт локальный файл с поддержкой Range (перемотка/докачка)."""
    size = os.path.getsize(path)
    has_range = bool(request.headers.get("range"))
    start, end = _parse_range(request.headers.get("range"), size)
    if end is None:
        end = size - 1
    end = min(end, size - 1)

    def gen():
        with open(path, "rb") as fh:
            fh.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = fh.read(min(_FILE_CHUNK, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    headers = {
        "Accept-Ranges": "bytes",
        # Кэш-файл неизменен для данного video_id — разрешаем браузеру кэшировать
        # (повторное прослушивание не бьёт по бэку вовсе).
        "Cache-Control": "public, max-age=86400",
        "Content-Length": str(end - start + 1),
    }
    status_code = 200
    if has_range:
        status_code = 206
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    return StreamingResponse(
        gen(), status_code=status_code, media_type=media_type, headers=headers
    )


def _parse_range(header: Optional[str], total: Optional[int]) -> tuple[int, Optional[int]]:
    """Парсит 'bytes=start-end' → (start, end|None). end включительный."""
    if not header:
        return 0, None
    m = re.fullmatch(r"bytes=(\d*)-(\d*)", header.strip())
    if not m:
        return 0, None
    start_s, end_s = m.group(1), m.group(2)
    if start_s == "":
        # suffix range: последние N байт
        if end_s == "" or total is None:
            return 0, None
        n = int(end_s)
        return max(0, total - n), total - 1
    start = int(start_s)
    end = int(end_s) if end_s else None
    return start, end


async def _probe(client: httpx.AsyncClient, url: str) -> tuple[int, Optional[int]]:
    """Пробный range-запрос: (http-статус, полный размер файла или None).

    Заодно валидирует ссылку: googlevideo-URL живут ограниченно и могут быть
    привязаны к IP — протухшая ссылка отвечает 403 ещё ДО начала стрима.
    """
    try:
        resp = await client.get(url, headers={"Range": "bytes=0-0"})
    except httpx.HTTPError:
        return 599, None
    cr = resp.headers.get("content-range")  # 'bytes 0-0/12345'
    total = None
    if cr and "/" in cr:
        tail = cr.rsplit("/", 1)[-1].strip()
        if tail.isdigit():
            total = int(tail)
    return resp.status_code, total


async def stream_cached_audio(request: Request, cache_id: str, resolver):
    """Отдаёт аудио по прямому URL с диск-кэшем, probe и ресегментацией.

    Общий движок стрима для всех yt-dlp-провайдеров (YouTube Music, SoundCloud).
    Специфика источника вынесена в ``resolver`` — awaitable ``resolver(force)``,
    возвращающий ``(direct_url, ext, total, fresh)``. Кидает ``TrackUnavailable``
    при генуинной недоступности (→ 404) и ``TransientResolveError`` при
    временном сбое резолва (→ 503 Retry-After — НЕ 404). Различие важно для
    фронта: 404 значит «трек мёртв, скипай», 503 — «попробуй ещё раз», и
    смешивать их приводило к тому, что обычный таймаут yt-dlp выглядел как
    недоступный трек и трек автоматически пропускался. ``fresh`` — True, если
    URL только что получен от yt-dlp (пропускаем валидирующий probe), False —
    если отдан из кэша. ``cache_id`` — безопасное для файловой системы имя
    (используется как имя кэш-файла и должно быть уникальным между источниками).
    """
    # Уже качали этот трек — отдаём с диска, минуя yt-dlp и CDN источника.
    cached = _cached_file(cache_id)
    if cached:
        ext = os.path.splitext(cached)[1].lower()
        return _serve_file(cached, MEDIA_TYPES.get(ext, "audio/mp4"), request)

    try:
        direct_url, ext, total, fresh = await resolver(False)
    except TrackUnavailable:
        # Трек недоступен (удалён/приватен/регион) — это не сбой сервера.
        logger.info("track unavailable: %s", cache_id)
        raise HTTPException(status_code=404, detail="Трек недоступен")
    except TransientResolveError:
        # Временный сбой (таймаут/сеть/429) — сервер жив, стоит повторить
        # скоро. 503, а не 404: фронт не должен считать трек мёртвым.
        logger.info("transient resolve failure: %s", cache_id)
        raise HTTPException(
            status_code=503,
            detail="Временная ошибка получения аудио, повторите",
            headers={"Retry-After": str(_TRANSIENT_TTL)},
        )
    except Exception:  # noqa: BLE001
        logger.exception("yt-dlp resolve failed: %s", cache_id)
        raise HTTPException(status_code=502, detail="Не удалось получить аудио")

    media_type = MEDIA_TYPES.get(ext, "audio/mp4")

    client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=60.0))
    # Content-Length должен ТОЧНО совпадать с тем, что реально отдаст эта
    # googlevideo-ссылка, иначе Starlette падает с "content shorter than
    # Content-Length". Авторитетный размер — из content-range самого googlevideo
    # (probe), а filesize из yt-dlp может расходиться. Probe заодно валидирует
    # ссылку: кэшированный URL мог протухнуть (403) — тогда резолвим заново
    # и пробуем ещё раз, ДО отправки заголовков клиенту.
    #
    # Если URL только что получен от yt-dlp (fresh=True), он заведомо рабочий —
    # probe для него лишний RTT на холодном старте, пропускаем при известном
    # точном размере. То же для прогретого трека: warm-файл скачан по этому же
    # URL при префетче (URL уже проверен), а первые байты отдаём с диска —
    # probe нужен только для непрогретого URL из Redis-кэша.
    def _warm_size(path: str) -> int:
        try:
            return os.path.getsize(path)
        except OSError:
            return 0

    warm_path = _warm_file(cache_id, ext)
    early_start, _ = _parse_range(request.headers.get("range"), None)
    warm_size = _warm_size(warm_path) if early_start == 0 else 0
    if (fresh or warm_size > 0) and total is not None:
        status, probed = 200, None
    else:
        status, probed = await _probe(client, direct_url)
    if status >= 400:
        logger.info("stale direct url for %s (probe %s), re-resolving", cache_id, status)
        try:
            direct_url, ext, total, _ = await resolver(True)
        except TrackUnavailable:
            await client.aclose()
            raise HTTPException(status_code=404, detail="Трек недоступен")
        except TransientResolveError:
            await client.aclose()
            logger.info("transient re-resolve failure: %s", cache_id)
            raise HTTPException(
                status_code=503,
                detail="Временная ошибка получения аудио, повторите",
                headers={"Retry-After": str(_TRANSIENT_TTL)},
            )
        except Exception:  # noqa: BLE001
            await client.aclose()
            logger.exception("re-resolve failed: %s", cache_id)
            raise HTTPException(status_code=502, detail="Не удалось получить аудио")
        media_type = MEDIA_TYPES.get(ext, "audio/mp4")
        # После пере-резолва расширение (и warm-путь) могли смениться.
        warm_path = _warm_file(cache_id, ext)
        warm_size = _warm_size(warm_path) if early_start == 0 else 0
        if total is not None:
            status, probed = 200, None
        else:
            status, probed = await _probe(client, direct_url)
        if status >= 400:
            await client.aclose()
            logger.warning("fresh url also dead for %s (probe %s)", cache_id, status)
            raise HTTPException(status_code=502, detail="Источник аудио недоступен")
    if probed is not None:
        total = probed

    req_start, req_end = _parse_range(request.headers.get("range"), total)
    if total is not None and req_end is None:
        req_end = total - 1

    # Кэшируем только когда клиент тянет файл целиком (start=0..total-1) —
    # тогда по завершении получаем полную копию, пригодную для повторной отдачи.
    cache_final = os.path.join(CACHE_DIR, f"{cache_id}{ext}")
    want_cache = (
        total is not None
        and req_start == 0
        and req_end == total - 1
        and not os.path.exists(cache_final)
    )

    async def proxy():
        # Тянем сегментами по _SEGMENT байт с повтором при обрыве — googlevideo
        # надёжно отдаёт короткие range-запросы, но рвёт длинные потоки.
        tmp = None
        tmp_path = None
        committed = False
        if want_cache:
            try:
                fd, tmp_path = tempfile.mkstemp(dir=CACHE_DIR, suffix=".part")
                tmp = os.fdopen(fd, "wb")
            except OSError:
                tmp = None
        try:
            pos = req_start
            # Прогретое начало трека (см. _warm_first_chunk) отдаём с диска —
            # первые байты уходят клиенту мгновенно, живой proxy подхватывает
            # с позиции warm-файла. Только для запросов с начала файла (pos=0),
            # остальные Range идут прежним чистым proxy-путём.
            if pos == 0 and warm_size > 0:
                try:
                    with open(warm_path, "rb") as wf:
                        while req_end is None or pos <= req_end:
                            chunk = wf.read(_FILE_CHUNK)
                            if not chunk:
                                break
                            if req_end is not None and pos + len(chunk) > req_end + 1:
                                chunk = chunk[: req_end + 1 - pos]
                            if tmp is not None:
                                tmp.write(chunk)
                            pos += len(chunk)
                            yield chunk
                except OSError:
                    # Warm-файл не дочитался — продолжаем живым proxy с pos.
                    pass
            # Если размер неизвестен — качаем до конца (end=None) одним потоком
            # с ретраями по мере продвижения.
            while req_end is None or pos <= req_end:
                seg_end = pos + _SEGMENT - 1
                if req_end is not None:
                    seg_end = min(seg_end, req_end)
                headers = {"Range": f"bytes={pos}-{seg_end}"}

                got = 0
                for attempt in range(_SEGMENT_RETRIES):
                    try:
                        async with client.stream("GET", direct_url, headers=headers) as up:
                            if up.status_code >= 400:
                                logger.warning("upstream %s for %s", up.status_code, cache_id)
                                return
                            async for chunk in up.aiter_bytes(chunk_size=65536):
                                # Пишем в кэш только новые (за пределами уже
                                # полученных got) байты сегмента.
                                if tmp is not None:
                                    tmp.write(chunk)
                                got += len(chunk)
                                yield chunk
                        break
                    except httpx.HTTPError as exc:
                        # Частичный сегмент — досбираем оставшийся хвост.
                        if got:
                            headers = {"Range": f"bytes={pos + got}-{seg_end}"}
                        if attempt == _SEGMENT_RETRIES - 1:
                            logger.warning("segment failed %s @%d: %s", cache_id, pos, exc)
                            return

                advanced = (seg_end - pos + 1)
                pos += advanced
                if req_end is None and advanced < _SEGMENT:
                    break

            # Дошли до конца файла без обрыва — фиксируем кэш атомарно.
            if tmp is not None and req_end is not None and pos > req_end:
                tmp.flush()
                os.fsync(tmp.fileno())
                tmp.close()
                tmp = None
                os.replace(tmp_path, cache_final)
                committed = True
                # Полная копия на диске — warm-огрызок больше не нужен.
                try:
                    os.remove(warm_path)
                except OSError:
                    pass
                _enforce_cache_limit()
        finally:
            await client.aclose()
            if tmp is not None:
                tmp.close()
            if tmp_path and not committed and os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass

    status_code = 200
    headers = {"Accept-Ranges": "bytes", "Cache-Control": "no-store"}
    if total is not None:
        if request.headers.get("range"):
            status_code = 206
            headers["Content-Range"] = f"bytes {req_start}-{req_end}/{total}"
            headers["Content-Length"] = str(req_end - req_start + 1)
        else:
            headers["Content-Length"] = str(total)

    return StreamingResponse(
        proxy(),
        status_code=status_code,
        media_type=media_type,
        headers=headers,
    )


@router.get("/stream/{video_id}")
async def stream_ytmusic(video_id: str, request: Request):
    if _ytmusic is None:
        raise HTTPException(status_code=503, detail="YouTube Music не настроен")
    if not re.fullmatch(r"[A-Za-z0-9_-]{5,20}", video_id):
        raise HTTPException(status_code=400, detail="Некорректный id")
    return await stream_cached_audio(
        request, video_id, lambda force: _resolve_cached(video_id, force=force)
    )


@router.post("/prefetch/{video_id}")
async def prefetch_ytmusic(video_id: str):
    """Ставит трек в фоновую очередь прогрева (резолв в Redis + первые байты
    на диск, см. schedule_prefetch) и отвечает сразу. Фронт зовёт это для
    кликнутого и следующих в очереди треков."""
    if _ytmusic is None:
        raise HTTPException(status_code=503, detail="YouTube Music не настроен")
    if not re.fullmatch(r"[A-Za-z0-9_-]{5,20}", video_id):
        raise HTTPException(status_code=400, detail="Некорректный id")
    status = schedule_prefetch(
        video_id,
        lambda force=False: _resolve_cached(video_id, force=force),
        f"ytdlp:resolve:v2:{video_id}",
        _RESOLVE_TTL,
    )
    return {"status": status}
