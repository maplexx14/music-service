"""Оригиналы вместо треков, зацензуренных по закону РФ.

Закон о «пропаганде» (наркотики и т.п.) заставил дистрибьюторов заменить
релизы части русских треков цензурными версиями: звук запикан, иногда
переписано и название («СЕРЕГА ПИРАТ — В этой оу е» вместо «В этой траве»).
Замена прошла по всем площадкам сразу — YouTube Music, Deezer и т.д., — а
explicit-флаг у таких треков как стоял, так и стоит. Оригиналы остались на
SoundCloud: их заливали сами артисты. Сервис работает не в РФ, поэтому для
таких треков играет оригинал.

Автоматически отличить цензурный релиз от обычного по метаданным нельзя («Клей»
у CUPSIZE называется так же, как и был), поэтому привязку «трек каталога →
оригинал на SoundCloud» подтверждает админ (models.CensorOverride). Сервис
только предлагает кандидатов: при прослушивании русского трека ищет на
SoundCloud залив того же артиста с близкой длительностью, но изменённым
названием — такой трек попадает в админку со статусом suggested.

Подтверждённая привязка действует везде, где играет трек каталога:
- звук — /api/ytdlp/stream/{id} отдаёт 307 на оригинал (ytdlp.stream_ytmusic),
  и не только у привязанного id: у других id той же записи (клип и
  аудиодорожка, сингл и альбом) тоже, их опознаёт общий трек Deezer;
- выдача — поиск, поток, рекомендации, страницы артиста/альбома показывают
  название оригинала (apply_overrides);
- библиотека — записи Track получают название оригинала при подтверждении.
"""
import asyncio
import difflib
import functools
import logging
import math
import re
import time
from typing import Any, Iterable, Optional

from app.artist_utils import same_artist
from app.cache import get_cache_async, set_cache_async
from app.database import SessionLocal
from app.models import CensorOverride, Track

logger = logging.getLogger(__name__)

STATUS_CONFIRMED = "confirmed"
STATUS_SUGGESTED = "suggested"
STATUS_REJECTED = "rejected"

# Подтверждённые привязки держим в памяти воркера: их десятки, а смотрят их
# на каждый стрим и каждую выдачу. Изменение из админки сбрасывает кэш своего
# воркера сразу, остальные подхватят через _CACHE_TTL.
_CACHE_TTL = 30.0
_cache: dict = {"at": 0.0, "by_id": {}, "by_key": {}}
_cache_lock = asyncio.Lock()

# Другой id той же цензурной записи (сингл и альбом), опознанный по ключу
# «артист|название» в выдаче: стрим знает только id, поэтому запоминаем.
_ALIAS_TTL = 30 * 24 * 3600

# Другой id той же записи ключ «артист|название» ловит не всегда: клип пишет
# артистов иначе, чем аудиодорожка, а библиотека и очередь после рестарта
# играют мимо выдачи с подменой. Общий у таких id — трек Deezer: матчер сводит
# их к одной записи, и без привязки все они играли бы её цензурный звук
# (skyline ryodan: аудиодорожка и Deezer зацензурены, клип нет — а клип
# играл Deezer). Храним «трек Deezer → id привязки» и раз в час обновляем.
_DEEZER_TTL = 30 * 24 * 3600
_DEEZER_REINDEX = 3600
_deezer_indexed: dict[str, float] = {}
_deezer_index_task: Optional[asyncio.Task] = None

# Автоподсказки: один трек проверяем не чаще раза в месяц и по одному за раз
# (поиск SoundCloud идёт через платный прокси).
_SUGGEST_CHECK_TTL = 30 * 24 * 3600
_suggest_sem = asyncio.Semaphore(1)
_suggest_inflight: set[str] = set()

