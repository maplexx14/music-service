from fastapi import APIRouter, Depends, Query, HTTPException, Request
from sqlalchemy.orm import Session
from sqlalchemy import func, desc, or_, select, union
from typing import List, Optional
from datetime import datetime, timezone
from collections import Counter
import asyncio
import math
import re
from app.database import get_db
from app.cache import get_cache, set_cache
from app.models import (
    Track,
    Playlist,
    User,
    user_track_plays,
    user_track_skips,
    playlist_tracks,
    user_play_events,
    rec_impressions,
    recommendation_events,
)
from app.schemas import (
    ExternalTrackResponse,
    RecommendationResponse,
    TrackResponse,
    PlaylistResponse,
    RecommendationEventPayload,
)
from app.dependencies import get_current_active_user
from app.genre_keywords import infer_genre_from_text, build_keyword_filters, top_genre_keywords
from app.lang import dominant_is_cyrillic, is_foreign_script
from app.taste import make_relevance_check, track_check
from app.title_tags import build_tag_filters, build_title_tag_profile
from app.artist_genre import artists_matching_keywords
from app.cooccurrence import pair_scores, similar_track_ids
from app.discovery import discovery_ratio
from app.recommendation_cache import (
    invalidate_recommendation_cache,
    recommendation_cache_key,
)
from app.diversity import cap_per_artist, interleave_artists, mmr, primary_artist_key, soft_artist_rerank
from app.artist_utils import (
    artist_key,
    effective_artist_title,
    effective_track_artist_title,
)
from app.recommendation_scoring import (
    ALGORITHM_VERSION,
    fatigue_score,
    score_track,
    stable_jitter,
)
from app.acoustic_features import (
    MIN_RECOMMENDATION_SIMILARITY,
    acoustic_similarity,
    weighted_centroid,
)
from app.playlist_signals import aggregate_playlist_origin
from app.context_profile import build_context_profile, context_bonus, hour_bucket
from app.recommendation_telemetry import (
    ALLOWED_EVENT_TYPES,
    new_request_id,
    record_delivery,
    record_event,
    record_impression,
)
from app.recommendation_evaluation import user_metrics
from app.routers import flow as flow_router

router = APIRouter()

# Рекомендации пересчитывать на каждый запрос дорого (несколько запросов с
# IN-списками и сортировками), а меняются они медленно — короткий кэш.
# Явные действия (лайк/скип) инвалидируют его сразу (см. tracks.py), TTL
# остаётся для пассивных прослушиваний.
_RECS_TTL = 300

# The home carousel must not be bounded by the materialized Track table.  Its
# external pool is intentionally smaller than Flow's because this endpoint is
# fetched during first paint, but it uses the same provider-backed retrieval
# primitives and caches. Acoustic data remains a reranking signal for local
# rows; playlist/history seeds provide catalogue coverage.
_EXTERNAL_SEED_TRACKS = 3
_EXTERNAL_ARTISTS = 4
_EXTERNAL_SIMILAR_ARTISTS = 2
_EXTERNAL_GENRES = 1
_EXTERNAL_POOL_FACTOR = 4

# Вес сигнала вкуса (лайк/прослушивание/скип) экспоненциально затухает со
# временем вместо жёсткого "топ-N" по позиции/play_count — иначе у активных
# пользователей более ранний, но всё ещё любимый артист резко выпадает из
# профиля, стоит наиграть чуть больше истории поверх него (см. аналогичный
# фикс в flow.py). Полураспад — раз в столько дней сигнал слабеет вдвое;
# лимит выборки — защита от неограниченного запроса, не смысловая отсечка.
_TASTE_HALF_LIFE_DAYS = 14.0
_TASTE_QUERY_LIMIT = 1000

# Сигналы КУРИРОВАНИЯ (лайки, треки в собственных плейлистах) затухают
# ГОРАЗДО медленнее поведенческих (прослушивания/скипы) и не ниже
# пола. Поведенческий сигнал естественно обновляется (слушаешь — дата
# свежеет), а трек в плейлист заново не «передобавляют»: старая дата
# добавления не значит, что трек разонравился. С общим 14-дневным
# полураспадом плейлисты месячной давности практически переставали
# влиять на рекомендации — их артисты не дотягивали до порога доверия.
_CURATION_HALF_LIFE_DAYS = 90.0
_CURATION_DECAY_FLOOR = 0.5

# Артист с таким числом КУРИРОВАННЫХ треков (лайк/плейлист) считается
# доверенным НЕЗАВИСИМО от давности и весов: юзер дважды осознанно
# добавил его треки в коллекцию — это явное предпочтение, а не случайность.
_CURATED_TRUST_COUNT = 2

# Минимум треков артиста в собственных плейлистах, с которого плейлист считается
# курированием ЭТОГО артиста. Зеркало _PLAYLIST_ARTIST_MIN_TRACKS в flow.py:
# импорт приводит сотни имён сразу, и каждое становилось любимым с первого
# трека. Ниже порога трек остаётся положительным сигналом (и держит артиста в
# scope_artist_keys), но кураторского веса и приоритета не даёт.
_PLAYLIST_ARTIST_MIN_TRACKS = 3
# Imported playlists are nearly as intentional as likes at the track level.
# Artist catalogue/trust expansion still uses the separate three-track gate.
_PLAYLIST_IMPORTED_WEIGHT = 3.0
_PLAYLIST_WEAK_WEIGHT = _PLAYLIST_IMPORTED_WEIGHT

# Сколько треков одного артиста максимум допускать подряд в выдаче — без
# этого сортировка по play_count раз за разом выдаёт одних и тех же
# нескольких самых заигранных артистов вкуса.
_MAX_PER_ARTIST = 2

# Порог, с которого артист считается «доверенным» по одному лишь
# ПОЛОЖИТЕЛЬНОМУ сигналу (лайк/плейлист/повторы), без учёта скипов. Равен
# весу одного явного лайка (3.0) — т.е. одного явного «Мне нравится» или
# нескольких повторных прослушиваний достаточно. У доверенного артиста скипы
# больше не режут весь каталог (см. ниже) — только сам скипнутый трек, и он и
# так исключается из выдачи. У ещё НЕ доверенного скипы сильно влияют: он
# попадает в сид, только если положительный сигнал перевешивает скипы.
# Ручные плейлистные треки достигают порога быстрее — но только у артиста,
# набравшего _PLAYLIST_ARTIST_MIN_TRACKS: иначе один трек из импорта сам по
# себе перекрывал порог и объявлял постороннее имя доверенным.
_ARTIST_TRUST_THRESHOLD = 3.0

# Насколько положительный сигнал должен ПЕРЕВЕШИВАТЬ скипы, чтобы недоверенный
# артист попал в сид. Строгого `> 0` не хватает: оба сигнала лог-масштабные и
# сходятся почти вплотную (2 прослушивания = 2.10 против 3 скипов = 2.08), так
# что заскипанный артист проходил с перевесом 0.02 и тянул за собой весь свой
# каталог. Требуем внятного перевеса, а не арифметической ничьей.
_NET_TRUST_MARGIN = 1.0

# --- Дослушивания (completion из user_play_events) ---
# Средняя доля дослушивания уточняет бинарный play/skip: стабильно
# дослушиваемый трек — более сильный плюс, стабильно бросаемый на 10-30% —
# мягкий минус, даже если явного скипа (<25% и переключил) не было.
_COMPLETION_HI = 0.85   # >= — усиливаем вес прослушиваний трека
_COMPLETION_LO = 0.30   # <= — ослабляем и слегка штрафуем артиста
_COMPLETION_HI_BOOST = 1.3
_COMPLETION_LO_DAMP = 0.5
_COMPLETION_LO_ARTIST_PENALTY = 0.75

# Штраф артисту за ЯВНЫЙ дизлайк трека (POST /tracks/{id}/dislike): весомее
# случайного скипа и не затухает со временем — осознанное «не нравится» не
# должно растворяться через две недели. Зеркало _DISLIKE_ARTIST_PENALTY в
# flow.py: движка два, шкала весов у них общая.
_DISLIKE_ARTIST_PENALTY = 3.5

# ``User.discovery_ratio`` — мягкий prior в общем score. Он не резервирует
# позиции, а помогает близкому по релевантности новому артисту подняться.

# Доля от score самого похожего соседа, ниже которой co-occurrence-сосед
# считается шумом. Матрица строится с _MIN_COMMON=1 (иначе на малой базе она
# пустая), поэтому в хвосте лежат пары, склеенные ОДНИМ случайным общим
# слушателем. У реального юзера-рэпера топ-сосед имел score ~33, а хвост
# 0.8-1.4 — именно оттуда в выдачу приходили Ace of Base и Men At Work.
_NEIGHBOR_SCORE_FLOOR = 0.05

