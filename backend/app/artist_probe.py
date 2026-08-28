"""Фоновая сверка «теоретически подходящих» артистов по косинусу.

Разведка потока (см. модульный docstring ``routers.flow``) устроена как
генераторы кандидатов: радио YT Music, граф похожих артистов, каталог любимого
артиста, SoundCloud, теги. Общего у них одно — они отдают ПУЛ, а выбор внутри
пула делает ранкер уже на общей модели, где новизна артиста лишь одно слагаемое
из десятка. Для доли разведки этого мало: в пул попадает шесть-восемь незнакомых
имён, ранкер сравнивает их треки поштучно, и наверх всплывает не тот артист,
который ближе ко вкусу, а тот, чей отдельный трек удачнее сложился по
популярности, свежести и контексту.

Здесь сравниваются САМИ АРТИСТЫ, и сравниваются целиком: у каждого кандидата
берётся его каталог, сворачивается в один вектор, и косинус к вектору вкуса
решает, кто из них ближе. Победитель отдаёт ровно ОДИН трек — тот, чей
собственный вектор ближе всех внутри уже выбранного каталога. Один, а не пул,
именно потому, что это добавка КАЧЕСТВА к доле разведки, а не ещё один источник
объёма: место в порции трек всё равно получает через общую модель (плюс
content_bonus за проверенную близость), фиксированной квоты у него нет.

Почему в фоне, а не в запросе: сравнение требует каталога каждого кандидата, то
есть до шести сетевых вызовов сверх тех, что поток делает и так. В запросе это
секунды ожидания на подгрузку, поэтому пик считается воркером по расписанию
(``main._artist_probe_loop``), кладётся в Redis, и ``get_flow`` читает готовый
ответ одним ``GET``.

Пространство сравнения — то, что у ВНЕШНЕГО кандидата реально есть: жанр
(наш ключ из ``genre_keywords``, за которым стоит и дерево beets), слова
названия из личного словаря юзера (``title_tags``) и письменность. Акустики
здесь нет намеренно: у трека провайдера её нет до локального архивирования, а
косинус по семи неотцентрированным 0..1 признакам всё равно вырождается (любые
два вектора в положительном октанте почти сонаправлены) — акустику считает
``acoustic_features.acoustic_similarity`` евклидовой метрикой уже в ранкере,
после того как пик попал в пул.
"""
from __future__ import annotations

import asyncio
import logging
import math
import os
from typing import Any, Iterable, Optional

from app.artist_utils import artist_key, effective_track_artist_title
from app.cache import get_cache_async, set_cache_async
from app.genre_keywords import infer_genre_from_text
from app.lang import is_cyrillic, is_foreign_script
from app.title_tags import extract_words

logger = logging.getLogger(__name__)

# Оси сравнения и их вес в векторе. Каждая ось нормируется по L1 отдельно (см.
# _axis_normalized), поэтому вес — это доля оси в длине вектора, а не множитель
# к сырому счётчику: юзер с тремя прослушиваниями и юзер с тремя тысячами
# сравниваются по РАСПРЕДЕЛЕНИЮ, а не по объёму истории.
#
# Жанр — единственный признак, который у внешнего трека бывает и заявленным, и
# выводимым из названия, поэтому он главный. Слова названия точнее жанра, но
# добываются статистически и у половины юзеров их нет вовсе. Письменность —
# грубый прокси (см. lang.dominant_is_cyrillic), но на пустых genre-метаданных
# провайдеров это единственный сильный сигнал, который вообще есть.
_AXIS_WEIGHTS = {"g": 1.0, "t": 0.6, "s": 0.5}

