"""Deezer как источник аудио для ytmusic-треков.

ytmusic у нас — каталог метаданных, а аудио той же записи берётся из
источника, который реально отдаёт байты. YouTube с адресов VPS и WARP
регулярно отвечает bot-check'ом (прямой выход и WARP получают «Sign in to
confirm you're not a bot» на большинство музыкальных роликов, проверено
2026-09-30), поэтому Deezer стоит в цепочке ПЕРЕД Soulseek/SoundCloud/YouTube:
его CDN отдаёт полный трек за доли секунды и без капчи.

Доступ — по cookie ``arl`` бесплатного аккаунта (MP3 128). Файл трека на CDN
зашифрован «полосами»: каждый третий блок по 2048 байт — Blowfish-CBC с ключом
из md5(id трека). Трек скачивается целиком, расшифровывается в дисковый кэш
ytdlp под id ytmusic-трека (дальше его отдаёт обычный путь _cached_file) и
уносится в MinIO под ``ytmusic/{video_id}`` — как усыновлённый файл Soulseek.

ARL — из DEEZER_ARL или файла DEEZER_ARL_FILE (по умолчанию
/app/secrets/deezer_arl.txt). Нет ни того, ни другого — источник выключен и
цепочка стрима его пропускает без сетевых вызовов.
"""

import asyncio
import hashlib
import logging
import os
import re
import time
import unicodedata
from typing import Optional

import httpx
from Crypto.Cipher import Blowfish
from fastapi import APIRouter, Request
from fastapi.responses import Response

from app.artist_utils import same_artist, to_latin
from app.cache import get_cache_async, set_cache_async

logger = logging.getLogger(__name__)

router = APIRouter()

_ARL_ENV = os.getenv("DEEZER_ARL", "").strip()
_ARL_FILE = os.getenv("DEEZER_ARL_FILE", "/app/secrets/deezer_arl.txt").strip()

_GW_URL = "https://www.deezer.com/ajax/gw-light.php"
_MEDIA_URL = "https://media.deezer.com/v1/get_url"
_API_URL = "https://api.deezer.com"
# Браузерный UA: gw-light — API веб-плеера, с UA питоновского клиента он
# отвечает так же, но лишний повод выделяться не нужен.
_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.0 Safari/605.1.15"
)

_BF_SECRET = b"g4el58wc0zvf9na1"
_BF_IV = bytes(range(8))
_CHUNK = 2048

# Сессия (api_token + license_token) живёт у Deezer часами; обновляем раньше.
_SESSION_TTL = 3600
# ARL не принят (протух/аккаунт забанен) — не долбим логин на каждый трек.
_BAD_ARL_BACKOFF = 600

_MATCH_TTL = 7 * 24 * 3600
_MATCH_MISS_TTL = 6 * 3600
# Одна и та же запись на двух сервисах расходится на секунду-две (трим тишины),
# длинные треки — сильнее (Deep Purple, 7:06 в ytmusic против 7:00 в Deezer).
# Радио-версия/ремастер обычно отличается сильнее и этим окном отсекается.
_MATCH_DURATION_TOLERANCE = 5
_MATCH_DURATION_TOLERANCE_RATIO = 0.02
_MATCH_SCHEDULE_LIMIT = 16
# Сколько /stream ждёт идущий поиск матча. Поиск в api.deezer.com — ~0.2 с.
_MATCH_STREAM_WAIT = 3.0
# Отказ скачивания (нет прав у бесплатного аккаунта в стране, CDN 403) —
# короткий негативный кэш: цепочка стрима сразу идёт дальше, а ретраи
# браузера не качают заново.
_FAIL_TTL = 600
# Потолок размера: MP3 128 — ~1 МБ/мин, 40 МБ — это 40+ минут.
_MAX_BYTES = 40 * 1024 * 1024

_client = httpx.AsyncClient(
    timeout=httpx.Timeout(15.0, read=30.0),
    follow_redirects=True,
    headers={"User-Agent": _USER_AGENT},
)