# --- Показы (rec_impressions) ---
# Трек, показанный в рекомендациях столько раз и ни разу не сыгранный,
# выпадает из выдачи — иначе проигнорированные рекомендации возвращаются
# снова и снова, пока юзер не сыграет их «случайно».
_IMPRESSION_FATIGUE_THRESHOLD = 4

# --- Время суток ---
# Половина людей слушает разное утром и перед сном. События прослушивания в
# том же временном интервале, что текущий запрос (client_hour с фронта),
# дают артисту бонус — профиль мягко смещается к «вкусу этого времени дня».
def _hour_bucket(hour: Optional[int]) -> Optional[str]:
    return hour_bucket(hour)


def _varied_popular(
    db: Session,
    exclude_ids: set,
    need: int,
    keep=None,
    used: Optional[dict] = None,
    restrict_artists: Optional[set] = None,
    excluded_artists: Optional[set] = None,
    user_id: Optional[int] = None,
) -> list:
    """Случайная выборка из широкого пула популярного (без иностранного).
    Не фиксированный топ-N: у каждого юзера свой набор — и для холодного
    старта, и для добора тонкой выдачи, чтобы рекомендации были свои у
    каждого, а не один и тот же глобальный список.

    keep — предикат вкуса; передаётся, когда у юзера УЖЕ есть профиль. Без него
    этот путь был главной причиной нерелевантной выдачи: у слушателя русского
    рэпа он занимал большинство слотов глобальными хитами (Rick Astley, AC/DC,
    Hell March). При холодном старте keep нет — фильтровать нечем и не по чему.

    used — сколько мест артисты уже заняли в собираемой выдаче. Без него лимит
    считался с нуля на каждом пути отбора и они складывались: 2 трека из
    основного пула + 1 сосед + 2 отсюда = до 5 треков одного артиста.

    restrict_artists — артисты, по которым у юзера есть свой сигнал. Track.play_count
    ОБЩИЙ на всех юзеров (инкрементится на любом прослушивании любым юзером), а
    владельца у трека нет, поэтому «популярное сервиса» возглавляет тот, кто
    последним импортировал большой плейлист, и его библиотека ехала в выдачу
    остальным. Передаётся вместе с keep (т.е. когда профиль есть); на холодном
    старте скоупа нет и глобальное популярное остаётся единственным вариантом.
    """
    if need <= 0:
        return []
    q = db.query(Track)
    if restrict_artists:
        q = q.filter(
            or_(func.lower(Track.artist).in_(restrict_artists), Track.source == "soundcloud")
        )
    if excluded_artists:
        q = q.filter(
            or_(
                ~func.lower(Track.artist).in_(excluded_artists),
                Track.source == "soundcloud",
            )
        )
    if exclude_ids:
        q = q.filter(~Track.id.in_(exclude_ids))
    # С предикатом вкуса отсев жёстче, поэтому берём пул с большим запасом.
    window = max(need * (40 if keep else 5), 100)
    pool = [
        t
        for t in q.order_by(desc(Track.play_count)).limit(window).all()
        # Фильтр иностранного здесь и обещан docstring'ом, и нужен: холодный
        # старт не должен подсовывать стабильно скипаемые CJK/вьетнамские хиты.
        if (
            (not restrict_artists or artist_key(effective_track_artist_title(t)[0]) in restrict_artists)
            and (not excluded_artists or artist_key(effective_track_artist_title(t)[0]) not in excluded_artists)
            and not is_foreign_script(effective_track_artist_title(t)[1])
            and (keep is None or keep(t))
        )
    ]
    # Popularity is a bounded feature, not the ranking itself.  Freshness and
    # deterministic jitter keep a single global counter from monopolising the
    # fallback while still making cold start stable and reproducible.
    pool.sort(
        key=lambda t: (
            -score_track(t, user_id=user_id),
            stable_jitter(user_id, t.id),
            t.id,
        )
    )
    return cap_per_artist(pool, _MAX_PER_ARTIST, used=used)[:need]


def _cold_start_candidates(
    db: Session,
    *,
    preferred_genres: list[str],
    preferred_artists: list[str],
    excluded_artists: set[str],
    exclude_ids: set[int],
    limit: int,
    user_id: int,
) -> list[Track]:
    """Build a personalized first page before behavioral history exists."""
    if limit <= 0 or not (preferred_genres or preferred_artists):
        return []
    wanted_genres = {str(g).strip().lower() for g in preferred_genres if g}
    wanted_artists = {artist_key(a) for a in preferred_artists if artist_key(a)}
    filters = []
    if wanted_genres:
        filters.append(func.lower(Track.genre).in_(wanted_genres))
    if wanted_artists:
        filters.append(
            or_(func.lower(Track.artist).in_(wanted_artists), Track.source == "soundcloud")
        )
    if not filters:
        return []
    query = db.query(Track).filter(or_(*filters))
    if exclude_ids:
        query = query.filter(~Track.id.in_(exclude_ids))
    if excluded_artists:
        query = query.filter(
            or_(
                ~func.lower(Track.artist).in_(excluded_artists),
                Track.source == "soundcloud",
            )
        )
    pool = query.order_by(desc(Track.play_count), Track.id).limit(max(100, limit * 30)).all()
    filtered_pool = []
    for track in pool:
        effective_key = artist_key(effective_track_artist_title(track)[0])
        if effective_key in excluded_artists:
            continue
        genre_key = str(track.genre or "").strip().lower()
        if (
            track.source == "soundcloud"
            and wanted_artists
            and effective_key not in wanted_artists
            and genre_key not in wanted_genres
        ):
            continue
        filtered_pool.append(track)
    pool = filtered_pool
    pool.sort(
        key=lambda track: (
            -score_track(track, user_id=user_id, genres=preferred_genres, novelty=True),
            stable_jitter(user_id, track.id),
            track.id,
        )
    )
    return cap_per_artist(pool, _MAX_PER_ARTIST)[:limit]


def _rank_public_playlists(
    db: Session,
    *,
    current_user: User,
    preferred_genres: list[str] | None = None,
    preferred_artist_keys: set[str] | None = None,
    limit: int = 10,
) -> list[Playlist]:
    """Rank public playlists by taste overlap, engagement and freshness.

    Playlist recommendations used to be a newest-first list, which made the
    section unrelated to the track recommender and rewarded empty/new lists.
    We fetch a bounded pool with aggregates, then do the small overlap score in
    Python so the same code works on SQLite and PostgreSQL.
    """
    pool_limit = max(limit * 20, 100)
    rows = (
        db.query(
            Playlist,
            func.count(playlist_tracks.c.track_id).label("track_count"),
            func.coalesce(func.sum(Track.play_count), 0).label("engagement"),
            func.max(playlist_tracks.c.added_at).label("last_added"),
        )
        .outerjoin(playlist_tracks, playlist_tracks.c.playlist_id == Playlist.id)
        .outerjoin(Track, Track.id == playlist_tracks.c.track_id)
        .filter(Playlist.is_public.is_(True), Playlist.is_liked.is_(False))
        .group_by(Playlist.id)
        .order_by(Playlist.id)
        .limit(pool_limit)
        .all()
    )
    if not rows:
        return []

    playlist_ids = [playlist.id for playlist, *_ in rows]
    details = (
        db.query(
            playlist_tracks.c.playlist_id,
            Track.artist,
            Track.title,
            Track.album,
            Track.source,
            Track.genre,
        )
        .join(Track, Track.id == playlist_tracks.c.track_id)
        .filter(playlist_tracks.c.playlist_id.in_(playlist_ids))
        .all()
    )
    by_playlist: dict[int, list[tuple[str, str | None]]] = {}
    for playlist_id, artist, title, album, source, genre in details:
        effective_artist, _effective_title = effective_artist_title(
            title or "",
            artist or "",
            source=source or "",
            album=album or "",
        )
        by_playlist.setdefault(playlist_id, []).append((effective_artist, genre))

    wanted_genres = {str(value).strip().lower() for value in (preferred_genres or []) if value}
    wanted_artists = set(preferred_artist_keys or ())
    now = datetime.now(timezone.utc)

    def _playlist_score(row) -> tuple:
        playlist, track_count, engagement, last_added = row
        items = by_playlist.get(playlist.id, [])
        size = max(1, int(track_count or 0))
        artist_overlap = sum(
            1 for artist, _genre in items if artist_key(artist) in wanted_artists
        ) / size
        genre_overlap = sum(
            1
            for _artist, genre in items
            if genre and str(genre).strip().lower() in wanted_genres
        ) / size
        timestamp = last_added or playlist.updated_at or playlist.created_at
        if timestamp is None:
            freshness = 0.0
        else:
            if timestamp.tzinfo is None:
                timestamp = timestamp.replace(tzinfo=timezone.utc)
            freshness = math.exp(
                -max(0.0, (now - timestamp).total_seconds() / 86400.0) / 180.0
            )
        engagement_score = math.tanh(math.log1p(max(0, int(engagement or 0))) / 5.0)
        score = 2.2 * artist_overlap + 1.1 * genre_overlap + 0.45 * engagement_score + 0.25 * freshness
        return (-score, stable_jitter(current_user.id, f"playlist:{playlist.id}"), playlist.id)

    return [playlist for playlist, *_ in sorted(rows, key=_playlist_score)[:limit]]