# Сколько артистов вкуса засеваем в граф похожести за проход. Соседи берутся
# у самых весомых имён: у графа YT Music похожесть тем осмысленнее, чем
# увереннее сид.
PROBE_SEED_ARTISTS = 3
# Сколько НОВЫХ имён доходит до сравнения. Каталог каждого — отдельный сетевой
# вызов (кэш общий на всех юзеров), поэтому это и есть цена прохода.
PROBE_ARTISTS = 6
# Артист с одним-двумя найденными треками не сравнивается: его «каталог» — это
# случайная пара названий, и вектор по ним говорит о выдаче провайдера, а не об
# артисте.
PROBE_MIN_TRACKS = 3
# Ниже этого косинуса лучший из кандидатов — всё ещё не тот, кого стоит
# подкладывать в разведку. Пустой пик честнее случайного: поток и без него
# работает ровно как раньше.
PROBE_MIN_SIMILARITY = 0.35
# Пик живёт заметно дольше интервала воркера: смена лидера или недоступный
# провайдер не должны стирать уже посчитанную подсказку.
PROBE_TTL = 6 * 60 * 60
# Сколько имён кладём в payload для наблюдаемости: по ним видно, ЧТО с чем
# сравнивалось, когда пик кажется странным.
PROBE_RANKING_LOG = 5

_PAYLOAD_VERSION = 1


def probe_key(user_id: int) -> str:
    """Redis-ключ пика для юзера."""
    return f"flow:probe:v{_PAYLOAD_VERSION}:{user_id}"


def _axis_normalized(raw: dict[str, float]) -> dict[str, float]:
    """Сырые счётчики термов → вектор, где каждая ось весит своё.

    Нормируем ОСЬ, а не вектор целиком: иначе юзер с восемью тегами и двумя
    жанрами оказывался бы «на 80% из слов названий» просто потому, что термов в
    этой оси больше.
    """
    totals: dict[str, float] = {}
    for term, value in raw.items():
        if value <= 0:
            continue
        axis = term.split(":", 1)[0]
        totals[axis] = totals.get(axis, 0.0) + value

    vector: dict[str, float] = {}
    for term, value in raw.items():
        if value <= 0:
            continue
        axis = term.split(":", 1)[0]
        weight = _AXIS_WEIGHTS.get(axis, 0.0)
        total = totals.get(axis, 0.0)
        if weight <= 0.0 or total <= 0.0:
            continue
        vector[term] = weight * value / total
    return vector


def _genre_term(raw: Any) -> str:
    """Жанр (заявленный где угодно) → терм в ЕДИНОМ словаре.

    По обе стороны косинуса жанры приходят по-разному: у вкуса это сырые
    строки (``Track.genre`` провайдера и жанры из настроек юзера, см.
    ``flow._taste_profile``), у кандидата — либо такая же сырая строка, либо
    внутренний ключ, выведенный из названия. Без общей нормализации «Dark Trap»
    у юзера и «trap» у кандидата были бы РАЗНЫМИ термами, и косинус между
    очевидно близкими вкусом и каталогом получался бы нулевым.

    ``infer_genre_from_text`` сводит к нашим двенадцати ключам (и заглядывает в
    дерево beets). Не свёлся — оставляем строку как есть: два «indie» всё ещё
    совпадут друг с другом, а на длину вектора неразрешённый жанр влияет
    честно, как непопавшая доля вкуса.
    """
    text = str(raw or "").strip()
    if not text:
        return ""
    return infer_genre_from_text(text) or text.lower()


def taste_vector(profile: dict) -> dict[str, float]:
    """Вектор вкуса из профиля потока (``flow._taste_profile``)."""
    raw: dict[str, float] = {}

    for genre, count in (profile.get("genre_counts") or {}).items():
        try:
            weight = float(count)
        except (TypeError, ValueError):
            continue
        term = _genre_term(genre)
        if term and weight > 0:
            # Разные сырые написания сводятся в один ключ — счётчики складываем.
            raw[f"g:{term}"] = raw.get(f"g:{term}", 0.0) + weight

    # В профиле от тегов остаются только КЛЮЧИ, но порядок в нём — по убыванию
    # веса (см. title_tags.build_title_tag_profile), и выбрасывать эту
    # информацию не за что: линейное затухание по позиции сохраняет ранг, не
    # притворяясь, что мы знаем исходные веса.
    tags = [str(tag).strip().lower() for tag in (profile.get("title_tags") or []) if tag]
    for position, tag in enumerate(tags):
        raw[f"t:{tag}"] = float(len(tags) - position)

    prefer_cyrillic = profile.get("prefer_cyrillic")
    if prefer_cyrillic is True:
        raw["s:cyr"] = 1.0
    elif prefer_cyrillic is False:
        raw["s:lat"] = 1.0
    # None — вкус смешанный: оси у юзера нет, и у кандидатов её тоже не будет
    # (см. track_terms), иначе письменность решала бы за юзера, который сам
    # ничего о ней не сказал.

    return _axis_normalized(raw)