# Публичный api.deezer.com пускает 50 запросов за 5 с с адреса, дальше
# «Quota limit exceeded». Импорт плейлиста на сотни треков зовёт поиск
# ytmusic на каждый трек, а тот — матч сюда, поэтому поиски идут не чаще
# одного за _SEARCH_INTERVAL (8 в секунду, с запасом под лимит).
_SEARCH_INTERVAL = 0.125
_search_lock = asyncio.Lock()
_last_search = 0.0

_arl_cache: tuple[float, str] = (0.0, "")
_session: dict = {}
_session_lock = asyncio.Lock()
_bad_arl_until = 0.0
_match_inflight: dict[str, asyncio.Task] = {}
_download_locks: dict[str, asyncio.Lock] = {}
_adopt_inflight: set[str] = set()


class DeezerError(RuntimeError):
    pass


def _arl() -> str:
    """ARL из окружения или файла; файл перечитывается при смене mtime."""
    global _arl_cache
    if _ARL_ENV:
        return _ARL_ENV
    try:
        mtime = os.path.getmtime(_ARL_FILE)
    except OSError:
        return ""
    if mtime != _arl_cache[0]:
        try:
            with open(_ARL_FILE, encoding="utf-8") as fh:
                _arl_cache = (mtime, fh.read().strip())
        except OSError:
            return ""
    return _arl_cache[1]


def enabled() -> bool:
    return bool(_arl()) and time.monotonic() >= _bad_arl_until


async def _gw_call(method: str, api_token: str, body: Optional[dict] = None) -> dict:
    r = await _client.post(
        _GW_URL,
        params={"method": method, "input": "3", "api_version": "1.0", "api_token": api_token},
        json=body or {},
        cookies={"arl": _arl()},
    )
    r.raise_for_status()
    data = r.json()
    error = data.get("error")
    if error:
        raise DeezerError(f"{method}: {error}")
    return data.get("results") or {}


async def _login(force: bool = False) -> dict:
    """Сессия веб-плеера: api_token для gw-light и license_token для CDN."""
    global _session, _bad_arl_until
    async with _session_lock:
        if not force and _session and _session["expires"] > time.monotonic():
            return _session
        user = await _gw_call("deezer.getUserData", "")
        options = (user.get("USER") or {}).get("OPTIONS") or {}
        if not (user.get("USER") or {}).get("USER_ID") or not options.get("license_token"):
            _bad_arl_until = time.monotonic() + _BAD_ARL_BACKOFF
            _session = {}
            logger.error("deezer: ARL не принят (протух или аккаунт заблокирован) — источник выключен на %ds", _BAD_ARL_BACKOFF)
            raise DeezerError("ARL rejected")
        _session = {
            "api_token": user["checkForm"],
            "license_token": options["license_token"],
            "country": user.get("COUNTRY"),
            "offer": user.get("OFFER_NAME"),
            "expires": time.monotonic() + _SESSION_TTL,
        }
        return _session


async def _gw(method: str, body: dict) -> dict:
    session = await _login()
    try:
        return await _gw_call(method, session["api_token"], body)
    except DeezerError as exc:
        # api_token протух раньше нашего TTL — перелогиниваемся один раз.
        if "token" not in str(exc).lower():
            raise
        session = await _login(force=True)
        return await _gw_call(method, session["api_token"], body)


# ---------------------------------------------------------------------------
# Расшифровка
# ---------------------------------------------------------------------------


def _bf_key(sng_id: str) -> bytes:
    digest = hashlib.md5(str(sng_id).encode()).hexdigest().encode()
    return bytes(digest[i] ^ digest[i + 16] ^ _BF_SECRET[i] for i in range(16))


def _decrypt_chunk(key: bytes, index: int, chunk: bytes) -> bytes:
    """Блок номер ``index`` (по 2048 байт от начала файла) в открытом виде.

    Шифруется каждый третий ПОЛНЫЙ блок; неполный хвост файла идёт как есть.
    """
    if index % 3 == 0 and len(chunk) == _CHUNK:
        return Blowfish.new(key, Blowfish.MODE_CBC, _BF_IV).decrypt(chunk)
    return chunk