def _decay(ts, half_life_days: float = _TASTE_HALF_LIFE_DAYS) -> float:
    if ts is None:
        return 1.0
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    age_days = max(0.0, (datetime.now(timezone.utc) - ts).total_seconds() / 86400)
    return 0.5 ** (age_days / half_life_days)


def _curation_decay(ts) -> float:
    """Затухание для сигналов курирования: медленное и с полом.
    Свежедобавленное всё ещё весомее старого (вкус дрейфует), но старое
    никогда не обнуляется — коллекция остаётся коллекцией."""
    return max(_CURATION_DECAY_FLOOR, _decay(ts, _CURATION_HALF_LIFE_DAYS))


async def _external_recommendation_pool(
    request: Request,
    *,
    liked: list,
    playlisted: list,
    played: list,
    preferred_artists: list[str],
    preferred_genres: list[str],
    limit: int,
    excluded_external: set[tuple[str, str]],
    excluded_track_keys: Optional[set[tuple[str, str]]] = None,
) -> list[ExternalTrackResponse]:
    """Retrieve provider candidates from the user's actual collection signals.

    This is deliberately a retrieval helper, not a second ranker.  Imported
    playlists can contain thousands of tracks while the local DB may only
    materialize a fraction of them; using their artist/title/genre seeds keeps
    recommendations useful before any acoustic backfill is complete.
    """
    seed_tracks: list[tuple[str, str]] = []
    seen_tracks: set[tuple[str, str]] = set()
    for track, _added_at in liked:
        seed_tracks.append(effective_track_artist_title(track))
    for track, _added_at, _origin in playlisted:
        seed_tracks.append(effective_track_artist_title(track))
    for track, _play_count, _last_played in played:
        seed_tracks.append(effective_track_artist_title(track))

    deduped_seeds = []
    for artist, title in seed_tracks:
        key = (artist_key(artist), str(title or "").strip().lower())
        if not key[0] or not key[1] or key in seen_tracks:
            continue
        seen_tracks.add(key)
        deduped_seeds.append((artist, title))
        if len(deduped_seeds) >= _EXTERNAL_SEED_TRACKS:
            break

    artist_seeds = list(preferred_artists)
    artist_seeds.extend(
        effective_track_artist_title(track)[0] for track, _added_at in liked
    )
    artist_seeds.extend(
        effective_track_artist_title(track)[0]
        for track, _added_at, _origin in playlisted
    )
    artist_seeds.extend(
        effective_track_artist_title(track)[0]
        for track, _play_count, _last_played in played
    )
    deduped_artists = []
    seen_artists = set()
    for artist in artist_seeds:
        key = artist_key(artist)
        if not key or key in seen_artists:
            continue
        seen_artists.add(key)
        deduped_artists.append(artist)
        if len(deduped_artists) >= _EXTERNAL_ARTISTS:
            break

    playlist_artist_counts = Counter(
        artist_key(effective_track_artist_title(track)[0])
        for track, _added_at, _origin in playlisted
    )
    manual_playlist_artists = {
        artist_key(effective_track_artist_title(track)[0])
        for track, _added_at, origin in playlisted
        if str(origin or "manual").lower() == "manual"
    }
    explicit_artist_keys = {artist_key(value) for value in preferred_artists}
    liked_artist_keys = {
        artist_key(effective_track_artist_title(track)[0])
        for track, _added_at in liked
    }

    # A manually curated playlist or a liked/preferred artist is an explicit
    # enough signal to browse its provider catalogue immediately. Imported
    # tracks carry the same track-level weight, but a single imported track gets
    # only track-level similarity; an artist catalogue/graph opens after three
    # imported tracks.
    catalog_artists = []
    similar_artists = []
    for artist in deduped_artists:
        key = artist_key(artist)
        is_curated = (
            key in explicit_artist_keys
            or key in liked_artist_keys
            or key in manual_playlist_artists
        )
        if is_curated or playlist_artist_counts.get(key, 0) >= 3:
            catalog_artists.append(artist)
        if (
            is_curated or playlist_artist_counts.get(key, 0) >= 3
        ) and len(similar_artists) < _EXTERNAL_SIMILAR_ARTISTS:
            similar_artists.append(artist)
        if len(catalog_artists) >= _EXTERNAL_ARTISTS:
            break

    jobs = []
    for artist, title in deduped_seeds:
        jobs.append(flow_router._lastfm_pool(request, artist, title))
    for artist in catalog_artists:
        jobs.append(flow_router._favorite_artist_pool(request, artist))
    for artist in similar_artists:
        jobs.append(flow_router._similar_pool(artist))
    for genre in list(dict.fromkeys(preferred_genres))[:_EXTERNAL_GENRES]:
        jobs.append(flow_router._tag_pool(request, genre))
    if not jobs:
        return []

    pools = await asyncio.gather(*jobs, return_exceptions=True)
    result: list[ExternalTrackResponse] = []
    seen: set[str] = set()
    seen_track_keys = set(excluded_track_keys or ())
    base_url = str(request.base_url).rstrip("/")
    for pool in pools:
        if isinstance(pool, Exception):
            continue
        for item in pool:
            identity = f"{item.source}:{item.external_id}"
            key = (item.source, item.external_id)
            track_key = flow_router._norm_key(
                *effective_track_artist_title(item)
            )
            if identity in seen or key in excluded_external:
                continue
            if track_key in seen_track_keys and all(track_key):
                continue
            if item.source == "ytmusic" and item.external_id and not item.stream_url:
                item.stream_url = f"{base_url}/api/ytdlp/stream/{item.external_id}"
            seen.add(identity)
            if all(track_key):
                seen_track_keys.add(track_key)
            result.append(item)
            if len(result) >= max(limit * _EXTERNAL_POOL_FACTOR, limit):
                return result
    return result


def _collection_exclude_select(user_id: int):
    """Вся коллекция юзера (плейлисты, включая «Понравившиеся», повторные
    прослушивания) плюс скипнутое — единым UNION-подзапросом.

    Раньше исключение шло литеральным `id IN (сотни значений)` в тексте
    запроса; подзапрос Postgres планирует как anti-join по индексам — дешевле
    и не раздувает SQL."""
    own_playlists = (
        select(playlist_tracks.c.track_id)
        .select_from(
            playlist_tracks.join(Playlist, Playlist.id == playlist_tracks.c.playlist_id)
        )
        .where(Playlist.owner_id == user_id)
    )
    plays = select(user_track_plays.c.track_id).where(
        user_track_plays.c.user_id == user_id,
        user_track_plays.c.play_count >= 2,
    )
    skips = select(user_track_skips.c.track_id).where(
        user_track_skips.c.user_id == user_id
    )
    return union(own_playlists, plays, skips)