def track_terms(
    artist: str,
    title: str,
    genre: Optional[str] = None,
    *,
    tag_vocabulary: Optional[set] = None,
    script_axis: bool = True,
) -> dict[str, float]:
    """Термы ОДНОГО трека: присутствие признака, без веса.

    ``tag_vocabulary`` — личный словарь юзера. Слова названия за его пределами
    отбрасываются намеренно: словарь уже очищен от шумовых слов формата
    (``title_tags._STOPWORDS``), и любое слово вне него всё равно не с чем
    сравнивать. Промах при этом не бесплатный — у артиста, ни одним словом не
    попавшего в словарь, оси ``t:`` не будет вовсе, а вкус свою долю в длине
    вектора сохранит, так что косинус упадёт. Это и есть штраф за «не про то».
    """
    terms: dict[str, float] = {}

    # Заявленный жанр — через тот же _genre_term, что и у вкуса; выведенный из
    # названия уже внутренний ключ.
    for value in (_genre_term(genre), infer_genre_from_text(title, artist)):
        if value:
            terms[f"g:{value}"] = 1.0

    if tag_vocabulary:
        for word in set(extract_words(title)):
            if word in tag_vocabulary:
                terms[f"t:{word}"] = 1.0

    if script_axis:
        text = f"{title} {artist}"
        if is_foreign_script(text):
            terms["s:foreign"] = 1.0
        elif is_cyrillic(text):
            terms["s:cyr"] = 1.0
        else:
            terms["s:lat"] = 1.0

    return terms


def track_vector(
    track: Any,
    *,
    tag_vocabulary: Optional[set] = None,
    script_axis: bool = True,
) -> dict[str, float]:
    """Один трек в том же пространстве, что и вкус (для выбора внутри каталога)."""
    artist, title = effective_track_artist_title(track)
    if not title:
        return {}
    return _axis_normalized(
        track_terms(
            artist,
            title,
            getattr(track, "genre", None),
            tag_vocabulary=tag_vocabulary,
            script_axis=script_axis,
        )
    )


def artist_vector(
    tracks: Iterable[Any],
    *,
    tag_vocabulary: Optional[set] = None,
    script_axis: bool = True,
) -> dict[str, float]:
    """Каталог артиста → один вектор в том же пространстве, что и вкус.

    Складываем термы всех треков, а нормировка оси доводит их до частоты: у
    артиста, у которого фонком названа половина каталога, ``g:phonk`` весит
    ровно половину жанровой оси.
    """
    raw: dict[str, float] = {}
    counted = 0
    for track in tracks:
        artist, title = effective_track_artist_title(track)
        if not title:
            continue
        counted += 1
        terms = track_terms(
            artist,
            title,
            getattr(track, "genre", None),
            tag_vocabulary=tag_vocabulary,
            script_axis=script_axis,
        )
        for term, value in terms.items():
            raw[term] = raw.get(term, 0.0) + value
    if not counted:
        return {}
    return _axis_normalized(raw)


def cosine_similarity(left: dict, right: dict) -> float:
    """Косинус между разреженными векторами, 0..1."""
    if not left or not right:
        return 0.0
    shared = set(left) & set(right)
    if not shared:
        return 0.0
    dot = sum(left[term] * right[term] for term in shared)
    if dot <= 0.0:
        return 0.0
    norm = math.sqrt(sum(value * value for value in left.values())) * math.sqrt(
        sum(value * value for value in right.values())
    )
    if norm <= 0.0:
        return 0.0
    return max(0.0, min(1.0, dot / norm))