_CYRILLIC = re.compile(r"[а-яё]", re.IGNORECASE)
# Звёздочки и прочие заглушки вместо букв: «В ЭТ*Й Т**ВЕ».
_CENSOR_GLYPHS = re.compile(r"[*#…]|_{2,}")
# Производные заливы: ремиксы, ускорения, каверы. Оригиналом они не бывают,
# если только сам трек каталога не такой же.
_DERIVATIVE = re.compile(
    r"remix|ремикс|\brmx\b|speed|sped|slowed|замедл|ускор|nightcore|найткор|"
    r"reverb|cover|кавер|mashup|мэшап|instrumental|инструментал|минус|karaoke|"
    r"караоке|\b8d\b|bass\s*boost|mylancore|\bedit\b|suno|\bver\.?\b|версия",
    re.IGNORECASE,
)


def censored_key(artist: str, title: str) -> str:
    from app.routers.aggregate import dedup_key

    return "|".join(dedup_key(_Named(artist, title)))


class _Named:
    __slots__ = ("artist", "title")

    def __init__(self, artist: str, title: str):
        self.artist = artist
        self.title = title


def _snapshot(row: CensorOverride) -> dict:
    return {
        "id": row.id,
        "source": row.source,
        "external_id": row.external_id,
        "censored_title": row.censored_title,
        "censored_artist": row.censored_artist,
        "original_id": row.original_id,
        "original_permalink": row.original_permalink,
        "original_title": row.original_title,
        "original_artist": row.original_artist,
        "original_duration": row.original_duration or 0,
        "original_cover_url": row.original_cover_url,
        "status": row.status,
        "score": row.score,
        # Нет автора — привязал сам сервис (auto_confirmable) или это
        # подсказка, которую ещё никто не трогал.
        "auto": row.created_by is None,
        "evidence": row.evidence,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


def _load_confirmed_blocking() -> tuple[dict, dict]:
    db = SessionLocal()
    try:
        rows = db.query(CensorOverride).filter(CensorOverride.status == STATUS_CONFIRMED).all()
        by_id = {row.external_id: _snapshot(row) for row in rows}
        by_key = {row.censored_key: by_id[row.external_id] for row in rows}
        return by_id, by_key
    finally:
        db.close()


def invalidate() -> None:
    _cache["at"] = 0.0


async def confirmed_overrides() -> tuple[dict, dict]:
    """(по id цензурной версии, по ключу «артист|название») — только confirmed."""
    if time.monotonic() - _cache["at"] < _CACHE_TTL:
        return _cache["by_id"], _cache["by_key"]
    async with _cache_lock:
        if time.monotonic() - _cache["at"] >= _CACHE_TTL:
            try:
                by_id, by_key = await asyncio.to_thread(_load_confirmed_blocking)
            except Exception:  # noqa: BLE001 — без привязок сервис играет как раньше
                logger.exception("censor overrides load failed")
                by_id, by_key = _cache["by_id"], _cache["by_key"]
            _cache.update(at=time.monotonic(), by_id=by_id, by_key=by_key)
            _schedule_deezer_index(by_id)
    return _cache["by_id"], _cache["by_key"]


def _alias_key(video_id: str) -> str:
    return f"censor:alias:{video_id}"


def _deezer_key(sng_id: str) -> str:
    return f"censor:deezer:{sng_id}"


def _schedule_deezer_index(by_id: dict) -> None:
    global _deezer_index_task
    if _deezer_index_task is not None and not _deezer_index_task.done():
        return
    now = time.monotonic()
    stale = [
        video_id for video_id in by_id
        if now - _deezer_indexed.get(video_id, -math.inf) >= _DEEZER_REINDEX
    ]
    if stale:
        _deezer_index_task = asyncio.create_task(_index_by_deezer(stale))


async def _index_by_deezer(video_ids: list[str]) -> None:
    """Трек Deezer каждой привязанной записи → id привязки (см. _DEEZER_TTL)."""
    from app.routers import deezer

    if not deezer.enabled():
        return
    for video_id in video_ids:
        _deezer_indexed[video_id] = time.monotonic()
        try:
            # Матч обычно уже в кэше; нет — метаданные из каталога и поиск,
            # в фоне ждать можно дольше, чем стриму.
            sng_id = await deezer.await_deezer_match(video_id, timeout=60.0)
            if sng_id:
                await set_cache_async(_deezer_key(sng_id), video_id, expire=_DEEZER_TTL)
        except Exception:  # noqa: BLE001 — фон, повторим через _DEEZER_REINDEX
            logger.warning("censor deezer index failed for %s", video_id, exc_info=True)


async def override_for_video(video_id: str, deezer_id: Optional[str] = None) -> Optional[dict]:
    """Подтверждённый оригинал для ytmusic-трека или None.

    deezer_id — матч Deezer, если зовущий его уже дождался (стрим холодного
    id); иначе берётся матч из кэша, без поиска.
    """
    by_id, _by_key = await confirmed_overrides()
    if not by_id:
        return None
    override = by_id.get(video_id)
    if override is not None:
        return override
    alias = await get_cache_async(_alias_key(video_id))
    if alias in by_id:
        return by_id[alias]
    from app.routers import deezer

    sng_id = deezer_id or await deezer.deezer_match_for(video_id)
    censored_id = await get_cache_async(_deezer_key(sng_id)) if sng_id else None
    override = by_id.get(censored_id) if censored_id else None
    if override is not None:
        # Матч Deezer живёт неделю, своя копия трека — дольше.
        await set_cache_async(_alias_key(video_id), censored_id, expire=_ALIAS_TTL)
    return override


def soundcloud_stream_path(override: dict, video_id: str = "") -> str:
    """Путь стрима оригинала. vid — путь назад, если SoundCloud не отдаст трек
    (см. soundcloud.stream_soundcloud): лучше цензура, чем тишина."""
    from app.routers.soundcloud import _encode_token

    token = _encode_token(override["original_id"], override["original_permalink"])
    suffix = f"?vid={video_id}" if video_id else ""
    return f"/api/soundcloud/stream/{token}{suffix}"


def _field(track: Any, name: str):
    if isinstance(track, dict):
        return track.get(name)
    return getattr(track, name, None)


def _with_original(track: Any, override: dict) -> Any:
    update = {"title": override["original_title"], "is_clean": False}
    if override.get("original_duration"):
        # Длительность — оригинала: играет именно он, прогресс-бар и
        # конец трека в плеере считаются от неё.
        update["duration"] = override["original_duration"]
    if isinstance(track, dict):
        return {**track, **update}
    if hasattr(track, "model_copy"):
        fields = getattr(type(track), "model_fields", {})
        return track.model_copy(update={k: v for k, v in update.items() if k in fields})
    return track


async def apply_overrides(tracks: Iterable[Any]) -> list:
    """Выдача с названиями оригиналов у зацензуренных ytmusic-треков.

    Понимает и объекты выдачи (ExternalTrackResponse), и dict'и (поток).
    Возвращает новый список; объекты не мутируются — они могут лежать в
    провайдерских кэшах.
    """
    tracks = list(tracks)
    by_id, by_key = await confirmed_overrides()
    if not by_id:
        return tracks
    out = []
    for track in tracks:
        video_id = _field(track, "external_id")
        if _field(track, "source") != "ytmusic" or not video_id:
            out.append(track)
            continue
        override = by_id.get(video_id)
        if override is None:
            override = by_key.get(
                censored_key(_field(track, "artist") or "", _field(track, "title") or "")
            )
            if override is not None:
                await set_cache_async(_alias_key(video_id), override["external_id"], expire=_ALIAS_TTL)
        out.append(_with_original(track, override) if override else track)
    return out


def overrides_in_response(*attrs: str):
    """Декоратор эндпоинта: названия оригиналов в его выдаче.

    Выдача — список треков или модель, у которой треки лежат в полях attrs.
    Подменять на выходе, а не у провайдеров: те отдают треки из своих кэшей
    мимо любых общих точек.
    """
    def decorator(fn):
        @functools.wraps(fn)
        async def wrapper(*args, **kwargs):
            result = await fn(*args, **kwargs)
            try:
                if isinstance(result, list):
                    return await apply_overrides(result)
                for attr in attrs:
                    value = _field(result, attr)
                    if isinstance(value, list):
                        replaced = await apply_overrides(value)
                        if isinstance(result, dict):
                            result[attr] = replaced
                        else:
                            setattr(result, attr, replaced)
            except Exception:  # noqa: BLE001 — выдача важнее подмены названий
                logger.exception("censor overrides in %s failed", fn.__name__)
            return result

        return wrapper

    return decorator


# ---------------------------------------------------------------------------
# Кандидаты на SoundCloud
# ---------------------------------------------------------------------------


def _text_key(text: str) -> str:
    return re.sub(r"[^a-z0-9а-яё]+", "", (text or "").lower())


def _artist_matches(candidate: str, artist: str) -> bool:
    """Кандидат — один из артистов трека («GRILLYAZH, CUPSIZE»)."""
    from app.routers.deezer import _same_text

    if not candidate:
        return False
    parts = [p.strip() for p in re.split(r",|&|\bfeat\.?|\bft\.?", artist or "") if p.strip()]
    return any(same_artist(candidate, p) or _same_text(candidate, p) for p in parts or [artist])


def title_similarity(left: str, right: str) -> float:
    a, b = _text_key(left), _text_key(right)
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def score_candidate(item: dict, title: str, artist: str, duration: int) -> Optional[dict]:
    """Кандидат в оригиналы из объекта трека api-v2 или None (не подходит).

    Название не требуем совпадающим — цензура его и меняет. Держимся за
    артиста и длительность, отсекаем производные заливы; выше — заливы с
    аккаунта самого артиста и похожие названия.
    """
    from app.routers import soundcloud

    track_id = str(item.get("id") or "")
    permalink = item.get("permalink_url") or ""
    if not track_id or "soundcloud.com/" not in permalink:
        return None
    if not soundcloud._is_full_stream(item):
        return None
    cand_artist, cand_title = soundcloud._api_artist_title(item)
    uploader = (item.get("user") or {}).get("username") or ""
    official = _artist_matches(uploader, artist)
    if not (official or _artist_matches(cand_artist, artist)):
        return None
    raw_title = item.get("title") or ""
    if _DERIVATIVE.search(raw_title) and not _DERIVATIVE.search(title or ""):
        return None
    cand_duration = round((item.get("duration") or 0) / 1000)
    delta = 0.0
    if duration > 0:
        tolerance = max(8.0, duration * 0.06)
        delta = abs(cand_duration - duration)
        if delta > tolerance:
            return None
        closeness = 1 - delta / tolerance
    else:
        closeness = 0.0
    similarity = title_similarity(cand_title, title)
    plays = int(item.get("playback_count") or 0)
    has_publisher = bool((item.get("publisher_metadata") or {}).get("artist"))
    # Похожесть названия весит больше аккаунта: у «Клей» цензура тронула
    # только звук, и нужный залив — чужой перезалив с тем же названием, а не
    # другой трек с официального аккаунта.
    score = (
        1.5 * official
        + 0.5 * has_publisher
        + 3.0 * similarity
        + closeness
        + 0.5 * min(math.log10(plays + 1) / 6, 1.0)
    )
    return {
        "id": track_id,
        "permalink": permalink,
        "title": cand_title,
        "artist": cand_artist,
        "uploader": uploader,
        "duration": cand_duration,
        "cover_url": soundcloud._upscale_artwork(
            item.get("artwork_url") or (item.get("user") or {}).get("avatar_url")
        ),
        "official": official,
        "title_similarity": round(similarity, 3),
        "playback_count": plays,
        "score": round(score, 3),
    }


async def find_candidates(title: str, artist: str, duration: int, limit: int = 8) -> list[dict]:
    """Кандидаты в оригиналы на SoundCloud, лучшие первыми."""
    from app.routers import soundcloud

    # Второй запрос — по одному артисту: у переименованного трека поиск по
    # цензурному названию оригинал может и не найти.
    queries = [f"{artist} {title}".strip(), artist.strip()]
    found: dict[str, dict] = {}
    for query in dict.fromkeys(q for q in queries if q):
        data = await soundcloud._api_get("/search/tracks", {"q": query, "limit": 20})
        if not isinstance(data, dict):
            continue
        for item in data.get("collection") or []:
            candidate = score_candidate(item, title, artist, duration)
            if candidate and candidate["id"] not in found:
                found[candidate["id"]] = candidate
    return sorted(found.values(), key=lambda c: -c["score"])[:limit]


async def resolve_soundcloud_track(url_or_id: str) -> Optional[dict]:
    """Объект трека api-v2 по ссылке soundcloud.com/… или числовому id."""
    from app.routers import soundcloud

    value = (url_or_id or "").strip()
    if value.isdigit():
        data = await soundcloud._api_get(f"/tracks/{value}", {})
    elif re.match(r"https?://(www\.|m\.)?(soundcloud\.com|on\.soundcloud\.com)/", value):
        data = await soundcloud._api_get("/resolve", {"url": value})
    else:
        return None
    if not isinstance(data, dict) or data.get("kind") != "track":
        return None
    return data


def looks_censored(censored_title: str, original_title: str) -> bool:
    """Название каталога похоже на испорченное название оригинала.

    Одинаковые названия — не сигнал: цензура могла тронуть только звук, а
    может и не тронуть ничего, и отличить эти случаи по метаданным нельзя.
    """
    a, b = _text_key(censored_title), _text_key(original_title)
    if not a or not b or a == b:
        return False
    if _CENSOR_GLYPHS.search(censored_title or ""):
        return True
    # Одно название целиком внутри другого — это другая версия той же песни
    # («Шизоид» и «Шизоид (live)»), а не вырезанные слова.
    if a in b or b in a:
        return False
    return title_similarity(censored_title, original_title) >= 0.4


# Автопривязка — только когда ошибиться почти негде: залив с аккаунта самого
# артиста, название явно испорчено, длительность почти та же, и такой кандидат
# у трека один. Остальное остаётся подсказкой для админа.
_AUTO_MIN_SIMILARITY = 0.5
_AUTO_MAX_DURATION_DELTA = 6


def auto_confirmable(title: str, duration: int, candidate: dict, rivals: list[dict]) -> bool:
    """Можно ли привязать кандидата без админа.

    rivals — остальные кандидаты: если ещё один залив артиста тоже похож на
    оригинал этого трека, выбор неоднозначен и остаётся за админом.
    """
    if not candidate["official"] or not looks_censored(title, candidate["title"]):
        return False
    if duration <= 0 or abs(candidate["duration"] - duration) > _AUTO_MAX_DURATION_DELTA:
        return False
    if (
        not _CENSOR_GLYPHS.search(title or "")
        and title_similarity(title, candidate["title"]) < _AUTO_MIN_SIMILARITY
    ):
        return False
    return not any(
        other["id"] != candidate["id"]
        and other["official"]
        and looks_censored(title, other["title"])
        for other in rivals
    )


def _save_suggestion_blocking(
    video_id: str,
    title: str,
    artist: str,
    candidate: dict,
    status: str = STATUS_SUGGESTED,
    evidence: Optional[dict] = None,
) -> bool:
    db = SessionLocal()
    try:
        exists = (
            db.query(CensorOverride.id)
            .filter(CensorOverride.source == "ytmusic", CensorOverride.external_id == video_id)
            .first()
        )
        if exists:
            return False
        row = CensorOverride(
            source="ytmusic",
            external_id=video_id,
            censored_title=title,
            censored_artist=artist,
            censored_key=censored_key(artist, title),
            original_id=candidate["id"],
            original_permalink=candidate["permalink"],
            original_title=candidate["title"],
            original_artist=candidate["artist"],
            original_duration=candidate["duration"],
            original_cover_url=candidate["cover_url"],
            status=status,
            score=candidate["score"],
            evidence=evidence,
        )
        db.add(row)
        if status == STATUS_CONFIRMED:
            db.flush()
            sync_library_titles(db, row)
        db.commit()
        return True
    except Exception:  # noqa: BLE001 — гонка двух воркеров на уникальном индексе
        db.rollback()
        return False
    finally:
        db.close()


# Сравнение звука (app/audio_compare.py): сколько лучших кандидатов качаем и
# сравниваем с записью каталога. Каждый — ~3 МБ с CDN SoundCloud и ~2 с CPU.
_AUDIO_CANDIDATES = 3
_MAX_AUDIO_BYTES = 30 * 1024 * 1024


async def _catalog_audio(video_id: str) -> tuple[Optional[str], Optional[str]]:
    """(путь к звуку, который играет у трека каталога; временный файл к удалению).

    Сравнивать надо именно то, что слышит пользователь: свою копию (диск или
    MinIO), иначе запись из Deezer — она первая в цепочке стрима. YouTube не
    трогаем: резолв с адресов сервера ловит bot-check.
    """
    import os
    import tempfile

    from app import storage
    from app.routers import deezer, ytdlp

    path = ytdlp._cached_file(video_id)
    if path:
        return path, None
    archived = await ytdlp.archived_music_path(f"ytmusic/{video_id}")
    if archived:
        fd, tmp = tempfile.mkstemp(suffix=os.path.splitext(archived)[1] or ".m4a")
        os.close(fd)
        try:
            await asyncio.to_thread(storage.download_music_file, archived, tmp)
            return tmp, tmp
        except Exception:  # noqa: BLE001 — сравнение best-effort
            logger.warning("censor check: archive download failed for %s", video_id, exc_info=True)
            _remove(tmp)
    if deezer.enabled():
        sng_id = await deezer.await_deezer_match(video_id)
        if sng_id:
            path = await deezer.fetch_to_cache(video_id, sng_id)
            if path:
                return path, None
    return None, None


async def _soundcloud_audio(candidate: dict) -> Optional[str]:
    """Временный файл со звуком кандидата или None.

    Звук качается напрямую с CDN SoundCloud, без прокси (trust_env=False — и
    мимо переменных окружения): ссылка к IP не привязана, а платный выход
    на мегабайты аудио тратить незачем.
    """
    import os
    import tempfile

    import httpx

    from app.routers import soundcloud

    try:
        url, ext, _total, _fresh = await soundcloud._resolve_cached(
            candidate["id"], candidate["permalink"]
        )
    except Exception:  # noqa: BLE001 — HLS-only/DRM/сбой резолва: кандидат пропускается
        logger.info("censor check: soundcloud %s not resolvable", candidate["id"])
        return None
    fd, tmp = tempfile.mkstemp(suffix=ext or ".mp3")
    os.close(fd)
    written = 0
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(30.0, connect=10.0), follow_redirects=True, trust_env=False
        ) as client:
            async with client.stream("GET", url) as response:
                response.raise_for_status()
                with open(tmp, "wb") as fh:
                    async for chunk in response.aiter_bytes():
                        written += len(chunk)
                        if written > _MAX_AUDIO_BYTES:
                            raise RuntimeError("слишком большой файл")
                        fh.write(chunk)
        return tmp
    except Exception:  # noqa: BLE001
        logger.warning("censor check: soundcloud %s download failed", candidate["id"], exc_info=True)
        _remove(tmp)
        return None