@router.get("/", response_model=RecommendationResponse)
async def get_recommendations(
    request: Request,
    limit: int = 20,
    hour: Optional[int] = Query(None, ge=0, le=23),
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    # hour — локальный час клиента (таймзона юзера серверу неизвестна).
    # Кэш сегментируем по временному интервалу: утренняя и вечерняя выдачи
    # различаются и не должны перетирать друг друга.
    request_id = new_request_id()
    ranking_now = datetime.now(timezone.utc)
    bucket = _hour_bucket(hour)
    cache_key = recommendation_cache_key(current_user.id, limit, bucket)
    cached = get_cache(cache_key)
    if cached is not None:
        # A cached candidate list is reusable, but a delivery is not.  Give
        # every response its own request id/positions so feedback can be
        # attributed to the actual viewport session rather than the cache fill.
        cached_payload = dict(cached)
        cached_tracks = []
        cached_scores = {}
        for position, item in enumerate(cached_payload.get("tracks", [])):
            item = dict(item)
            item.update(
                {
                    "recommendation_id": request_id,
                    "recommendation_surface": "library",
                    "recommendation_position": position,
                    # Cache entries can outlive a model rollout.  Never let
                    # an old cached attribution label leak into the response
                    # or disagree with the delivery row written below.
                    "recommendation_model_version": ALGORITHM_VERSION,
                }
            )
            cached_tracks.append(item)
            if (
                item.get("source") == "ytmusic"
                and item.get("external_id")
                and not item.get("stream_url")
            ):
                item["stream_url"] = (
                    f"{str(request.base_url).rstrip('/')}/api/ytdlp/stream/"
                    f"{item['external_id']}"
                )
            if item.get("id") is not None and item.get("recommendation_score") is not None:
                cached_scores[item["id"]] = item["recommendation_score"]
        cached_payload["tracks"] = cached_tracks
        record_delivery(
            db,
            user_id=current_user.id,
            items=cached_tracks,
            surface="library",
            request_id=request_id,
            scores=cached_scores,
            algorithm_version=ALGORITHM_VERSION,
        )
        db.commit()
        return RecommendationResponse(**cached_payload)

    # Get user's liked tracks and frequently played tracks
    liked_playlist_id = db.query(Playlist.id).filter(
        Playlist.owner_id == current_user.id, Playlist.is_liked == True
    ).scalar()
    liked = []
    if liked_playlist_id is not None:
        liked = (
            db.query(Track, playlist_tracks.c.added_at)
            .join(playlist_tracks, playlist_tracks.c.track_id == Track.id)
            .filter(playlist_tracks.c.playlist_id == liked_playlist_id)
            .order_by(desc(playlist_tracks.c.added_at))
            .limit(_TASTE_QUERY_LIMIT)
            .all()
        )
    liked_track_ids = [t.id for t, _added_at in liked]

    # Треки из СОБСТВЕННЫХ (не is_liked) плейлистов учитываем как сигнал вкуса:
    # ручное курирование весит сильнее импорта. Их также исключаем из выдачи,
    # поскольку они уже в коллекции. Трек может быть в нескольких
    # плейлистах — дедуп по Track.id, берём самое свежее добавление.
    playlisted = (
        db.query(
            Track,
            func.max(playlist_tracks.c.added_at).label("added_at"),
            aggregate_playlist_origin().label("playlist_origin"),
        )
        .join(playlist_tracks, playlist_tracks.c.track_id == Track.id)
        .join(Playlist, Playlist.id == playlist_tracks.c.playlist_id)
        .filter(Playlist.owner_id == current_user.id, Playlist.is_liked == False)
        .group_by(Track.id)
        .order_by(desc("added_at"))
        .limit(_TASTE_QUERY_LIMIT)
        .all()
    )
    playlisted_track_ids = [t.id for t, *_ in playlisted]

    # Часто играемые: только с реальным весом (>=2 проигрываний), иначе разовые
    # клики из поиска засоряют сид и тянут в выдачу случайных артистов.
    played = (
        db.query(Track, user_track_plays.c.play_count, user_track_plays.c.last_played)
        .join(user_track_plays, user_track_plays.c.track_id == Track.id)
        .filter(
            user_track_plays.c.user_id == current_user.id,
            user_track_plays.c.play_count >= 2,
        )
        .order_by(desc(user_track_plays.c.last_played))
        .limit(_TASTE_QUERY_LIMIT)
        .all()
    )
    played_track_ids = [t.id for t, _pc, _lp in played]

    # Скипы — негативный сигнал: сам трек исключаем из выдачи, а артистам считаем
    # чистый вес (лайк/повторы против скипов), чтобы отсеять надоевших.
    skipped = (
        db.query(
            Track.id,
            Track.artist,
            user_track_skips.c.skip_count,
            user_track_skips.c.last_skipped,
            user_track_skips.c.disliked,
        )
        .join(user_track_skips, user_track_skips.c.track_id == Track.id)
        .filter(user_track_skips.c.user_id == current_user.id)
        .order_by(desc(user_track_skips.c.last_skipped))
        .limit(_TASTE_QUERY_LIMIT)
        .all()
    )
    skipped_track_ids = {row[0] for row in skipped}
    skip_by_track = {row[0]: row for row in skipped}
    skipped_meta = {
        track_id: effective_artist_title(title, artist, source=source, album=album)
        for track_id, artist, title, source, album in db.query(
            Track.id,
            Track.artist,
            Track.title,
            Track.source,
            Track.album,
        ).filter(Track.id.in_(skipped_track_ids)).all()
    }

    # Средняя доля дослушивания по трекам юзера (из лога событий) — уточняет
    # бинарный play/skip: см. комментарий у _COMPLETION_*.
    completion_rows = db.execute(
        select(
            user_play_events.c.track_id,
            func.avg(user_play_events.c.completion).label("avg_c"),
            func.count().label("cnt"),
        )
        .where(
            user_play_events.c.user_id == current_user.id,
            user_play_events.c.completion.isnot(None),
        )
        .group_by(user_play_events.c.track_id)
        .limit(_TASTE_QUERY_LIMIT)
    ).all()
    completion_by_track = {int(tid): (float(avg_c), int(cnt)) for tid, avg_c, cnt in completion_rows}

    # «Уставшие» показы: трек показывался в рекомендациях >= порога раз и так
    # и не был сыгран (строка удаляется при /play) — больше не показываем.
    fatigue_rows = db.execute(
        select(
            rec_impressions.c.track_id,
            rec_impressions.c.shown_count,
            rec_impressions.c.last_shown,
        ).where(rec_impressions.c.user_id == current_user.id)
    ).all()
    fatigue_by_track = {
        int(track_id): fatigue_score(shown_count, last_shown, now=ranking_now)
        for track_id, shown_count, last_shown in fatigue_rows
        if track_id is not None
    }
    fatigued_ids = {
        track_id for track_id, level in fatigue_by_track.items()
        if level >= 0.35
    }

    # Combine liked, played and playlisted track IDs (всё это уже в коллекции
    # юзера — исключаем из выдачи и используем как сигнал вкуса).
    user_track_ids = list(set(liked_track_ids + played_track_ids + playlisted_track_ids))
    # Явные предпочтения из онбординга должны работать до первого лайка или
    # прослушивания. Иначе новый пользователь всегда попадал в холодный старт
    # и получал глобально популярное, независимо от выбранного жанра.
    preferred_genres = list(current_user.preferred_genres or [])
    preferred_artists = list(current_user.preferred_artists or [])
    excluded_artist_keys = {
        artist_key(name)
        for name in (current_user.excluded_artists or [])
        if artist_key(name)
    }
    excluded_artist_keys -= {
        artist_key(name) for name in preferred_artists if artist_key(name)
    }
    has_explicit_preferences = bool(preferred_genres or preferred_artists)

    recommended_tracks = []
    # These collections are deliberately initialized before the warm/cold
    # branch.  Telemetry and fallback ranking must not depend on ``locals()``
    # or on whether a user happened to have a taste profile.
    artist_keys = []
    known_artist_keys = set()
    artist_positive = {}
    genres = list(preferred_genres)
    score_by_track = {}
    context_profile = build_context_profile(db, current_user.id, bucket, now=ranking_now)

    # Curated local playlists are the strongest content signal, imported
    # collections remain useful but deliberately carry less confidence.
    profile_rows = []
    for track, added_at in liked:
        profile_rows.append((track.acoustic_features, 3.0 * _curation_decay(added_at)))
    for track, added_at, origin in playlisted:
        playlist_weight = (
            3.0
            if str(origin or "manual").lower() == "manual"
            else _PLAYLIST_IMPORTED_WEIGHT
        )
        profile_rows.append(
            (track.acoustic_features, playlist_weight * _curation_decay(added_at))
        )
    for track, play_count, last_played in played:
        profile_rows.append(
            (
                track.acoustic_features,
                (1.0 + math.log1p(play_count or 1)) * _decay(last_played),
            )
        )
    acoustic_profile = weighted_centroid(profile_rows)

    excluded_external: set[tuple[str, str]] = set()
    excluded_track_keys: set[tuple[str, str]] = set()
    for track, *_ in (*liked, *playlisted, *played):
        source = getattr(track, "source", None)
        external_id = getattr(track, "external_id", None)
        if source and external_id:
            excluded_external.add((source, external_id))
        track_key = flow_router._norm_key(*effective_track_artist_title(track))
        if all(track_key):
            excluded_track_keys.add(track_key)
    external_skip_rows = db.execute(
        select(
            recommendation_events.c.source,
            recommendation_events.c.external_id,
            recommendation_events.c.artist,
            recommendation_events.c.title,
        ).where(
            recommendation_events.c.user_id == current_user.id,
            recommendation_events.c.event_type.in_(("skip", "dislike")),
            recommendation_events.c.source.isnot(None),
            recommendation_events.c.external_id.isnot(None),
        ).order_by(recommendation_events.c.occurred_at.desc()).limit(_TASTE_QUERY_LIMIT)
    ).all()
    for source, external_id, artist, title in external_skip_rows:
        excluded_external.add((source, external_id))
        effective_artist, effective_title = effective_artist_title(
            title,
            artist,
            source=source or "",
        )
        track_key = flow_router._norm_key(effective_artist, effective_title)
        if all(track_key):
            excluded_track_keys.add(track_key)
    materialized_external_skips = (
        db.query(Track.source, Track.external_id, Track.artist, Track.title)
        .join(user_track_skips, user_track_skips.c.track_id == Track.id)
        .filter(
            user_track_skips.c.user_id == current_user.id,
            Track.source != "local",
            Track.external_id.isnot(None),
        )
        .order_by(user_track_skips.c.last_skipped.desc())
        .limit(_TASTE_QUERY_LIMIT)
        .all()
    )
    for source, external_id, artist, title in materialized_external_skips:
        excluded_external.add((source, external_id))
        effective_artist, effective_title = effective_artist_title(
            title,
            artist,
            source=source or "",
        )
        track_key = flow_router._norm_key(effective_artist, effective_title)
        if all(track_key):
            excluded_track_keys.add(track_key)
    # Release the request's read connection while providers/Redis are queried.
    # Keep loaded ORM attributes alive because the same session continues with
    # local ranking and telemetry after retrieval completes.
    db.expire_on_commit = False
    db.commit()
    external_candidates = await _external_recommendation_pool(
        request,
        liked=liked,
        playlisted=playlisted,
        played=played,
        preferred_artists=preferred_artists,
        preferred_genres=preferred_genres,
        limit=limit,
        excluded_external=excluded_external,
        excluded_track_keys=excluded_track_keys,
    )

    def _candidate_score(track, content_bonus: Optional[float] = None) -> float:
        if content_bonus is None:
            content_bonus = 0.08 if not isinstance(getattr(track, "id", None), int) else 0.0
        row = skip_by_track.get(track.id)
        completion = completion_by_track.get(track.id)
        effective_artist, _effective_title = effective_track_artist_title(track)
        effective_key = artist_key(effective_artist)
        is_novel_artist = effective_key not in known_artist_keys
        score = score_track(
            track,
            user_id=current_user.id,
            artist_affinity=artist_positive.get(effective_key, 0.0),
            genres=genres,
            completion=completion[0] if completion else None,
            skip_count=row[2] if row else 0,
            disliked=bool(row[4]) if row else False,
            fatigued=track.id in fatigued_ids,
            fatigue_level=fatigue_by_track.get(track.id),
            novelty=is_novel_artist,
            source=getattr(track, "source", None),
            listener_count=getattr(track, "unique_listener_count", 0) or 0,
            content_bonus=content_bonus,
            context_bonus=context_bonus(track, context_profile),
            acoustic_profile=acoustic_profile,
            now=ranking_now,
        )
        # ``discovery_ratio`` is a soft prior only.  It nudges the common
        # ranking toward or away from new names, but never reserves positions
        # for either familiar or unfamiliar artists.
        score += (discovery_ratio(current_user) - 0.2) * (
            1.8 if is_novel_artist else -0.2
        )
        score_by_track[track.id] = score
        return score

    if user_track_ids or has_explicit_preferences:
        # Вес артиста: лайк/повтор — плюс (затухающий со временем), скип —
        # минус. В сид идут только те, у кого итог положительный (banned-
        # артисты — с отрицательным — выпадают).
        # Ключ — нормализованное (lowercase/trim) имя: SoundCloud и YT Music
        # отдают одного и того же артиста в разном написании, точное сравнение
        # раньше считало их разными артистами и резало матчинг для SC-треков.

        # Положительный сигнал вкуса (лайк/плейлист/повторы) и штраф за скипы
        # считаем РАЗДЕЛЬНО — чтобы порог доверия применять к чистому плюсу.
        # Интенсивность учитывается симметрично лог-масштабом (иначе любимый,
        # но мемно-«пролистываемый» артист уходил в минус: play_count раньше
        # игнорировался, а скип вычитал полный skip_count). Веса как во flow.py:
        # лайк +3, ручной плейлист +4, импорт +3, прослушивание
        # 1+log1p(play_count), скип
        # −1.5·log1p(skip_count).
        artist_positive: dict = {}
        artist_skip_penalty: dict = {}
        # Сколько треков артиста юзер КУРИРОВАЛ (лайк/плейлист) — для
        # доверия по факту курирования, независимо от затухающих весов.
        artist_curated_count: dict = {}
        # Повторяем явные жанры, чтобы они оставались заметным сигналом и
        # после появления небольшой истории прослушиваний.
        genres = preferred_genres * 2
        weighted_titles = []  # (title, decay_weight) — для build_title_tag_profile
        # Курируемые артисты (собственные плейлисты и явный выбор) — strongest
        # signal. Их треки получают приоритет, даже если play_count низкий.
        priority_artist_keys: set = set()
        # Keep the near-like imported weight separate from catalogue trust:
        # one imported SoundCloud track should influence ranking, but should
        # not by itself make a possibly noisy uploader's entire catalogue
        # trusted. Any additional explicit/behavioural signal removes the
        # imported-only guard; three imported tracks pass via curated_count.
        imported_artist_keys: set = set()
        non_imported_artist_keys: set = set()
        # Сколько треков артиста лежит в собственных плейлистах — по этому
        # счётчику работает порог _PLAYLIST_ARTIST_MIN_TRACKS.
        playlist_artist_totals: Counter = Counter(
            artist_key(effective_track_artist_title(t)[0])
            for t, _added_at, _origin in playlisted
        )

        # Выбранные при регистрации артисты — такой же осознанный сигнал, как
        # лайк: сразу ограничиваем ими локальный каталог и даём им приоритет.
        for name in preferred_artists:
            key = artist_key(name)
            if not key:
                continue
            artist_positive[key] = artist_positive.get(key, 0) + _ARTIST_TRUST_THRESHOLD
            artist_curated_count[key] = max(artist_curated_count.get(key, 0), 1)
            priority_artist_keys.add(key)
            non_imported_artist_keys.add(key)
        # Лайки и треки из собственных плейлистов — сигнал курирования; плейлист
        # весомее лайков (юзер осознанно подбирал композиции). Затухание — медленное
        # кураторское (_curation_decay), НЕ 14-дневное поведенческое: иначе
        # плейлисты месячной давности почти не влияли на рекомендации.
        for t, added_at in liked:
            effective_artist, effective_title = effective_track_artist_title(t)
            key = artist_key(effective_artist)
            non_imported_artist_keys.add(key)
            artist_positive[key] = artist_positive.get(key, 0) + 3.0 * _curation_decay(added_at)
            artist_curated_count[key] = artist_curated_count.get(key, 0) + 1
            genre = t.genre or infer_genre_from_text(effective_title, effective_artist)
            if genre:
                genres.append(genre)
            weighted_titles.append((effective_title, 3.0 * _curation_decay(added_at)))
        for t, added_at, playlist_origin in playlisted:
            effective_artist, effective_title = effective_track_artist_title(t)
            key = artist_key(effective_artist)
            if str(playlist_origin or "manual").lower() == "manual":
                non_imported_artist_keys.add(key)
            else:
                imported_artist_keys.add(key)
            # Плейлист курирует АРТИСТА только с _PLAYLIST_ARTIST_MIN_TRACKS
            # треков: одиночное имя из импорта осознанным выбором не является.
            favorite = playlist_artist_totals[key] >= _PLAYLIST_ARTIST_MIN_TRACKS
            origin_weight = (
                4.0
                if str(playlist_origin or "manual").lower() == "manual"
                else _PLAYLIST_IMPORTED_WEIGHT
            )
            weight = (origin_weight if favorite else _PLAYLIST_WEAK_WEIGHT) * _curation_decay(added_at)
            artist_positive[key] = artist_positive.get(key, 0) + weight
            if favorite:
                artist_curated_count[key] = artist_curated_count.get(key, 0) + 1
                priority_artist_keys.add(key)
            genre = t.genre or infer_genre_from_text(effective_title, effective_artist)
            if genre:
                genres.append(genre)
            weighted_titles.append((effective_title, weight))
        for t, play_count, last_played in played:
            w = (1.0 + math.log1p(play_count or 1)) * _decay(last_played)
            # Доля дослушивания модулирует вес прослушиваний: стабильно
            # дослушиваемое — сильнее, стабильно бросаемое — слабее плюс
            # мягкий штраф артисту (даже без явных скипов).
            comp = completion_by_track.get(t.id)
            if comp is not None:
                avg_c, cnt = comp
                if avg_c >= _COMPLETION_HI:
                    w *= _COMPLETION_HI_BOOST
                elif avg_c <= _COMPLETION_LO:
                    w *= _COMPLETION_LO_DAMP
                    if cnt >= 2:
                        key = artist_key(effective_track_artist_title(t)[0])
                        artist_skip_penalty[key] = (
                            artist_skip_penalty.get(key, 0)
                            + _COMPLETION_LO_ARTIST_PENALTY * _decay(last_played)
                        )
            effective_artist, effective_title = effective_track_artist_title(t)
            key = artist_key(effective_artist)
            non_imported_artist_keys.add(key)
            artist_positive[key] = artist_positive.get(key, 0) + w
            genre = t.genre or infer_genre_from_text(effective_title, effective_artist)
            if genre:
                genres.append(genre)
            weighted_titles.append((effective_title, w))
        for _tid, artist, skip_count, last_skipped, disliked in skipped:
            key = artist_key(skipped_meta.get(_tid, (artist, ""))[0])
            # Явный дизлайк — осознанный отказ: штраф тяжелее случайного скипа
            # и не затухает со временем (см. _DISLIKE_ARTIST_PENALTY во flow.py).
            # Порог доверия по курированию (2+ лайка/плейлиста) он не отменяет:
            # один дизлайк у любимого артиста банит трек, а не весь каталог.
            penalty = (
                _DISLIKE_ARTIST_PENALTY
                if disliked
                else 1.5 * math.log1p(skip_count or 1) * _decay(last_skipped)
            )
            artist_skip_penalty[key] = artist_skip_penalty.get(key, 0) + penalty

        # Доверенный артист: положительный сигнал сам по себе уверенный
        # (>= порога), ЛИБО юзер курировал 2+ его трека (лайк/плейлист —
        # осознанные добавления в коллекцию, давность не важна) — тогда скипы
        # НЕ бьют по всему каталогу, работают только на уровне скипнутого
        # трека (он и так в exclude_ids). Ещё НЕ доверенный — скипы влияют
        # сильно: пускаем в сид, только если плюс перевешивает штраф за скипы.
        artist_keys = []
        for key, pos in artist_positive.items():
            imported_only = (
                key in imported_artist_keys and key not in non_imported_artist_keys
            )
            curated = artist_curated_count.get(key, 0) >= _CURATED_TRUST_COUNT
            confident_by_weight = not imported_only and (
                pos >= _ARTIST_TRUST_THRESHOLD
                or pos - artist_skip_penalty.get(key, 0) >= _NET_TRUST_MARGIN
            )
            if curated or confident_by_weight:
                artist_keys.append(key)
        artist_keys = [key for key in artist_keys if key not in excluded_artist_keys]
        known_artist_keys = set(artist_keys)

        # Артисты, по которым у юзера есть ЛЮБОЙ положительный сигнал. Шире
        # artist_keys выше: тот уже сужен порогом доверия и как скоуп вырезал бы
        # легитимные треки. Таблица tracks общая и владельца у трека нет, поэтому
        # без этого ограничения жанровые/теговые фильтры ниже выбирают из чужих
        # библиотек — юзер, импортировавший плейлист, начинал подмешиваться в
        # рекомендации всем остальным. Открытие НОВЫХ имён остаётся за
        # co-occurrence: это единственный путь, которому межюзерность нужна
        # по смыслу (см. app/cooccurrence.py).
        scope_artist_keys = {
            key for key in artist_positive if key not in excluded_artist_keys
        }

        # Единая проверка релевантности для ВСЕХ путей выдачи (основной пул,
        # co-occurrence-соседи, добор популярным). Раньше каждый путь фильтровал
        # по-своему, и постороннее протекало через тот, что чинили последним.
        _prefer_cyrillic = dominant_is_cyrillic(
            [
                f"{title} {artist}"
                for t, *_ in liked
                for artist, title in [effective_track_artist_title(t)]
            ]
            + [
                f"{title} {artist}"
                for t, *_ in playlisted
                for artist, title in [effective_track_artist_title(t)]
            ]
            + [
                f"{title} {artist}"
                for t, *_ in played
                for artist, title in [effective_track_artist_title(t)]
            ]
        )
        _keep_track_base = track_check(
            make_relevance_check(
                trusted_artist_keys=set(artist_keys),
                user_genres=set(genres),
                prefer_cyrillic=_prefer_cyrillic,
            )
        )
        keep_track = lambda track: (
            artist_key(effective_track_artist_title(track)[0])
            not in excluded_artist_keys
            and _keep_track_base(track)
        )
        # Для добора глобально популярным — строгий вариант: там кандидат не
        # связан со вкусом ничем, поэтому нужно положительное подтверждение.
        _keep_unrelated_base = track_check(
            make_relevance_check(
                trusted_artist_keys=set(artist_keys),
                user_genres=set(genres),
                prefer_cyrillic=_prefer_cyrillic,
                require_signal=True,
            )
        )
        keep_unrelated = lambda track: (
            artist_key(effective_track_artist_title(track)[0])
            not in excluded_artist_keys
            and _keep_unrelated_base(track)
        )

        # Кандидаты по вкусу; скипнутые треки исключаем целиком. Условия строим
        # только для непустых списков — у внешних треков жанра нет, и пустой
        # IN (NULL) и матчил бы ничего, и сыпал бы предупреждением SQLAlchemy.
        taste_filters = []
        if genres:
            taste_filters.append(
                func.lower(Track.genre).in_(
                    {str(genre).strip().lower() for genre in genres if genre}
                )
            )
            # Плюс грубый матчинг по ключевым словам в названии — у внешних
            # треков genre почти всегда пуст, но само название часто прямо
            # называет жанр ("... Phonk Remix", "... Trap"). Берём top-3 самых
            # частых жанров вкуса (явных + угаданных), чтобы не раздувать
            # запрос десятками OR-условий.
            kw_conditions = build_keyword_filters(Track.title, Counter(genres))
            if kw_conditions:
                taste_filters.append(or_(*kw_conditions))
        title_tags = list(build_title_tag_profile(weighted_titles).keys())
        # Слова, которые пользователь сам "выбрал" тем, что регулярно слушает
        # треки с ними в названии. Одиночное неоднозначное слово ("гей") как
        # фильтр НЕ используется (тянет серьёзные/иностранные треки на ту же
        # тему) — build_tag_filters требует пару тегов и вернёт [] на одном.
        tag_conditions = build_tag_filters(Track.title, title_tags)
        if tag_conditions:
            taste_filters.append(or_(*tag_conditions))
        if artist_keys:
            taste_filters.append(
                or_(func.lower(Track.artist).in_(artist_keys), Track.source == "soundcloud")
            )

        # Привязка жанра/темы к артисту целиком: если хотя бы часть каталога
        # артиста в базе матчит нужные слова, подтягиваем ВСЕ его треки — не
        # только тот единственный, где слово буквально есть в названии (иначе
        # тестовое прослушивание нескольких "гей"-треков даёт в рекомендациях
        # только один совпавший по заголовку трек). Жанровые слова однозначны
        # — им хватает одного совпадения; теги вкуса (title_tags) могут быть
        # неоднозначным словом на тему ("гей") — там требуем пару тегов
        # разом, иначе один случайный серьёзный трек с тем же словом у
        # постороннего артиста тянет весь его чужой каталог.
        genreartist_keys = artists_matching_keywords(
            db,
            top_genre_keywords(Counter(genres)),
            restrict_artists=scope_artist_keys or None,
        )
        genreartist_keys |= artists_matching_keywords(
            db,
            title_tags,
            min_matches=2,
            restrict_artists=scope_artist_keys or None,
        )
        if genreartist_keys:
            taste_filters.append(
                or_(
                    func.lower(Track.artist).in_(genreartist_keys),
                    Track.source == "soundcloud",
                )
            )

        # Python-set — для фильтрации в памяти (exploration и т.п.); SQL-
        # исключение коллекции идёт подзапросом (см. _collection_exclude_select).
        # Усталость показов — сигнал ПОРЯДКА, а не исключения: «показан 4 раза и
        # не сыгран» ставит трек в конец очереди, но не выбрасывает его. Жёсткое
        # исключение выжигало пул у активных юзеров (у одного — 191 трек из 300
        # показанных), после чего выдача добивалась чем попало. Релевантный
        # повтор лучше нерелевантной новинки.
        exclude_ids = set(user_track_ids) | skipped_track_ids
        exclude_select = _collection_exclude_select(current_user.id)
        candidate_pool: dict[object, object] = {}
        if taste_filters:
            # Берём с запасом — после taste-фильтра и мягкой диверсификации
            # часть кандидатов опустится. Увеличиваем выборку, чтобы нишевые
            # артисты из плейлистов (play_count=1-6) не вытеснялись
            # глобально популярными треками из лайкнутого.
            q = db.query(Track).filter(or_(*taste_filters)).filter(
                ~Track.id.in_(exclude_select)
            )
            # Кандидат обязан быть от артиста с сигналом юзера (см.
            # scope_artist_keys). Скоуп пуст только при холодном старте — сужать
            # там не до чего.
            if scope_artist_keys:
                q = q.filter(
                    or_(
                        func.lower(Track.artist).in_(scope_artist_keys),
                        Track.source == "soundcloud",
                    )
                )
            # Окно берём СЛУЧАЙНО, а не топом по play_count: топ окна — это
            # всегда самые заигранные треки нескольких артистов, поэтому выдача
            # крутила одних и тех же, хотя вкусовых артистов в библиотеке сотни.
            # Никакая сортировка в Python остальных уже не достанет — их просто
            # нет в выборке.
            # Fetch a generous deterministic candidate window and rank it in
            # Python.  ORDER BY RANDOM() made the same query impossible to
            # replay and could hide niche tracks behind a small random sample.
            pool = q.order_by(Track.id).limit(max(limit * 100, 500)).all()
            # Гарантируем, что треки доверенных артистов (из плейлистов)
            # попадают в пул, даже если их play_count низкий и они не
            # прошли в limit*8 по популярности. Иначе плейлисты с нишевыми
            # артистами (SoundCloud, малая база) систематически игнорируются.
            curated_in_pool = {t.id for t in pool}
            # Гарантируем треки курируемых артистов: делаем отдельный запрос
            # по каждому артисту из плейлистов или явных предпочтений, т.к. общий
            # `.in_(artist_keys)` с 97+ элементами (кириллица/юникод) может
            # молча не матчить отдельных артистов.
            _played_liked_keys = {
                artist_key(effective_track_artist_title(t)[0]) for t, _ in liked
            }
            _played_liked_keys |= {
                artist_key(effective_track_artist_title(t)[0])
                for t, _, _ in played
            }
            _new_priority_keys = priority_artist_keys - _played_liked_keys
            for pk in _new_priority_keys:
                extra = db.query(Track).filter(
                    or_(func.lower(Track.artist) == pk, Track.source == "soundcloud"),
                    ~Track.id.in_(exclude_select),
                ).order_by(desc(Track.play_count)).all()
                for t in extra:
                    if (
                        t.id not in curated_in_pool
                        and artist_key(effective_track_artist_title(t)[0]) == pk
                    ):
                        pool.append(t)
                        curated_in_pool.add(t.id)
            # Кураторские треки (из кастомных плейлистов) — strongest signal (+4.0).
            # Поднимаем их в пуле выше популярных, иначе нишевые артисты
            # из плейлистов (Sileo, KalloedBrood, play_count=1-6) систематически
            # задавливаются глобально популярными (AC/DC, Ace of Base, play_count=16).
            # «Уставшие» показы уходят в конец (не исключаются — см. exclude_ids).
            # Ротация артистов вкуса: взвешенно случайный порядок вместо
            # -play_count. По популярности первые слоты (после cap 2/артист)
            # доставались одной и той же горстке самых заигранных артистов при
            # каждом пересчёте — остальные артисты библиотеки не показывались.
            # Совпадение по слову в названии/теге само по себе не значит
            # "тот же дух" — трек мог попасть в выдачу по случайному слову в
            # заголовке, будучи из совсем другого жанра (плюс отсев иностранного
            # и, при одноязычной библиотеке, чужого языка). Артисты, которых
            # юзер реально слушает, проходят проверку сами по себе.
            pool = [
                t
                for t in pool
                if (
                    not scope_artist_keys
                    or artist_key(effective_track_artist_title(t)[0])
                    in scope_artist_keys
                )
                and keep_track(t)
            ]
            def _track_rank(t: Track) -> tuple:
                return (
                    -_candidate_score(t),
                    stable_jitter(current_user.id, t.id),
                    t.id,
                )

            for track in pool:
                candidate_pool[track.id] = track

        # Acoustic content is an independent candidate source.  Unlike the
        # artist/genre pool it is intentionally not restricted to the user's
        # known artists: a close signal in the audio vector is itself evidence
        # of relevance.  Keep tracks from another user's private collection
        # out of this global content pool; unowned catalog rows and the current
        # user's own playlists remain eligible.
        acoustic_candidate_ids: set[int] = set()
        if acoustic_profile:
            acoustic_keep = track_check(
                make_relevance_check(
                    trusted_artist_keys=set(),
                    user_genres=set(genres),
                    prefer_cyrillic=None,
                    provenance_trusted=True,
                )
            )
            other_owner_tracks = (
                select(playlist_tracks.c.track_id)
                .select_from(
                    playlist_tracks.join(
                        Playlist, Playlist.id == playlist_tracks.c.playlist_id
                    )
                )
                .where(Playlist.owner_id != current_user.id)
            )
            acoustic_query = (
                db.query(Track)
                .filter(
                    Track.acoustic_features.isnot(None),
                    ~Track.id.in_(exclude_select),
                    ~Track.id.in_(other_owner_tracks),
                )
            )
            acoustic_pool = acoustic_query.order_by(Track.id).limit(
                max(limit * 100, 500)
            ).all()
            for track in acoustic_pool:
                if (
                    track.id in candidate_pool
                    or not acoustic_keep(track)
                    or acoustic_similarity(
                        track.acoustic_features, acoustic_profile
                    )
                    < MIN_RECOMMENDATION_SIMILARITY
                ):
                    continue
                candidate_pool[track.id] = track
                acoustic_candidate_ids.add(track.id)

        # Collaborative neighbours remain useful, but compete in the same
        # ranking as acoustic and library candidates instead of consuming a
        # preallocated exploration slice.
        got_ids = set(candidate_pool)
        seeds = (liked_track_ids + played_track_ids + playlisted_track_ids)[:80]
        scored_neighbors = similar_track_ids(db, seeds, limit=300)
        # Абсолютный score co-occurrence зависит от того, сколько у юзера
        # сигналов, поэтому порог берём ОТНОСИТЕЛЬНО самого похожего соседа.
        # Хвост распределения — это треки, попавшие в матрицу через одного
        # случайного общего слушателя: у любителя русского рэпа именно оттуда
        # приходили Ace of Base и Men At Work (score 0.8 против 33 у топа).
        top_score = scored_neighbors[0][1] if scored_neighbors else 0.0
        neighbor_ids = [
            tid
            for tid, score in scored_neighbors
            if tid not in exclude_ids
            and tid not in got_ids
            and score >= top_score * _NEIGHBOR_SCORE_FLOOR
        ]
        neighbors: list = []
        if neighbor_ids:
            by_id = {
                t.id: t
                for t in db.query(Track).filter(Track.id.in_(neighbor_ids)).all()
            }
            # Co-occurrence на малой базе склеивает треки через одного общего
            # слушателя, поэтому «сосед» может быть из совсем другого жанра —
            # прогоняем соседей через ту же проверку вкуса, что и основной пул.
            ordered = [
                by_id[tid]
                for tid in neighbor_ids
                if tid in by_id and keep_track(by_id[tid])
            ]
            # «Уставшие» показы не исключаем, но ставим после свежих.
            ordered.sort(key=lambda t: 1 if t.id in fatigued_ids else 0)
            for track in ordered:
                if track.id not in candidate_pool:
                    candidate_pool[track.id] = track

        # Provider candidates are retrieved from the user's actual taste
        # seeds, so they are not subject to the local catalogue's artist scope.
        # They still use the same score and hard negative/exclusion signals.
        for track in external_candidates:
            artist = artist_key(effective_track_artist_title(track)[0])
            if artist in excluded_artist_keys:
                continue
            candidate_pool.setdefault(track.id, track)

        # Relevant popular tracks are only a fallback candidate source.  They
        # are ranked together with all personalized candidates, never appended
        # after a source quota has already consumed the page.
        if len(candidate_pool) < max(limit * 2, limit):
            popular = _varied_popular(
                db,
                exclude_ids | set(candidate_pool),
                max(limit * 4, limit),
                keep=keep_unrelated,
                restrict_artists=scope_artist_keys or None,
                excluded_artists=excluded_artist_keys,
                user_id=current_user.id,
            )
            for track in popular:
                candidate_pool.setdefault(track.id, track)

        ranked_pool = [
            track
            for track in candidate_pool.values()
            if track.id not in exclude_ids
            and (
                not isinstance(track.id, int)
                or keep_track(track)
                or track.id in acoustic_candidate_ids
            )
        ]
        ranked_pool.sort(
            key=lambda track: (
                -_candidate_score(track),
                stable_jitter(current_user.id, track.id),
                track.id,
            )
        )
        # Soft repeat penalties preserve a highly relevant repeat when the
        # catalog is sparse, while allowing an acoustically close new artist to
        # win when it is genuinely a better match.
        ranked_pool = soft_artist_rerank(
            ranked_pool,
            _candidate_score,
            artist_of=lambda track: effective_track_artist_title(track)[0],
        )[: max(limit * 6, limit)]
        local_ranked_ids = [
            track.id
            for track in ranked_pool[: max(limit * 3, limit)]
            if isinstance(track.id, int)
        ]
        recommended_tracks = mmr(
            ranked_pool[: max(limit * 3, limit)],
            pair_scores(db, local_ranked_ids),
        )[:limit]
    else:
        # Холодный старт: сигналов вкуса ещё нет — показываем популярное сервиса.
        # (Раньше популярным добивали ЛЮБУЮ неполную выдачу, из-за чего у активных
        # юзеров место релевантного занимали глобальные хиты — это и убрано.)
        recommended_tracks = _cold_start_candidates(
            db,
            preferred_genres=preferred_genres,
            preferred_artists=preferred_artists,
            excluded_artists=excluded_artist_keys,
            exclude_ids=skipped_track_ids | fatigued_ids,
            limit=limit,
            user_id=current_user.id,
        )
        if len(recommended_tracks) < limit:
            recommended_tracks += _varied_popular(
                db,
                skipped_track_ids | fatigued_ids | {t.id for t in recommended_tracks},
                limit - len(recommended_tracks),
                excluded_artists=excluded_artist_keys,
                used=Counter(
                    primary_artist_key(effective_track_artist_title(t)[0])
                    for t in recommended_tracks
                ),
                user_id=current_user.id,
            )
        if external_candidates:
            combined = []
            seen_candidates = set()
            for candidate in (*recommended_tracks, *external_candidates):
                identity = (
                    f"{candidate.source}:{candidate.external_id}"
                    if not isinstance(candidate.id, int)
                    else f"local:{candidate.id}"
                )
                if identity in seen_candidates:
                    continue
                seen_candidates.add(identity)
                combined.append(candidate)
            combined.sort(
                key=lambda track: (
                    -_candidate_score(track),
                    stable_jitter(current_user.id, track.id),
                )
            )
            recommended_tracks = combined[:limit]

    # min_gap=4: прежние 3 допускали A _ _ A _ _ A — формально «не подряд», а
    # на слух «опять он» (см. _MIN_ARTIST_GAP во flow.py).
    recommended_tracks = interleave_artists(recommended_tracks, min_gap=4)[:limit]

    # Фиксируем показы (для сигнала «показан N раз — не сыгран»). Пока ответ
    # живёт в кэше, повторные отдачи того же списка показом не считаются —
    # это осознанно: юзер видел ОДНУ выдачу, а не пять.
    #
    # ОДИН multi-row upsert, а не по statement на трек: при limit=20 это было
    # 20 round-trip'ов к Postgres внутри GET-запроса, и каждый держал write-lock
    # по своей строке. На 10k активных юзеров разница — 200k statement'ов против
    # 10k. Дедуп по track_id обязателен: ON CONFLICT DO UPDATE не может дважды
    # обновить одну строку в одном statement ("cannot affect row a second time"),
    # а порядок выдачи (interleave_artists/добор соседями) дублей не исключает.
    # Keep the compact fatigue aggregate above, but also append a complete
    # delivery record for offline evaluation (position/source/score/version).
    for track in recommended_tracks:
        _candidate_score(track)
    record_delivery(
        db,
        user_id=current_user.id,
        items=recommended_tracks,
        surface="library",
        request_id=request_id,
        scores=score_by_track,
        algorithm_version=ALGORITHM_VERSION,
    )

    # Get popular playlists — без selectinload(tracks): ответ встраивает только
    # метаданные плейлистов (название, обложка), а не все их треки. Полный
    # список треков плейлиста загружается при открытии PlaylistDetail.
    popular_playlists = _rank_public_playlists(
        db,
        current_user=current_user,
        preferred_genres=preferred_genres,
        preferred_artist_keys=known_artist_keys,
        limit=10,
    )

    track_payloads = []
    for position, track in enumerate(recommended_tracks):
        score = score_by_track.get(track.id)
        if score is None:
            score = _candidate_score(track)
        response_model = (
            TrackResponse
            if isinstance(track.id, int)
            else ExternalTrackResponse
        )
        payload = response_model.model_validate(track).model_copy(
            update={
                "recommendation_id": request_id,
                "recommendation_surface": "library",
                "recommendation_position": position,
                "recommendation_score": score,
                "recommendation_model_version": ALGORITHM_VERSION,
            }
        )
        track_payloads.append(payload)

    response = RecommendationResponse(
        tracks=track_payloads,
        playlists=[PlaylistResponse.model_validate(p) for p in popular_playlists]
    )
    # The endpoint is intentionally cacheable, but callers can associate
    # subsequent feedback with the exact non-cached generation.
    set_cache(cache_key, response.model_dump(mode="json"), expire=_RECS_TTL)
    db.commit()
    return response


@router.post("/events", status_code=204)
def record_recommendation_event(
    payload: RecommendationEventPayload,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db),
):
    """Record feedback for a local or external recommendation item.

    External items are accepted without materialisation.  Known local items
    are linked opportunistically; malformed/unknown ids do not make telemetry
    fail the playback UI.
    """
    if payload.event_type not in ALLOWED_EVENT_TYPES:
        raise HTTPException(status_code=422, detail="Unsupported recommendation event")

    track_id = payload.track_id
    if track_id is not None:
        known = db.query(Track.id).filter(Track.id == track_id).scalar()
        if known is None:
            track_id = None
    if track_id is None and payload.source and payload.external_id:
        track_id = db.query(Track.id).filter(
            Track.source == payload.source,
            Track.external_id == payload.external_id,
        ).scalar()
    if payload.event_type == "impression":
        recorded = record_impression(
            db,
            user_id=current_user.id,
            request_id=payload.request_id,
            track_id=track_id,
            source=payload.source,
            external_id=payload.external_id,
            position=payload.position,
        )
        # A browser observer/player effect may fire more than once.  The
        # delivery update is the idempotency gate, so duplicate confirmations
        # must not inflate the immutable event stream either.
        if not recorded:
            db.rollback()
            return None
    record_event(
        db,
        user_id=current_user.id,
        event_type=payload.event_type,
        track_id=track_id,
        source=payload.source,
        external_id=payload.external_id,
        title=payload.title,
        artist=payload.artist,
        value=payload.value,
        surface=payload.surface,
        position=payload.position,
        request_id=payload.request_id,
        client_hour=payload.client_hour,
        metadata=payload.metadata,
        # The client may report an older build, but it must not be able to
        # rewrite the server's attribution label.  The delivery row and every
        # feedback event use the scorer that actually produced the response.
        algorithm_version=ALGORITHM_VERSION,
    )
    db.commit()
    if payload.event_type != "impression":
        invalidate_recommendation_cache(current_user.id)
    return None


@router.get("/metrics")
def get_recommendation_metrics(
    days: int = Query(30, ge=1, le=365),
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db),
):
    """Return recommendation funnel metrics for the current user."""
    return user_metrics(db, current_user.id, days=days)


@router.get("/tracks", response_model=List[TrackResponse | ExternalTrackResponse])
async def get_recommended_tracks(
    request: Request,
    limit: int = 20,
    hour: Optional[int] = Query(None, ge=0, le=23),
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    recommendations = await get_recommendations(
        request=request,
        limit=limit,
        hour=hour,
        current_user=current_user,
        db=db,
    )
    return recommendations.tracks


@router.get("/playlists", response_model=List[PlaylistResponse])
async def get_recommended_playlists(
    request: Request,
    limit: int = 10,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    recommendations = await get_recommendations(
        request=request,
        limit=limit,
        current_user=current_user,
        db=db,
    )
    return recommendations.playlists