def cosine_distance(left: dict, right: dict) -> float:
    """Косинусное расстояние: 0 — совпадение, 1 — ортогональные векторы."""
    return 1.0 - cosine_similarity(left, right)


def _playable(track: Any) -> bool:
    """Трек можно будет проиграть, когда поток отдаст его клиенту?

    Та же проверка, что в ``flow._add_explore``: ytmusic без external_id и
    soundcloud без stream_url не играются, и подкладывать их как «самый
    подходящий» бессмысленно.
    """
    source = getattr(track, "source", "") or ""
    if source == "ytmusic":
        return bool(getattr(track, "external_id", ""))
    if source == "soundcloud":
        return bool(getattr(track, "stream_url", ""))
    return bool(getattr(track, "external_id", ""))


def _identity(track: Any) -> str:
    source = getattr(track, "source", "") or ""
    external_id = getattr(track, "external_id", "") or ""
    return f"{source}:{external_id}"


async def candidate_artists(
    profile: dict,
    *,
    seeds: int = PROBE_SEED_ARTISTS,
    limit: int = PROBE_ARTISTS,
) -> list[dict]:
    """Незнакомые имена из графа похожести — «теоретически подходящие».

    Теоретически — потому что похожесть здесь чужая (граф YT Music) и про
    отдельного артиста ничего не доказывает; доказывает косинус ниже.

    Импорт ``routers.flow`` отложенный: обратную сторону этого модуля читает
    сам flow, и на уровне модуля вышел бы цикл.
    """
    from app.routers import flow

    # Новизна меряется по всем слышанным именам (см. heard_artist_keys в
    # _taste_profile): раз прослушанный артист новым уже не считается.
    # artist_weight — fallback для профилей, собранных до разделения понятий.
    familiar = set(profile.get("artist_weight") or {}) | set(
        profile.get("heard_artist_keys") or []
    )
    banned = set(profile.get("banned_artists") or set())
    seed_names = [name for name in (profile.get("artists") or []) if name][:seeds]
    if not seed_names:
        return []

    graphs = await asyncio.gather(
        *(flow._similar_artist_names(name) for name in seed_names),
        return_exceptions=True,
    )

    candidates: list[dict] = []
    seen: set = set()
    for graph in graphs:
        if isinstance(graph, BaseException):
            # Сосед не ответил — сравниваем тех, кто ответил. Разведка и так
            # резервный путь: пустой пик хуже неполного сравнения.
            logger.debug("artist probe: similar names failed", exc_info=graph)
            continue
        for entry in graph or []:
            name = (entry or {}).get("name") or ""
            browse_id = (entry or {}).get("browse_id") or ""
            key = artist_key(name)
            if not name or not browse_id or key in seen:
                continue
            # Знакомого артиста сравнивать не с чем: доля разведки — про новые
            # имена, а знакомые и так приходят своим каталогом.
            if key in familiar or key in banned:
                continue
            seen.add(key)
            candidates.append({"name": name, "browse_id": browse_id})
    return candidates[:limit]