def _remove(path: Optional[str]) -> None:
    import os

    if path:
        try:
            os.remove(path)
        except OSError:
            pass


async def compare_with_candidates(
    video_id: str, candidates: list[dict], report: Optional[dict] = None
) -> tuple[Optional[dict], Optional[Any]]:
    """Сравнивает звук трека каталога с лучшими кандидатами.

    (кандидат, сравнение): verdict censored — найден оригинал; same — трек
    каталога не цензурный (кандидат — та же запись без отличий); (None, None)
    — сравнить не получилось или ни один кандидат не той же записи.
    """
    from app import audio_compare

    report = report if report is not None else {}
    comparisons = report.setdefault("comparisons", [])
    if not candidates:
        return None, None
    if not await asyncio.to_thread(audio_compare.available):
        report["problem"] = "fpcalc не установлен"
        return None, None
    catalog, catalog_tmp = await _catalog_audio(video_id)
    if not catalog:
        report["problem"] = "нет звука трека каталога (ни своей копии, ни Deezer)"
        return None, None
    try:
        for candidate in candidates[:_AUDIO_CANDIDATES]:
            entry = {"id": candidate["id"], "title": candidate["title"], "uploader": candidate["uploader"]}
            comparisons.append(entry)
            audio = await _soundcloud_audio(candidate)
            if not audio:
                entry["verdict"] = "не скачался"
                continue
            try:
                result = await asyncio.to_thread(audio_compare.compare, catalog, audio)
            finally:
                _remove(audio)
            if result is None:
                entry["verdict"] = "не сравнился"
                continue
            entry.update(result.as_dict())
            logger.info(
                "censor check: ytmusic %s vs soundcloud %s → %s",
                video_id, candidate["id"], result.as_dict(),
            )
            if result.verdict == "censored":
                return candidate, result
            # Совпал залив самого артиста — значит, каталог и есть оригинал.
            # Совпавший перезалив мог быть залит уже с цензурной версии —
            # смотрим следующих кандидатов.
            if result.verdict == "same" and candidate["official"]:
                return candidate, result
    finally:
        _remove(catalog_tmp)
    return None, None