def decrypt(data: bytes, sng_id: str) -> bytes:
    key = _bf_key(sng_id)
    return b"".join(
        _decrypt_chunk(key, i // _CHUNK, data[i:i + _CHUNK])
        for i in range(0, len(data), _CHUNK)
    )


# ---------------------------------------------------------------------------
# ytmusic → Deezer
# ---------------------------------------------------------------------------


# Стилизация латинских имён кириллическими буквами-двойниками: «KoЯn»,
# «NIИ». Сводим, только если в слове есть и латиница, — у настоящего
# кириллического названия эти буквы трогать нельзя.
_FAUX_CYRILLIC = str.maketrans({"я": "r", "и": "n", "д": "a", "ш": "w", "ф": "o", "ё": "e"})


def _key(text: str) -> str:
    """Форма для сравнения: без регистра, диакритики и пунктуации."""
    text = unicodedata.normalize("NFKD", (text or "").lower())
    text = "".join(ch for ch in text if not unicodedata.combining(ch) or ch == "\u0306")
    # NFKD разбивает «й» на «и» + бреве; собираем обратно, чтобы не путать с «и».
    text = unicodedata.normalize("NFC", text)
    words = []
    for word in text.split():
        if re.search(r"[a-z]", word) and re.search(r"[а-яё]", word):
            word = word.translate(_FAUX_CYRILLIC)
        words.append(word)
    return re.sub(r"[^a-z0-9а-яё]+", "", "".join(words))


def _same_text(left: str, right: str) -> bool:
    a, b = _key(left), _key(right)
    if not a or not b:
        return False
    if a == b or a in b or b in a:
        return True
    # Кириллица против латиницы у одного и того же названия.
    la, lb = _key(to_latin(left)), _key(to_latin(right))
    return bool(la and lb) and (la == lb or la in lb or lb in la)


def is_same_recording(
    cand_title: str, cand_artist: str, cand_duration: int,
    title: str, artist: str, duration: int,
) -> bool:
    """Та же запись: совпадают длительность, артист и название одновременно.

    Как soundcloud._is_exact_match, но артист сравнивается и через
    транслитерацию: Deezer часто отдаёт русских артистов латиницей
    («Mumiy Troll» против «Мумий Тролль» в YouTube Music).
    """
    if duration <= 0 or cand_duration <= 0:
        return False
    tolerance = max(_MATCH_DURATION_TOLERANCE, duration * _MATCH_DURATION_TOLERANCE_RATIO)
    if abs(cand_duration - duration) > tolerance:
        return False
    if not (_same_text(cand_artist, artist) or same_artist(cand_artist, artist)):
        return False
    return _same_text(cand_title, title)


async def find_deezer_equivalent(
    video_id: str, title: str, artist: str, duration: int
) -> Optional[str]:
    """id трека Deezer той же записи или None. Промах кэшируется."""
    key = f"ytmusic:dzmatch:{video_id}"
    cached = await get_cache_async(key)
    if cached:
        sng_id = cached.get("sng_id")
        return str(sng_id) if sng_id else None

    from app.routers.ytdlp import clean_title

    want_title = clean_title(title or "")
    if not want_title or not artist or duration <= 0:
        await set_cache_async(key, {"sng_id": None}, expire=_MATCH_MISS_TTL)
        return None

    global _last_search
    try:
        async with _search_lock:
            delay = _last_search + _SEARCH_INTERVAL - time.monotonic()
            if delay > 0:
                await asyncio.sleep(delay)
            _last_search = time.monotonic()
        r = await _client.get(f"{_API_URL}/search", params={"q": f"{artist} {want_title}", "limit": 10})
        r.raise_for_status()
        data = r.json()
    except Exception:  # noqa: BLE001 — промах не доказан, не кэшируем
        logger.warning("deezer search failed for ytmusic %s", video_id, exc_info=True)
        return None
    if not isinstance(data, dict) or "data" not in data:
        # {"error": {...}} — квота API/сбой, а не «ничего нет».
        logger.warning("deezer search error for ytmusic %s: %s", video_id, str(data)[:200])
        return None

    match = None
    for item in data.get("data") or []:
        if not item.get("readable", True):
            continue
        if is_same_recording(
            clean_title(item.get("title") or ""),
            (item.get("artist") or {}).get("name") or "",
            int(item.get("duration") or 0),
            want_title, artist, duration,
        ):
            match = str(item["id"])
            break

    await set_cache_async(
        key, {"sng_id": match}, expire=_MATCH_TTL if match else _MATCH_MISS_TTL
    )
    if match:
        logger.info("ytmusic track %s (%s — %s) matched to deezer %s", video_id, artist, title, match)
    else:
        logger.info("no deezer equivalent for ytmusic track %s", video_id)
    return match


async def deezer_match_for(video_id: str) -> Optional[str]:
    """Известный матч из кэша, без поиска."""
    cached = await get_cache_async(f"ytmusic:dzmatch:{video_id}")
    sng_id = cached.get("sng_id") if cached else None
    return str(sng_id) if sng_id else None


async def _match_job(video_id: str, title: str, artist: str, duration: int) -> Optional[str]:
    try:
        return await find_deezer_equivalent(video_id, title, artist, duration)
    except Exception:  # noqa: BLE001 — фоновый матч
        logger.warning("deezer match failed for ytmusic %s", video_id, exc_info=True)
        return None


def _start_match(video_id: str, title: str, artist: str, duration: int) -> asyncio.Task:
    task = asyncio.create_task(_match_job(video_id, title, artist, duration))
    _match_inflight[video_id] = task
    task.add_done_callback(lambda _t, vid=video_id: _match_inflight.pop(vid, None))
    return task


def schedule_ytmusic_deezer_match(tracks) -> None:
    """Ищет Deezer-эквиваленты ytmusic-треков в фоне (как soundcloud/soulseek)."""
    if not enabled():
        return
    from app.routers.soundcloud import _sc_match_fields

    for track in list(tracks)[:_MATCH_SCHEDULE_LIMIT]:
        fields = _sc_match_fields(track)
        if fields is None or fields[0] in _match_inflight:
            continue
        _start_match(*fields)


def _parse_length(text: str) -> int:
    try:
        parts = [int(p) for p in (text or "").split(":")]
    except ValueError:
        return 0
    seconds = 0
    for part in parts:
        seconds = seconds * 60 + part
    return seconds


def _ytmusic_meta_blocking(video_id: str) -> Optional[tuple[str, str, int]]:
    """(title, artist, duration) ytmusic-трека по его id.

    get_watch_playlist — запрос к каталогу YouTube Music (не к плееру), его
    bot-check не задевает (проверено 2026-09-30 на прод-IP).
    """
    from app.routers.ytdlp import _ytmusic

    if _ytmusic is None:
        return None
    tracks = (_ytmusic.get_watch_playlist(videoId=video_id, limit=1) or {}).get("tracks") or []
    if not tracks or tracks[0].get("videoId") != video_id:
        return None
    track = tracks[0]
    artists = track.get("artists") or []
    artist = (artists[0] or {}).get("name") if artists else ""
    return track.get("title") or "", artist or "", _parse_length(track.get("length") or "")


async def await_deezer_match(video_id: str, timeout: float = _MATCH_STREAM_WAIT) -> Optional[str]:
    """Матч для /stream: кэш, идущий поиск или поиск по метаданным каталога.

    У /stream нет метаданных трека. Если матч не искали заранее (трек пришёл
    не из поиска/потока, а, например, из очереди после рестарта), берём их из
    каталога ytmusic и ищем сразу — всё в пределах timeout.
    """
    cached = await get_cache_async(f"ytmusic:dzmatch:{video_id}")
    if cached:
        sng_id = cached.get("sng_id")
        return str(sng_id) if sng_id else None

    async def lookup() -> Optional[str]:
        task = _match_inflight.get(video_id)
        if task is None:
            meta = await asyncio.to_thread(_ytmusic_meta_blocking, video_id)
            if meta is None:
                return None
            task = _match_inflight.get(video_id) or _start_match(video_id, *meta)
        # shield: таймаут стрима не отменяет общий поиск.
        return await asyncio.shield(task)

    try:
        return await asyncio.wait_for(lookup(), timeout)
    except asyncio.TimeoutError:
        return None
    except Exception:  # noqa: BLE001 — матч не должен ломать стрим
        logger.warning("deezer match lookup failed for %s", video_id, exc_info=True)
        return None


# ---------------------------------------------------------------------------
# Скачивание в дисковый кэш
# ---------------------------------------------------------------------------


async def _media_url(sng_id: str) -> tuple[str, str, int, int]:
    """(url на CDN, id для ключа расшифровки, ожидаемый размер, длительность) MP3 128."""
    song = await _gw("song.getData", {"sng_id": sng_id})
    # Трек недоступен в стране аккаунта — Deezer подставляет замену (тот же
    # релиз под другим id) в FALLBACK. Ключ расшифровки — от id замены.
    fallback = song.get("FALLBACK") or {}
    if fallback.get("TRACK_TOKEN") and not song.get("TRACK_TOKEN"):
        song = fallback
    real_id = str(song.get("SNG_ID") or sng_id)
    size = int(song.get("FILESIZE_MP3_128") or 0)
    duration = int(song.get("DURATION") or 0)
    session = await _login()
    r = await _client.post(_MEDIA_URL, json={
        "license_token": session["license_token"],
        "media": [{"type": "FULL", "formats": [{"cipher": "BF_CBC_STRIPE", "format": "MP3_128"}]}],
        "track_tokens": [song["TRACK_TOKEN"]],
    })
    r.raise_for_status()
    item = (r.json().get("data") or [{}])[0]
    media = item.get("media") or []
    if not media or not media[0].get("sources"):
        raise DeezerError(f"no media for {sng_id}: {item.get('errors')}")
    return media[0]["sources"][0]["url"], real_id, size, duration


# MP3 128 кбит/с — 16000 байт на секунду звука.
_MP3_128_BYTES_PER_SEC = 16000


def is_full_length(size: int, duration: int) -> bool:
    """Файл покрывает всю длительность трека, а не 30-секундное превью.

    Превью Deezer отдаёт вместо трека, если у аккаунта нет прав на полный
    (страна, лейбл). Размер у него честный для самого превью, поэтому сверка с
    FILESIZE_MP3_128 его не ловит — сверяем объём с длительностью трека.
    Запас 20% — на VBR-хвосты и тишину; превью короче в разы.
    """
    if duration <= 0:
        return size > 0
    return size >= duration * _MP3_128_BYTES_PER_SEC * 0.8


async def _download(sng_id: str, dest: str) -> None:
    """Скачивает и расшифровывает трек в ``dest`` (через .part)."""
    url, real_id, expected, duration = await _media_url(sng_id)
    key = _bf_key(real_id)
    part = dest + ".part"
    written = 0
    buf = b""
    index = 0
    try:
        with open(part, "wb") as fh:
            async with _client.stream("GET", url) as r:
                r.raise_for_status()
                async for data in r.aiter_bytes():
                    buf += data
                    while len(buf) >= _CHUNK:
                        fh.write(_decrypt_chunk(key, index, buf[:_CHUNK]))
                        buf = buf[_CHUNK:]
                        index += 1
                        written += _CHUNK
                    if written > _MAX_BYTES:
                        raise DeezerError(f"{sng_id} больше {_MAX_BYTES} байт")
            if buf:
                fh.write(_decrypt_chunk(key, index, buf))
                written += len(buf)
        if expected and written != expected:
            raise DeezerError(f"{sng_id}: скачано {written} из {expected} байт")
        if not is_full_length(written, duration):
            raise DeezerError(f"{sng_id}: {written} байт на {duration} с — похоже на превью")
        os.replace(part, dest)
    finally:
        if os.path.exists(part):
            try:
                os.remove(part)
            except OSError:
                pass


async def fetch_to_cache(video_id: str, sng_id: str) -> Optional[str]:
    """Путь к расшифрованному MP3 трека в дисковом кэше ytdlp или None.

    Один трек качается один раз: браузер шлёт на трек несколько Range-запросов
    подряд, остальные ждут первый на блокировке и получают готовый файл.
    """
    from app.routers.ytdlp import CACHE_DIR, _cached_file, _enforce_cache_limit

    lock = _download_locks.setdefault(video_id, asyncio.Lock())
    async with lock:
        ready = _cached_file(video_id)
        if ready:
            return ready
        if await get_cache_async(f"deezer:fail:{video_id}"):
            return None
        dest = os.path.join(CACHE_DIR, f"{video_id}.mp3")
        started = time.monotonic()
        try:
            await _download(sng_id, dest)
        except Exception as exc:  # noqa: BLE001 — цепочка стрима пойдёт дальше
            logger.warning("deezer download failed for %s (deezer %s): %s", video_id, sng_id, exc)
            await set_cache_async(f"deezer:fail:{video_id}", {"error": str(exc)[:200]}, expire=_FAIL_TTL)
            return None
        finally:
            _download_locks.pop(video_id, None)
        logger.info(
            "deezer %s → %s: %d B за %.1f с",
            sng_id, video_id, os.path.getsize(dest), time.monotonic() - started,
        )
        await asyncio.to_thread(_enforce_cache_limit)
        _schedule_adopt(video_id, dest)
        return dest


def _schedule_adopt(video_id: str, path: str) -> None:
    """Уносит файл в MinIO под ytmusic/{video_id}: дисковый кэш вытесняется."""
    if video_id in _adopt_inflight:
        return
    from app import external_archive

    async def job():
        try:
            await external_archive.adopt_local_file("ytmusic", video_id, path)
        except Exception:  # noqa: BLE001 — фон
            logger.warning("deezer adopt failed for %s", video_id, exc_info=True)
        finally:
            _adopt_inflight.discard(video_id)

    _adopt_inflight.add(video_id)
    asyncio.create_task(job())


async def stream_for_ytmusic(video_id: str, request: Request) -> Optional[Response]:
    """Ответ с аудио ytmusic-трека из Deezer или None (идём дальше по цепочке)."""
    if not enabled():
        return None
    sng_id = await await_deezer_match(video_id)
    if not sng_id:
        return None
    path = await fetch_to_cache(video_id, sng_id)
    if not path:
        return None
    from app.routers.ytdlp import _serve_file

    return await _serve_file(path, "audio/mpeg", request)


async def prefetch_for_ytmusic(video_id: str) -> bool:
    """Качает трек заранее, если матч уже известен. True — прогрев запущен."""
    if not enabled():
        return False
    sng_id = await await_deezer_match(video_id, timeout=1.0)
    if not sng_id:
        return False

    async def job():
        try:
            await fetch_to_cache(video_id, sng_id)
        except Exception:  # noqa: BLE001 — фон
            logger.warning("deezer prefetch failed for %s", video_id, exc_info=True)

    asyncio.create_task(job())
    return True


@router.get("/status")
async def deezer_status():
    """Состояние источника: настроен ли ARL, принят ли он, страна и тариф."""
    if not _arl():
        return {"configured": False}
    try:
        session = await _login()
    except Exception as exc:  # noqa: BLE001
        return {"configured": True, "logged_in": False, "error": str(exc)[:200]}
    return {
        "configured": True,
        "logged_in": True,
        "country": session.get("country"),
        "offer": session.get("offer"),
    }