async def compare_artists(
    profile: dict,
    candidates: list[dict],
    *,
    exclude_identities: Optional[set] = None,
) -> Optional[dict]:
    """Сравнить кандидатов по косинусу и выбрать ОДИН трек победителя.

    Возвращает payload (или None, когда сравнивать нечего): сам трек, имя
    артиста, косинусная близость и расстояние — и по обоим краям, артиста и
    трека, потому что это разные величины: артист выбирается каталогом целиком,
    трек — внутри уже выбранного каталога.
    """
    from app.routers import flow

    user_vector = taste_vector(profile)
    if not user_vector:
        # Вкуса ещё нет (холодный старт) — сравнивать не с чем, и любой
        # «самый подходящий» был бы случайным.
        return None
    if not candidates:
        return None

    tag_vocabulary = {
        str(tag).strip().lower() for tag in (profile.get("title_tags") or []) if tag
    }
    script_axis = profile.get("prefer_cyrillic") is not None
    excluded = set(exclude_identities or ())

    pools = await asyncio.gather(
        *(flow._artist_songs_pool(entry["browse_id"]) for entry in candidates),
        return_exceptions=True,
    )

    ranking: list[dict] = []
    best: Optional[tuple[float, dict, list]] = None
    for entry, pool in zip(candidates, pools):
        if isinstance(pool, BaseException):
            logger.debug(
                "artist probe: catalogue failed for %s", entry["name"], exc_info=pool
            )
            continue
        own = artist_key(entry["name"])
        tracks = [
            track
            for track in pool or []
            if _playable(track)
            and _identity(track) not in excluded
            # Страница артиста отдаёт и фиты, где он не главный. Сравниваем
            # именно этого артиста, поэтому чужие треки в его вектор не идут.
            and artist_key(effective_track_artist_title(track)[0]) == own
        ]
        if len(tracks) < PROBE_MIN_TRACKS:
            continue
        vector = artist_vector(
            tracks, tag_vocabulary=tag_vocabulary, script_axis=script_axis
        )
        if not vector:
            continue
        similarity = cosine_similarity(user_vector, vector)
        ranking.append(
            {
                "artist": entry["name"],
                "similarity": round(similarity, 4),
                "distance": round(1.0 - similarity, 4),
                "tracks": len(tracks),
            }
        )
        if best is None or similarity > best[0]:
            best = (similarity, entry, tracks)

    ranking.sort(key=lambda row: -row["similarity"])
    if best is None:
        return None

    artist_similarity, entry, tracks = best
    if artist_similarity < PROBE_MIN_SIMILARITY:
        # Сравнение состоялось, пика нет. Ranking всё равно возвращаем: по нему
        # видно, что воркер работал, а близких имён просто не нашлось.
        return {
            "track": None,
            "artist": entry["name"],
            "similarity": round(artist_similarity, 4),
            "distance": round(1.0 - artist_similarity, 4),
            "ranking": ranking[:PROBE_RANKING_LOG],
        }

    # Внутри победившего каталога — тот трек, чей собственный вектор ближе.
    # Порядок провайдера (популярность на площадке) остаётся тай-брейком: при
    # равном косинусе незнакомое имя стоит представлять тем, чем оно известно.
    scored = [
        (
            cosine_similarity(
                user_vector,
                track_vector(
                    track, tag_vocabulary=tag_vocabulary, script_axis=script_axis
                ),
            ),
            -position,
            track,
        )
        for position, track in enumerate(tracks)
    ]
    track_similarity, _order, track = max(scored, key=lambda row: (row[0], row[1]))

    return {
        "track": track.model_dump(),
        "artist": entry["name"],
        "similarity": round(artist_similarity, 4),
        "distance": round(1.0 - artist_similarity, 4),
        "track_similarity": round(track_similarity, 4),
        "track_distance": round(1.0 - track_similarity, 4),
        "ranking": ranking[:PROBE_RANKING_LOG],
    }


async def cached_pick(user_id: int):
    """Готовый пик для ``get_flow`` — один Redis GET, без сети.

    Возвращает ``ExternalTrackResponse`` или None. Битый/старый payload — это
    None, а не исключение: поток обязан работать и без подсказки.
    """
    from app.schemas import ExternalTrackResponse

    payload = await get_cache_async(probe_key(user_id))
    if not isinstance(payload, dict):
        return None
    raw = payload.get("track")
    if not isinstance(raw, dict):
        return None
    try:
        return ExternalTrackResponse(**raw)
    except Exception:  # noqa: BLE001 — форма payload могла измениться между релизами
        logger.debug("artist probe: unusable payload for user=%s", user_id)
        return None


def _taste_profile_for(user_id: int) -> Optional[dict]:
    """Профиль вкуса в своей короткой сессии (блокирующая, для to_thread).

    Сессия закрывается здесь же: дальше идут секунды сетевых ожиданий, и
    держать на них соединение из пула нельзя (та же причина, по которой
    ``get_flow`` закрывает свою сессию перед разведкой).
    """
    from app.database import SessionLocal
    from app.routers.flow import _taste_profile

    db = SessionLocal()
    try:
        return _taste_profile(db, user_id)
    except Exception:  # noqa: BLE001
        logger.exception("artist probe: taste profile failed user=%s", user_id)
        return None
    finally:
        db.close()