async def suggest_for_video(video_id: str, report: Optional[dict] = None) -> Optional[dict]:
    """Ищет оригинал для ytmusic-трека и привязывает его, если уверен.

    Главный способ — сравнение звука (compare_with_candidates): «та же запись,
    но с заглушёнными участками» привязывается сразу, «та же запись без
    отличий» — трек не цензурный. Если сравнить нечем (нет звука каталога,
    кандидаты не скачались), остаются метаданные: auto_confirmable или
    подсказка админу.

    report — что выяснилось по шагам (для ручной проверки из админки и
    срока следующей фоновой): outcome — итог, см. CONCLUSIVE_OUTCOMES.
    """
    report = report if report is not None else {}
    by_id, _by_key = await confirmed_overrides()
    if video_id in by_id:
        report["outcome"] = "already"
        return None
    from app.routers.deezer import _ytmusic_meta_blocking

    meta = await asyncio.to_thread(_ytmusic_meta_blocking, video_id)
    if not meta:
        report["outcome"] = "no_meta"
        return None
    title, artist, duration = meta
    report.update(title=title, artist=artist, duration=duration)
    if not _CYRILLIC.search(f"{title} {artist}"):
        report["outcome"] = "not_russian"
        return None
    async with _suggest_sem:
        candidates = await find_candidates(title, artist, duration)
        report["candidates"] = len(candidates)
        matched, comparison = await compare_with_candidates(video_id, candidates, report)
    if comparison is not None and comparison.verdict == "same":
        report["outcome"] = "clean"
        return None
    if comparison is not None:
        best, status, evidence = matched, STATUS_CONFIRMED, comparison.as_dict()
    else:
        best = next(
            (c for c in candidates if c["official"] and looks_censored(title, c["title"])),
            None,
        )
        if best is None:
            if not candidates:
                report["outcome"] = "no_candidates"
            elif report.get("problem") or not any(
                c.get("verdict") in _COMPARED for c in report.get("comparisons", [])
            ):
                report["outcome"] = "audio_failed"
            else:
                report["outcome"] = "not_found"
            return None
        status = STATUS_CONFIRMED if auto_confirmable(title, duration, best, candidates) else STATUS_SUGGESTED
        evidence = None
    report["outcome"] = "linked" if status == STATUS_CONFIRMED else "suggested"
    report["original"] = {"id": best["id"], "title": best["title"], "uploader": best["uploader"]}
    if await asyncio.to_thread(
        _save_suggestion_blocking, video_id, title, artist, best, status, evidence
    ):
        if status == STATUS_CONFIRMED:
            invalidate()
        logger.info(
            "censor %s: ytmusic %s (%s — %s) → soundcloud %s (%s)%s",
            "auto-link" if status == STATUS_CONFIRMED else "suggestion",
            video_id, artist, title, best["id"], best["title"],
            " by audio" if evidence else "",
        )
    return best


# Версия проверки в ключе флага: улучшенная проверка (сравнение звука) должна
# пересмотреть треки, которые старая уже пометила проверенными на месяц.
_CHECK_VERSION = 2
# Итоги, после которых трек не трогаем _SUGGEST_CHECK_TTL. Остальные (нет
# кандидатов, звук не скачался) — сбои окружения: повтор через _RETRY_CHECK_TTL.
CONCLUSIVE_OUTCOMES = {"already", "not_russian", "clean", "linked", "suggested", "not_found"}
_RETRY_CHECK_TTL = 6 * 3600
# Вердикты, при которых сравнение реально состоялось (см. audio_compare).
_COMPARED = {"censored", "same", "different", "uncertain"}


def _checked_key(video_id: str) -> str:
    return f"censor:checked:v{_CHECK_VERSION}:{video_id}"


def schedule_suggestion(video_id: str) -> None:
    """Фоновая проверка трека на цензуру при прослушивании (раз в месяц)."""
    if not video_id or video_id in _suggest_inflight:
        return

    async def job():
        flag = _checked_key(video_id)
        try:
            if await get_cache_async(flag):
                return
            # Сразу — короткий флаг: пока проверка идёт, другие прослушивания
            # её не дублируют, а упавшая повторится скоро, а не через месяц.
            await set_cache_async(flag, 1, expire=_RETRY_CHECK_TTL)
            report: dict = {}
            await suggest_for_video(video_id, report)
            if report.get("outcome") in CONCLUSIVE_OUTCOMES:
                await set_cache_async(flag, 1, expire=_SUGGEST_CHECK_TTL)
            logger.info("censor check %s: %s", video_id, report)
        except Exception:  # noqa: BLE001 — фон, стрим его не ждёт
            logger.warning("censor suggestion failed for %s", video_id, exc_info=True)
        finally:
            _suggest_inflight.discard(video_id)

    _suggest_inflight.add(video_id)
    asyncio.create_task(job())


# ---------------------------------------------------------------------------
# Изменения из админки
# ---------------------------------------------------------------------------


def original_fields(item: dict) -> dict:
    """Поля оригинала для CensorOverride из объекта трека api-v2."""
    from app.routers import soundcloud
    from app.routers.ytdlp import clean_title

    artist, title = soundcloud._api_artist_title(item)
    return {
        "original_id": str(item["id"]),
        "original_permalink": item.get("permalink_url") or "",
        "original_title": clean_title(title),
        "original_artist": artist,
        "original_duration": round((item.get("duration") or 0) / 1000),
        "original_cover_url": soundcloud._upscale_artwork(
            item.get("artwork_url") or (item.get("user") or {}).get("avatar_url")
        ),
    }


def sync_library_titles(db, row: CensorOverride) -> None:
    """Записи библиотеки этого трека: название оригинала, пока привязка
    подтверждена, и цензурное обратно — когда её сняли."""
    active = row.status == STATUS_CONFIRMED
    for track in (
        db.query(Track)
        .filter(Track.source == row.source, Track.external_id == row.external_id)
        .all()
    ):
        track.title = row.original_title if active else row.censored_title
        if active and row.original_duration:
            track.duration = row.original_duration