def active_user_ids(*, days: int, limit: int) -> list[int]:
    """Кого сравнивать: юзеры, слушавшие хоть что-то за последние ``days``.

    Пик нужен только тому, кто откроет поток, а профиль вкуса — самая дорогая
    часть прохода. Порядок — по свежести активности: если лимит меньше числа
    активных, обслуживаем тех, кто слушает сейчас.
    """
    from datetime import datetime, timedelta, timezone

    from sqlalchemy import func, select

    from app.database import SessionLocal
    from app.models import user_play_events

    # Границу считаем в Python, а не в SQL: INTERVAL и DATE_SUB диалектны, а
    # тесты ходят по sqlite.
    cutoff = datetime.now(timezone.utc) - timedelta(days=max(1, days))
    db = SessionLocal()
    try:
        last_played = func.max(user_play_events.c.played_at).label("last_played")
        rows = db.execute(
            select(user_play_events.c.user_id, last_played)
            .where(user_play_events.c.played_at >= cutoff)
            .group_by(user_play_events.c.user_id)
            .order_by(last_played.desc())
            .limit(limit)
        ).all()
        return [int(row[0]) for row in rows if row[0] is not None]
    except Exception:  # noqa: BLE001 — на старой схеме таблицы может не быть
        logger.debug("artist probe: active users unavailable", exc_info=True)
        return []
    finally:
        db.close()


async def probe_user(user_id: int) -> Optional[dict]:
    """Один проход по одному юзеру: сравнить артистов и запомнить пик."""
    profile = await asyncio.to_thread(_taste_profile_for, user_id)
    if not profile:
        return None

    previous = await get_cache_async(probe_key(user_id))
    excluded: set = set()
    if isinstance(previous, dict) and isinstance(previous.get("track"), dict):
        # Прошлый пик исключаем из нового: поток берёт трек один раз, и без
        # этого воркер бесконечно предлагал бы одну и ту же песню — она же
        # остаётся самой близкой.
        raw = previous["track"]
        excluded.add(f"{raw.get('source') or ''}:{raw.get('external_id') or ''}")

    candidates = await candidate_artists(profile)
    payload = await compare_artists(
        profile, candidates, exclude_identities=excluded
    )
    if payload is None:
        return None

    await set_cache_async(probe_key(user_id), payload, expire=PROBE_TTL)
    if payload.get("track"):
        logger.info(
            "artist probe user=%s artist=%s distance=%.3f track=%s compared=%d",
            user_id,
            payload["artist"],
            payload["distance"],
            payload["track"].get("title"),
            len(payload.get("ranking") or []),
        )
    else:
        logger.debug(
            "artist probe user=%s no pick: closest=%s distance=%.3f",
            user_id,
            payload.get("artist"),
            payload.get("distance", 1.0),
        )
    return payload


async def refresh_probes(
    *,
    users: Optional[Iterable[int]] = None,
    days: Optional[int] = None,
    limit: Optional[int] = None,
) -> int:
    """Проход воркера. Возвращает число юзеров, которым посчитан НОВЫЙ трек."""
    if users is None:
        days = days if days is not None else int(
            os.getenv("ARTIST_PROBE_ACTIVE_DAYS", "14")
        )
        limit = limit if limit is not None else int(
            os.getenv("ARTIST_PROBE_USERS", "25")
        )
        user_ids = await asyncio.to_thread(active_user_ids, days=days, limit=limit)
    else:
        user_ids = list(users)

    picked = 0
    for user_id in user_ids:
        try:
            payload = await probe_user(user_id)
        except Exception:  # noqa: BLE001 — один юзер не должен ронять проход
            logger.exception("artist probe failed user=%s", user_id)
            continue
        if payload and payload.get("track"):
            picked += 1
    return picked
