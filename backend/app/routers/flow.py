"""Персональный бесконечный поток («Моя волна»).

Локальный каталог, лайки, ручные и импортированные плейлисты, Last.fm,
YouTube Music, SoundCloud и жанровые теги генерируют кандидатов, которые
ранжируются общей моделью по поведению пользователя, акустическому профилю
beets/ffmpeg, жанру, контексту, качеству и свежести. Источники не получают
фиксированных мест. ``discovery_ratio`` остаётся мягким приоритетом на
дефолтном значении, а явно повышенный ползунок задаёт минимальную цель новых
артистов с fallback на знакомые треки при дефиците внешнего пула.

Last.fm, радио и граф YouTube Music, каталоги любимых артистов, SoundCloud и
жанровые теги расширяют пул. Их происхождение даёт небольшой confidence bonus;
внутри знакомой и новой частей порядок определяет общая модель. Генераторы
могут быть пропущены, когда пул уже широк и цель разведки выполнена.
"""

import asyncio
import logging
import math
import os
import re
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy import case, desc, func, or_, select, tuple_
from sqlalchemy.orm import Session

from app import beets_genre, beets_similar, storage
from app.cache import get_cache_async, set_cache_async
from app.database import get_db
from app.dependencies import get_current_active_user
from app.discovery import (
    DEFAULT_DISCOVERY_RATIO,
    discovery_ratio,
    discovery_slots,
)
from app.artist_genre import artists_matching_keywords
from app.genre_keywords import (
    build_keyword_filters,
    infer_genre_from_text,
    top_genre_keywords,
)
from app.lang import dominant_is_cyrillic
from app.taste import make_relevance_check, track_check
from app.title_tags import build_tag_filters, build_title_tag_profile
from app.diversity import (
    interleave_artists,
    primary_artist_key,
    soft_artist_rerank,
    weighted_order,
)
from app.recommendation_scoring import (
    ALGORITHM_VERSION,
    population_quality_score,
    population_rejects,
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
from app.recommendation_telemetry import new_request_id, record_delivery
from app.artist_utils import (
    artist_key,
    effective_artist_title,
    effective_track_artist_title,
    same_artist,
)
from app.models import (
    Track,
    User,
    Playlist,
    playlist_tracks,
    user_track_plays,
    user_track_skips,
    recommendation_events,
    recommendation_impressions,
)
from app.routers import soundcloud, ytdlp
from app.routers.ytdlp import clean_title
from app.schemas import ExternalTrackResponse, TrackResponse

logger = logging.getLogger(__name__)

router = APIRouter()

# Сколько последних прослушиваний исключаем из потока (свежесть).
# 100 треков хватает на ~5-6 часов активного прослушивания — поток не
# повторяется даже при длительных сессиях.
_RECENT_PLAYS_EXCLUDE = 100
# Минимум прослушиваний АРТИСТА (сумма по его трекам), с которого история
# считается сигналом вкуса. Порог по артисту, а не по треку: юзер, слушающий
# библиотеку по одному разу на трек, иначе получал пустой профиль и пустую
# волну, хотя сотня прослушиваний одного артиста — сигнал сильнее двух
# прослушиваний одного трека. Смысл порога сохраняется: одно случайное
# прослушивание одного трека артистом вкуса не делает.
_PLAYED_ARTIST_MIN_PLAYS = 2
# Минимум треков АРТИСТА в собственных плейлистах, с которого он считается
# любимым (курированным). Импорт приводит сотни имён одним движением, и каждое
# становилось любимым с первого же трека: любимый артист проходит вкусовой
# фильтр в обход всех проверок (taste.py — trusted_artist_keys), открывает свой
# каталог у провайдера. Так один
# попутный трек из импортированного плейлиста размывал профиль до «подходит всё»
# — особенно с SoundCloud, где артистом трека часто оказывается не исполнитель, а
# перезаливщик (см. artist_utils.resolve_track_artist).
# Порог по артисту, а не по плейлисту: три трека в коллекции — это выбор, один —
# попутный груз импорта. Ниже порога трек остаётся положительным сигналом (жанр,
# язык, скоуп своей библиотеки), но любимым артиста не делает.
_PLAYLIST_ARTIST_MIN_TRACKS = 3
# Imported collections are an intentional taste signal. Keep their per-track
# weight at the same level as a like. The separate artist-count threshold below
# controls catalogue trust, so one noisy import still cannot open an entire
# provider catalogue.
_PLAYLIST_IMPORTED_WEIGHT = 3.0
_PLAYLIST_WEAK_WEIGHT = _PLAYLIST_IMPORTED_WEIGHT
# Кэш радио-пула на сид: радио YT Music стабильно на коротком горизонте,
# нет смысла дёргать его на каждую подгрузку.
_RADIO_TTL = 1800
_RADIO_LIMIT = 50
# Разведка по ГРАФУ АРТИСТОВ YT Music. Радио строится от videoId, поэтому у
# пользователя, чья библиотека целиком в SoundCloud, оно недоступно в принципе,
# и «похожие артисты» из волны исчезали совсем — оставались ровно те, кого юзер
# выбрал сам. Граф работает от имени артиста и этой дырки не имеет.
# Сколько соседей берём у одного артиста и сколько артистов вкуса зондируем за
# подгрузку. Порядок в profile["artists"] дальше ротируется контекстным хэшем,
# так что это не фиксированный топ.
_SIMILAR_ARTISTS = 6
_SIMILAR_SEED_ARTISTS = 2
# Список соседей практически не меняется — держим сутки. Треки конкретного
# артиста живут меньше и переиспользуются всеми юзерами сразу.
_SIMILAR_NAMES_TTL = 24 * 60 * 60
_SIMILAR_TTL = 6 * 60 * 60
# Сколько ytmusic-видео артиста берём как сиды радио, когда своих сидов нет.
_ARTIST_SEED_LIMIT = 3
# У SoundCloud нет радио-эндпоинта в yt-dlp, поэтому «разведку» по нему делаем
# поиском по любимым артистам. Сколько артистов зондируем и глубина кэша.
_SC_EXPLORE_ARTISTS = 6
_SC_EXPLORE_LIMIT = 15
_SC_EXPLORE_TTL = 1800
# Разведка по пользовательским тегам (title_tags) — поиск НОВЫХ треков (не
# обязательно от уже знакомых артистов) прямо у провайдеров по словам, которые
# пользователь сам "выбрал" своей историей прослушивания.
_TAG_EXPLORE_TAGS = 3
_TAG_EXPLORE_LIMIT = 15
_TAG_EXPLORE_TTL = 1800
# Сколько артистов вкуса берём в работу за один запрос. Дальше endpoint
# переупорядочивает их стабильным хэшем текущей flow-history, поэтому это не
# «топ-N навсегда»: каждая подгрузка достаёт и другие имена из библиотеки.
# Прежний фиксированный топ-12 был причиной «крутит одних и тех же».
_FLOW_ARTISTS = 30
# Сколько последних ОТДАННЫХ треков помним для разноса артистов между
# подгрузками. Раньше помнили ровно min_gap (3 артиста) — только чтобы артист
# с конца прошлой порции не пошёл первым в следующей. Этого мало: повторный
# артист быстро возвращался в каждой подгрузке и вся сессия звучала однообразно.
_ARTIST_HISTORY = 45
# Минимальный разнос между треками одного артиста внутри выдачи. Прежние 3
# допускали A _ _ A _ _ A — формально «не подряд», на слух «опять он».
# Само по себе число периодичность НЕ лечит: требование «не ближе d-1» на d
# артистах выполнимо единственным способом — ротацией, поэтому за порядок
# отвечает контекстный взвешенный выбор в diversity.interleave_artists.
_MIN_ARTIST_GAP = 4
# Вес сигнала вкуса (лайк/прослушивание/скип) экспоненциально затухает со
# временем вместо жёсткого окна «последние N записей» — иначе у активных
# пользователей (сотни прослушиваний за сессию) более ранний, но всё ещё
# любимый артист резко выпадает из профиля, стоит наиграть чуть больше
# истории поверх него. Полураспад веса — раз в столько дней сигнал слабеет
# вдвое; пределы выборки — просто защита от неограниченного запроса, не
# смысловая отсечка.
_TASTE_HALF_LIFE_DAYS = 14.0
_TASTE_QUERY_LIMIT = 300
# Штраф артисту за ЯВНЫЙ дизлайк трека: сильнее лайка (+3.0) и плейлиста
# (+4.0 — курирование всё же перевешивает один дизлайк), без затухания по
# времени. Осознанное «не нравится» должно убирать артиста из волны сразу,
# а не растворяться в весах через две недели.
_DISLIKE_ARTIST_PENALTY = 3.5
# Краткосрочная серверная история не даёт новому запуску волны сразу вернуть
# тот же исчерпанный пул в другом порядке. Хвоста достаточно для нескольких
# длинных сессий, TTL позже разрешает старым трекам естественно вернуться.
_FLOW_HISTORY_LIMIT = 500
_FLOW_HISTORY_TTL = 6 * 60 * 60
# Continuation-сиды превращают фиксированный набор radio-пулов в ограниченный
# обход графа YT Music. Больше сидов за запрос заметно увеличит внешние вызовы.
_CONTINUATION_SEEDS = 6
_PROFILE_SEEDS = 4
_FAVORITE_ARTIST_LIMIT = 15
_FAVORITE_EXPLORE_ARTISTS = 12
# Похожесть на уровне ТРЕКА по названию (Last.fm через клиент beets, см.
# beets_similar) — ОСНОВНОЙ источник разведки. Все остальные внешние источники
# засеяны ИМЕНЕМ АРТИСТА: граф YT Music отдаёт соседей артиста, SoundCloud —
# его же дискографию, _favorite_artist_pool — его точный каталог. Все они
# отвечают на вопрос «кто похож на этого артиста», а не «что похоже на ЭТОТ
# трек», и поэтому раз за разом возвращают дискографии вокруг уже выбранных
# юзером имён. Last.fm засеян парой артист+название и отвечает именно на второй
# вопрос — ему и доверяем в первую очередь.
# Сколько курированных треков берём сидами за подгрузку (порядок в
# profile["seed_tracks"] ниже ротируется контекстным хэшем, а не фиксированным топом),
# сколько похожих имён просим у Last.fm и сколько из них РАЗРЕШАЕМ у
# провайдеров. Резолв — самая дорогая часть (один поиск на имя), поэтому он
# ограничен жёстко, а результат кэшируется на сид.
_LASTFM_SEED_TRACKS = 3
_LASTFM_SIMILAR_LIMIT = 20
_LASTFM_RESOLVE = 5
# Список похожих на конкретный трек стабилен — держим сутки. Разрешённый пул
# живёт меньше: у провайдера каталог меняется, да и ссылки стареют.
_LASTFM_NAMES_TTL = 24 * 60 * 60
_LASTFM_POOL_TTL = 6 * 60 * 60
# Сколько свежих курированных треков держим в профиле как потенциальные сиды.
_SEED_TRACK_LIMIT = 20


def _decay(ts, half_life_days: float = _TASTE_HALF_LIFE_DAYS) -> float:
    """Экспоненциальное затухание веса по возрасту записи (в долях от 1.0)."""
    if ts is None:
        return 1.0
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    age_days = max(0.0, (datetime.now(timezone.utc) - ts).total_seconds() / 86400)
    return 0.5 ** (age_days / half_life_days)


def _norm_key(artist: str, title: str) -> tuple:
    """Нормализованный ключ (артист, название) для дедупа между источниками."""

    def norm(s: str) -> str:
        s = clean_title(s or "").lower()
        s = re.sub(r"\bfeat\.?\b.*$", "", s)
        s = re.sub(r"[^\w\s]", "", s)
        s = re.sub(r"\s+", " ", s).strip()
        return s

    return (norm(artist), norm(title))


def _external_population_stats_on_bind(bind, items, now=None) -> dict:
    """Batch-load service popularity and cross-user feedback for candidates."""
    identities = sorted({
        (getattr(item, "source", None), getattr(item, "external_id", None))
        for item in items
        if getattr(item, "source", None) and getattr(item, "external_id", None)
    })
    if not identities:
        return {}

    local_db = Session(bind=bind)
    try:
        stats = {
            f"{source}:{external_id}": {
                "play_count": 0,
                "listener_count": 0,
                "positive_users": 0,
                "negative_users": 0,
                "quality": 0.0,
            }
            for source, external_id in identities
        }
        track_rows = local_db.execute(
            select(
                Track.source,
                Track.external_id,
                Track.play_count,
                Track.unique_listener_count,
            ).where(tuple_(Track.source, Track.external_id).in_(identities))
        ).all()
        for source, external_id, play_count, listeners in track_rows:
            row = stats.get(f"{source}:{external_id}")
            if row is None:
                continue
            row["play_count"] = max(row["play_count"], int(play_count or 0))
            row["listener_count"] = max(
                row["listener_count"], int(listeners or 0)
            )

        since = (now or datetime.now(timezone.utc)) - timedelta(days=90)
        positive_user = case(
            (
                recommendation_events.c.event_type.in_(("play", "listen", "like")),
                recommendation_events.c.user_id,
            ),
            else_=None,
        )
        negative_user = case(
            (
                recommendation_events.c.event_type.in_(("skip", "dislike")),
                recommendation_events.c.user_id,
            ),
            else_=None,
        )
        feedback_rows = local_db.execute(
            select(
                recommendation_events.c.source,
                recommendation_events.c.external_id,
                func.count(func.distinct(positive_user)).label("positive_users"),
                func.count(func.distinct(negative_user)).label("negative_users"),
            ).where(
                recommendation_events.c.surface == "flow",
                recommendation_events.c.occurred_at >= since,
                tuple_(
                    recommendation_events.c.source,
                    recommendation_events.c.external_id,
                ).in_(identities),
            ).group_by(
                recommendation_events.c.source,
                recommendation_events.c.external_id,
            )
        ).all()
        for source, external_id, positive_users, negative_users in feedback_rows:
            row = stats.get(f"{source}:{external_id}")
            if row is None:
                continue
            row["positive_users"] = int(positive_users or 0)
            row["negative_users"] = int(negative_users or 0)
            row["quality"] = population_quality_score(
                row["positive_users"], row["negative_users"]
            )
        return stats
    finally:
        local_db.close()


def _taste_profile(db: Session, user_id: int) -> dict:
    """Собирает профиль вкуса пользователя из лайков и истории (блокирующая)."""
    liked_playlist_id = db.query(Playlist.id).filter(
        Playlist.owner_id == user_id, Playlist.is_liked == True
    ).scalar()
    liked = (
        db.query(Track, playlist_tracks.c.added_at)
        .join(playlist_tracks, playlist_tracks.c.track_id == Track.id)
        .filter(playlist_tracks.c.playlist_id == liked_playlist_id)
        .order_by(desc(playlist_tracks.c.added_at))
        .limit(_TASTE_QUERY_LIMIT)
        .all()
    ) if liked_playlist_id is not None else []
    # Треки из СОБСТВЕННЫХ (не is_liked) плейлистов — юзер их сам курировал,
    # это положительный сигнал вкуса (и источник радио-сидов). Дедуп по
    # Track.id (трек может быть в нескольких плейлистах), свежие первыми.
    playlisted = (
        db.query(
            Track,
            func.max(playlist_tracks.c.added_at).label("added_at"),
            aggregate_playlist_origin().label("playlist_origin"),
        )
        .join(playlist_tracks, playlist_tracks.c.track_id == Track.id)
        .join(Playlist, Playlist.id == playlist_tracks.c.playlist_id)
        .filter(Playlist.owner_id == user_id, Playlist.is_liked == False)
        .group_by(Track.id)
        .order_by(desc("added_at"))
        .limit(_TASTE_QUERY_LIMIT)
        .all()
    )
    # Taste features are intentionally bounded, but collection exclusions are
    # not. A large likes/import playlist can push an old track past the taste
    # window; it must still never re-enter the flow by id, provider id, or the
    # normalized artist/title pair.
    collection_rows = (
        db.query(
            Track.id,
            Track.artist,
            Track.title,
            Track.source,
            Track.external_id,
            Track.album,
        )
        .join(playlist_tracks, playlist_tracks.c.track_id == Track.id)
        .join(Playlist, Playlist.id == playlist_tracks.c.playlist_id)
        .filter(Playlist.owner_id == user_id)
        .all()
    )
    collection_keys = set()
    collection_external_ids = set()
    for _track_id, artist, title, source, external_id, album in collection_rows:
        effective_artist, effective_title = effective_artist_title(
            title or "",
            artist or "",
            source=source or "",
            album=album or "",
        )
        key = _norm_key(effective_artist, effective_title)
        if all(key):
            collection_keys.add(key)
        if external_id:
            collection_external_ids.add(external_id)
    # Часто играемые: порог применяем к АРТИСТУ ниже (artist_play_totals), а не
    # к треку в самом запросе. Условие `play_count >= 2` прямо здесь означало,
    # что у юзера, слушающего каждый трек по одному разу, история не попадала в
    # профиль вообще: ни артистов, ни жанров, ни языка — и волна выходила пустой.
    played = (
        db.query(Track, user_track_plays.c.play_count, user_track_plays.c.last_played)
        .join(user_track_plays, user_track_plays.c.track_id == Track.id)
        .filter(user_track_plays.c.user_id == user_id)
        .order_by(desc(user_track_plays.c.last_played))
        .limit(_TASTE_QUERY_LIMIT)
        .all()
    )
    # Суммарные прослушивания на артиста в этом окне — отсекают разовые клики
    # (тест/случайный запуск), не отсекая большую библиотеку, прослушанную по
    # одному разу.
    artist_play_totals: Counter = Counter()
    for track, play_count, _last_played in played:
        effective_artist, _effective_title = effective_track_artist_title(track)
        artist_play_totals[artist_key(effective_artist)] += play_count or 1
    # Сколько треков артиста лежит в собственных плейлистах — по этому счётчику
    # работает порог «любимого» (_PLAYLIST_ARTIST_MIN_TRACKS).
    playlist_artist_totals: Counter = Counter(
        artist_key(effective_track_artist_title(track)[0])
        for track, _added_at, _origin in playlisted
    )

    # Скипы — негативный сигнал (фронт шлёт их только при <25% прослушивания).
    # disliked — явный дизлайк из плеера: штраф тяжелее и без затухания.
    skipped = (
        db.query(
            Track,
            user_track_skips.c.skip_count,
            user_track_skips.c.last_skipped,
            user_track_skips.c.disliked,
        )
        .join(user_track_skips, user_track_skips.c.track_id == Track.id)
        .filter(user_track_skips.c.user_id == user_id)
        .order_by(desc(user_track_skips.c.last_skipped))
        .limit(_TASTE_QUERY_LIMIT)
        .all()
    )

    artist_weight: dict = {}
    # Отображаемое имя артиста на «канонический» (lowercase/trim) ключ — разные
    # источники (SoundCloud/YT Music) отдают имя одного артиста в разном
    # регистре/формате, из-за чего вес и матчинг иначе расходятся по source.
    artist_display: dict = {}
    imported_playlist_artist_keys: set[str] = set()
    non_imported_artist_keys: set[str] = set()
    genres: list = []  # с повторами — нужна частота для приоритезации ключевых слов
    weighted_titles: list = []  # (title, decay_weight) — для build_title_tag_profile
    seeds: List[str] = []  # video_id ytmusic-треков, свежие первыми
    seen_seed = set()
    # Плейлист-производные артисты используются как provider seeds, чтобы
    # SoundCloud-коллекция без YT videoId тоже расширяла общий пул. Отдельных
    # позиций они не получают; в список идут имена, набравшие порог доверия.
    playlist_artist_keys: List[str] = []  # порядок = свежесть добавления
    seen_pl_artist = set()
    # Курированные артисты (лайки + собственные плейлисты) — самый надёжный
    # доступный жанровый сигнал. У импортированных треков genre обычно пуст,
    # поэтому нельзя выдавать «14 жанровых» только на основании Track.genre.
    curated_artist_keys: List[str] = []
    seen_curated_artist = set()
    catalog_artist_keys: List[str] = []
    seen_catalog_artist = set()
    playlist_seeds: List[str] = []  # ytmusic video_id из плейлистов, свежие первыми

    # Тексты (название + артист) всех положительных сигналов — по ним определяем
    # доминирующий язык библиотеки (см. lang.dominant_is_cyrillic).
    lang_texts: List[str] = []

    for track, added_at in liked:
        effective_artist, effective_title = effective_track_artist_title(track)
        lang_texts.append(f"{effective_title} {effective_artist}")
        key = artist_key(effective_artist)
        non_imported_artist_keys.add(key)
        artist_weight[key] = artist_weight.get(key, 0) + 3.0 * _decay(added_at)
        artist_display.setdefault(key, effective_artist)
        if key and key not in seen_curated_artist:
            curated_artist_keys.append(key)
            seen_curated_artist.add(key)
        if key and key not in seen_catalog_artist:
            catalog_artist_keys.append(key)
            seen_catalog_artist.add(key)
        # Genre почти всегда пуст у внешних треков — как дополнительный сигнал
        # разбираем ключевые слова прямо в названии ("... Phonk Remix" и т.п.).
        genre = track.genre or infer_genre_from_text(effective_title, effective_artist)
        if genre:
            genres.append(genre)
        weighted_titles.append((effective_title, 3.0 * _decay(added_at)))
        if track.source == "ytmusic" and track.external_id and track.external_id not in seen_seed:
            seeds.append(track.external_id)
            seen_seed.add(track.external_id)

    # Ручной плейлист — сильный сигнал вкуса (вес выше лайка), импортированный
    # — почти такой же сильный сигнал. В обоих случаях артист получает статус
    # любимого только начиная с _PLAYLIST_ARTIST_MIN_TRACKS треков: одиночное
    # имя из импорта осознанным выбором не является.
    for track, added_at, playlist_origin in playlisted:
        effective_artist, effective_title = effective_track_artist_title(track)
        lang_texts.append(f"{effective_title} {effective_artist}")
        key = artist_key(effective_artist)
        if str(playlist_origin or "manual").lower() == "manual":
            non_imported_artist_keys.add(key)
        else:
            imported_playlist_artist_keys.add(key)
        favorite = playlist_artist_totals[key] >= _PLAYLIST_ARTIST_MIN_TRACKS
        origin_weight = (
            4.0
            if str(playlist_origin or "manual").lower() == "manual"
            else _PLAYLIST_IMPORTED_WEIGHT
        )
        weight = (origin_weight if favorite else _PLAYLIST_WEAK_WEIGHT) * _decay(added_at)
        artist_weight[key] = artist_weight.get(key, 0) + weight
        artist_display.setdefault(key, effective_artist)
        if favorite and key and key not in seen_curated_artist:
            curated_artist_keys.append(key)
            seen_curated_artist.add(key)
        genre = track.genre or infer_genre_from_text(effective_title, effective_artist)
        if genre:
            genres.append(genre)
        weighted_titles.append((effective_title, weight))
        if favorite and key not in seen_pl_artist:
            playlist_artist_keys.append(key)
            seen_pl_artist.add(key)
        if track.source == "ytmusic" and track.external_id and track.external_id not in seen_seed:
            seeds.append(track.external_id)
            seen_seed.add(track.external_id)
        if track.source == "ytmusic" and track.external_id:
            playlist_seeds.append(track.external_id)

    for track, play_count, last_played in played:
        effective_artist, effective_title = effective_track_artist_title(track)
        key = artist_key(effective_artist)
        # Разовое прослушивание артиста сигналом вкуса не считается.
        if artist_play_totals[key] < _PLAYED_ARTIST_MIN_PLAYS:
            continue
        non_imported_artist_keys.add(key)
        lang_texts.append(f"{effective_title} {effective_artist}")
        w = (1.0 + math.log1p(play_count or 1)) * _decay(last_played)
        artist_weight[key] = artist_weight.get(key, 0) + w
        artist_display.setdefault(key, effective_artist)
        genre = track.genre or infer_genre_from_text(effective_title, effective_artist)
        if genre:
            genres.append(genre)
        weighted_titles.append((effective_title, w))
        if track.source == "ytmusic" and track.external_id and track.external_id not in seen_seed:
            seeds.append(track.external_id)
            seen_seed.add(track.external_id)

    # Штраф за скипы: сам трек исключаем из волны совсем, артисту снижаем вес
    # (задолбавший артист вылетает из топа, а сид от его трека не выбирается).
    skipped_ids: set = set()
    skipped_keys: set = set()
    skipped_video_ids: set = set()
    for track, skip_count, last_skipped, disliked in skipped:
        effective_artist, effective_title = effective_track_artist_title(track)
        skipped_ids.add(track.id)
        skipped_keys.add(_norm_key(effective_artist, effective_title))
        if track.external_id:
            skipped_video_ids.add(track.external_id)
        key = artist_key(effective_artist)
        # Явный дизлайк весомее случайного скипа и не затухает: пользователь
        # сказал «не хочу» осознанно. Вес подобран так, чтобы один дизлайк
        # перебивал один лайк (+3.0) и уводил артиста в banned_artists.
        penalty = (
            _DISLIKE_ARTIST_PENALTY
            if disliked
            else 1.5 * math.log1p(skip_count or 1) * _decay(last_skipped)
        )
        artist_weight[key] = artist_weight.get(key, 0) - penalty
        artist_display.setdefault(key, effective_artist)

    # A fast external skip is recorded before materialisation.  The durable
    # telemetry identity must therefore exclude the provider item directly;
    # otherwise a failed/slow import loses the user's strongest negative signal.
    external_skip_rows = db.execute(
        select(
            recommendation_events.c.source,
            recommendation_events.c.external_id,
            recommendation_events.c.artist,
            recommendation_events.c.title,
        ).where(
            recommendation_events.c.user_id == user_id,
            recommendation_events.c.surface == "flow",
            recommendation_events.c.event_type == "skip",
        ).order_by(recommendation_events.c.occurred_at.desc()).limit(
            _TASTE_QUERY_LIMIT
        )
    ).all()
    skipped_external_ids = set()
    for source, external_id, artist, title in external_skip_rows:
        if source and external_id:
            skipped_external_ids.add(f"{source}:{external_id}")
            if source == "ytmusic":
                skipped_video_ids.add(external_id)
        if artist and title:
            skipped_artist, skipped_title = effective_artist_title(
                title,
                artist,
                source=source or "",
            )
            skipped_keys.add(_norm_key(skipped_artist, skipped_title))

    # --- Явные предпочтения пользователя (онбординг/настройки) ---
    # Встраиваем ПЕРЕД финализацией профиля как сильный позитивный
    # сигнал. Ключевой смысл — «холодный старт»: у нового юзера нет
    # истории, и без этого поток свёлся бы к глобально популярному.
    # Явные артисты/жанры ведут себя как курированные (лайки/плейлисты) и
    # участвуют в локальной и provider-генерации с сильным весом.
    pref = (
        db.query(User.preferred_genres, User.preferred_artists, User.excluded_artists)
        .filter(User.id == user_id)
        .first()
    )
    pref_genres = list(pref[0] or []) if pref else []
    pref_artists = list(pref[1] or []) if pref else []
    excluded_artists = {
        artist_key(name) for name in (list(pref[2] or []) if pref else []) if artist_key(name)
    }
    excluded_artists -= {artist_key(name) for name in pref_artists if artist_key(name)}

    for name in pref_artists:
        key = artist_key(name)
        if not key:
            continue
        non_imported_artist_keys.add(key)
        # Вес сопоставим с курированием (плейлист=2.0); не затухает по
        # времени — это осознанный устойчивый выбор пользователя.
        artist_weight[key] = artist_weight.get(key, 0) + 2.5
        artist_display.setdefault(key, name)
        if key not in seen_curated_artist:
            curated_artist_keys.append(key)
            seen_curated_artist.add(key)
        if key not in seen_catalog_artist:
            catalog_artist_keys.append(key)
            seen_catalog_artist.add(key)
        if key not in seen_pl_artist:
            playlist_artist_keys.append(key)
            seen_pl_artist.add(key)

    # Явные жанры — добавляем с частотой (даёт вес в genre_counts и
    # приоритет ключевых слов при подборе локальных кандидатов).
    for g in pref_genres:
        genres.extend([g, g])

    # Сиды-радио от треков любимых артистов, уже присутствующих в
    # каталоге как ytmusic (усиливает «холодный старт»: радио строится
    # вокруг выбора юзера, а не глобального топа).
    if pref_artists:
        pref_keys = [k for k in (artist_key(n) for n in pref_artists) if k]
        if pref_keys:
            pref_seed_rows = (
                db.query(Track.external_id)
                .filter(
                    Track.source == "ytmusic",
                    Track.external_id.isnot(None),
                    func.lower(Track.artist).in_(pref_keys),
                )
                .order_by(desc(Track.play_count))
                .limit(20)
                .all()
            )
            for (vid,) in pref_seed_rows:
                if vid and vid not in seen_seed and vid not in skipped_video_ids:
                    seeds.append(vid)
                    seen_seed.add(vid)

    # Сиды от скипнутых треков не годятся — радио от них тянет то же самое.
    seeds = [s for s in seeds if s not in skipped_video_ids]

    # Недавно игранное — исключаем из потока, чтобы волна не повторялась.
    recent = (
        db.query(Track)
        .join(user_track_plays, user_track_plays.c.track_id == Track.id)
        .filter(user_track_plays.c.user_id == user_id)
        .order_by(desc(user_track_plays.c.last_played))
        .limit(_RECENT_PLAYS_EXCLUDE)
        .all()
    )
    # Плейлистные треки уже в коллекции — тоже исключаем из потока.
    pl_tracks = [t for t, *_ in playlisted]
    recent_ids = {t.id for t in recent} | skipped_ids | {t.id for t in pl_tracks}
    recent_keys = (
        {
            _norm_key(*effective_track_artist_title(t))
            for t in recent
        }
        | skipped_keys
        | {
            _norm_key(*effective_track_artist_title(t))
            for t in pl_tracks
        }
    )
    recent_video_ids = (
        {t.external_id for t in recent if t.external_id}
        | skipped_video_ids
        | {t.external_id for t in pl_tracks if t.external_id}
    )

    # Холодный старт: нет НИ сидов, НИ курированных артистов — берём популярные
    # ytmusic-треки сервиса. НЕ фиксированный топ-5 (тогда у ВСЕХ бессидовых
    # юзеров волна одинаковая — одни и те же сиды → один и тот же radio-пул), а
    # стабильная выборка из широкого пула популярного: у каждого юзера свой
    # набор сидов, при этом решение можно воспроизвести офлайн.
    #
    # Если курированные артисты ЕСТЬ, глобальный топ брать нельзя: это чужая
    # библиотека. Своих ytmusic-треков может не быть вовсе (вся коллекция в
    # SoundCloud), и тогда любителю русского рэпа сюда попадал ню-метал другого
    # пользователя сервиса, а радио строилось вокруг него. Сиды для такого
    # случая резолвит эндпоинт по именам артистов (_artist_seed_videos).
    #
    # Своим сигналом считаем ЛЮБОЙ положительный вес, а не только курирование:
    # библиотека из одиночных импортов ни одного артиста до порога любимого
    # (_PLAYLIST_ARTIST_MIN_TRACKS) не дотягивает, но вкус у такого юзера есть —
    # чужой глобальный топ ему тем более противопоказан.
    has_own_signal = any(w > 0 for w in artist_weight.values())
    if not seeds and not curated_artist_keys and not has_own_signal:
        popular_yt = (
            db.query(Track.external_id)
            .filter(Track.source == "ytmusic", Track.external_id.isnot(None))
            .order_by(desc(Track.play_count))
            .limit(60)
            .all()
        )
        pool = [r[0] for r in popular_yt if r[0] not in skipped_video_ids]
        seeds = sorted(
            pool,
            key=lambda value: stable_jitter(user_id, f"cold-seed:{value}"),
            reverse=True,
        )[:5]

    # Артисты вкуса — только с положительным итоговым весом. Порядок взвешенный,
    # а не фиксированный топ по весу: endpoint дополнительно ротирует его по
    # flow-history. Фиксированный top-N
    # означал, что каждая подгрузка волны собирает кандидатов вокруг одних и
    # тех же нескольких имён, а остальная библиотека юзера не доходит до
    # выдачи вообще. Берём шире (_FLOW_ARTISTS из всех положительных).
    positive_keys = [a for a, w in artist_weight.items() if w > 0]
    # Keep the helper call's small public signature: callers/tests may provide
    # a lightweight two-argument implementation. Flow applies its per-request
    # context when selecting seeds below, so the profile itself remains a
    # deterministic value object.
    topartist_keys = weighted_order(positive_keys, artist_weight)[:_FLOW_ARTISTS]
    top_artists = [artist_display.get(a, a) for a in topartist_keys]
    # Артисты, ушедшие в минус, — фильтр для радио-кандидатов.
    banned_artists = {a for a, w in artist_weight.items() if w < 0}
    banned_artists |= excluded_artists
    for key in excluded_artists:
        artist_weight.pop(key, None)
        artist_display.pop(key, None)
        curated_artist_keys[:] = [a for a in curated_artist_keys if a != key]
        catalog_artist_keys[:] = [a for a in catalog_artist_keys if a != key]
        playlist_artist_keys[:] = [a for a in playlist_artist_keys if a != key]
    topartist_keys = [key for key in topartist_keys if key not in excluded_artists]
    top_artists = [artist_display.get(key, key) for key in topartist_keys]

    # Плейлистные артисты для SoundCloud-генерации: свежие первыми,
    # заскипанные в минус исключаются.
    playlist_artists = [
        artist_display.get(k, k)
        for k in playlist_artist_keys
        if k not in banned_artists
    ]
    # Сиды-производные плейлистов (ytmusic) — исключаем скипнутые.
    playlist_seeds = [s for s in playlist_seeds if s not in skipped_video_ids]

    # Сиды для похожести по НАЗВАНИЮ (beets_similar → Last.fm). В отличие от
    # radio-сидов это не videoId, а пара артист+название, поэтому годится любой
    # курированный трек — в том числе из SoundCloud-библиотеки, у которой
    # ytmusic-сидов не бывает вовсе. Лайк идёт раньше плейлиста: это адресный
    # сигнал именно про ЭТОТ трек, а плейлист бывает и импортированным.
    seed_tracks: List[tuple] = []
    seen_seed_track = set()
    for track, _added_at in liked:
        effective_artist, effective_title = effective_track_artist_title(track)
        key = _norm_key(effective_artist, effective_title)
        if key in skipped_keys or key in seen_seed_track:
            continue
        if not effective_artist or not effective_title:
            continue
        if artist_key(effective_artist) in excluded_artists:
            continue
        seen_seed_track.add(key)
        seed_tracks.append((effective_artist, effective_title))
        if len(seed_tracks) >= _SEED_TRACK_LIMIT:
            break
    for track, _added_at, _origin in playlisted:
        effective_artist, effective_title = effective_track_artist_title(track)
        key = _norm_key(effective_artist, effective_title)
        if key in skipped_keys or key in seen_seed_track:
            continue
        if not effective_artist or not effective_title:
            continue
        if artist_key(effective_artist) in excluded_artists:
            continue
        seen_seed_track.add(key)
        seed_tracks.append((effective_artist, effective_title))
        if len(seed_tracks) >= _SEED_TRACK_LIMIT:
            break

    acoustic_rows = []
    for track, added_at in liked:
        acoustic_rows.append((track.acoustic_features, 3.0 * _decay(added_at)))
    for track, added_at, origin in playlisted:
        playlist_weight = (
            3.0
            if str(origin or "manual").lower() == "manual"
            else _PLAYLIST_IMPORTED_WEIGHT
        )
        acoustic_rows.append(
            (track.acoustic_features, playlist_weight * _decay(added_at))
        )
    for track, play_count, last_played in played:
        acoustic_rows.append(
            (
                track.acoustic_features,
                (1.0 + math.log1p(play_count or 1)) * _decay(last_played),
            )
        )

    return {
        "user_id": user_id,
        "liked_track_ids": [track.id for track, _added_at in liked],
        "liked_artists": list(
            dict.fromkeys(
                effective_track_artist_title(track)[0]
                for track, _added_at in liked
            )
        ),
        "liked_keys": [
            _norm_key(*effective_track_artist_title(track))
            for track, _added_at in liked
        ],
        "seeds": seeds,
        "seed_tracks": seed_tracks,
        "playlist_artists": playlist_artists,
        "playlist_seeds": playlist_seeds,
        "artists": top_artists,
        "artist_keys": topartist_keys,
        # ``artist_keys`` is the broad positive scope used to keep a user's
        # imported library visible.  Only an imported-only artist below the
        # corroboration threshold is excluded from the trusted bypass; likes,
        # playback history, preferences, and confirmed imports retain the
        # previous behavior.
        "trusted_artist_keys": [
            key
            for key in topartist_keys
            if not (
                key in imported_playlist_artist_keys
                and key not in non_imported_artist_keys
                and playlist_artist_totals[key] < _PLAYLIST_ARTIST_MIN_TRACKS
            )
        ],
        "artist_weight": {k: v for k, v in artist_weight.items() if v > 0},
        "curated_artist_keys": curated_artist_keys,
        "catalog_artists": [artist_display.get(k, k) for k in catalog_artist_keys],
        "genres": list(dict.fromkeys(genres)),
        "genre_counts": dict(Counter(genres)),
        "title_tags": list(build_title_tag_profile(weighted_titles).keys()),
        "banned_artists": banned_artists,
        "prefer_cyrillic": dominant_is_cyrillic(lang_texts),
        "recent_ids": recent_ids,
        "recent_keys": recent_keys,
        "recent_video_ids": recent_video_ids,
        "skipped_external_ids": skipped_external_ids,
        "collection_keys": collection_keys,
        "collection_external_ids": collection_external_ids,
        "acoustic_profile": weighted_centroid(acoustic_rows),
    }


MUSIC_DIR = Path(os.getenv("MUSIC_FILES_DIR", os.path.join(os.path.dirname(__file__), "..", "..", "music_files")))


def _media_available(track: Track) -> bool:
    if track.source == "local" or not track.source:
        if not track.file_path:
            return False
        if storage.is_minio_path(track.file_path):
            return True
        path = MUSIC_DIR / Path(track.file_path).name
        alt = MUSIC_DIR / track.file_path.replace("/music_files/", "")
        return path.is_file() or alt.is_file()
    if track.source == "ytmusic":
        return bool(track.external_id)
    if track.source == "soundcloud":
        return bool(track.stream_url)
    return bool(track.external_id or track.stream_url)


def _local_candidates(db: Session, profile: dict, limit: int, extra_exclude_ids: Optional[set] = None) -> List[Track]:
    """Локальные кандидаты: треки любимых артистов/жанров + популярное (блокирующая)."""
    # Исключаем не только недавнее/скипнутое (recent_ids), но и то, что УЖЕ в
    # очереди фронта (exclude из запроса) — иначе окно limit*6 по play_count
    # раз за разом выдаёт одних и тех же кандидатов, они целиком отсеиваются
    # уже ПОСЛЕ запроса, и подгрузка потока возвращает пусто («волна замирает
    # на первых 15 треках»).
    exclude_ids = set(profile["recent_ids"]) | (extra_exclude_ids or set())
    # Liked tracks are part of the taste profile, not recommendation items.
    # Keep them out of the catalogue query so the returned page contains only
    # uncollected material while the artist signal still opens its catalogue.
    exclude_ids.update(profile.get("liked_track_ids") or [])
    # Уже прослушанные треки исключаем ВСЕ, а не только последние
    # _RECENT_PLAYS_EXCLUDE: recent_ids — окно из 100 записей, и на истории
    # длиннее окна волна возвращала давно сыгранное как «новое». Anti-join
    # подзапросом, а не списком id в Python: история бывает на тысячи треков.
    # Артиста при этом НЕ блокируем — его вес остаётся в профиле и открывает
    # другие, ещё не сыгранные композиции.
    played_ids = select(user_track_plays.c.track_id).where(
        user_track_plays.c.user_id == profile["user_id"]
    )
    collection_track_ids = (
        select(playlist_tracks.c.track_id)
        .select_from(
            playlist_tracks.join(
                Playlist, Playlist.id == playlist_tracks.c.playlist_id
            )
        )
        .where(Playlist.owner_id == profile["user_id"])
    )
    aw = profile.get("artist_weight") or {}
    # Артисты, по которым у ЭТОГО юзера есть собственный сигнал (плей, лайк,
    # плейлист, preferred_artists). Таблица tracks общая и владельца у трека
    # нет, поэтому жанровые/теговые фильтры ниже без такого ограничения
    # выбирают из чужих библиотек: юзер, импортировавший плейлист на 185
    # треков, начинал подмешиваться в волну всем остальным. Открытие НОВЫХ
    # имён — работа разведки (граф артистов / радио / SoundCloud), а не
    # локального пула; см. модульный docstring.
    scope = set(aw) | set(profile.get("curated_artist_keys") or [])
    filters = []
    if profile["artist_keys"]:
        # Регистронезависимо: SoundCloud и YT Music отдают имя одного и того же
        # артиста в разном написании (регистр/пробелы), точное сравнение их
        # разводило по разным "артистам".
        # Старые SoundCloud-строки могут хранить uploader в Track.artist, а
        # реального исполнителя — в начале заголовка. Их отфильтруем в Python
        # после эффективной нормализации.
        filters.append(
            or_(
                func.lower(Track.artist).in_(profile["artist_keys"]),
                Track.source == "soundcloud",
            )
        )
    if profile["genres"]:
        filters.append(Track.genre.in_(profile["genres"]))
        # Ключевые слова из фиксированного жанрового словаря — ловит внешние
        # треки без genre в метаданных, но с явным жанром прямо в заголовке.
        kw_conditions = build_keyword_filters(Track.title, profile.get("genre_counts", {}))
        if kw_conditions:
            filters.append(or_(*kw_conditions))
    if profile.get("title_tags"):
        # Слова, которые пользователь сам "выбрал" тем, что регулярно слушает
        # треки с ними в названии ("гей ремикс" и т.п.) — не привязаны ни к
        # какому заранее прописанному жанру, в отличие от genre_keywords выше.
        # Одиночное неоднозначное слово ("гей") как фильтр НЕ используется —
        # build_tag_filters требует пару тегов и вернёт [] на одном.
        tag_conditions = build_tag_filters(Track.title, profile["title_tags"])
        if tag_conditions:
            filters.append(or_(*tag_conditions))

    # Привязка жанра/темы к артисту целиком (см. artist_genre.py): если хотя
    # бы часть каталога артиста в базе матчит нужные слова, подтягиваем ВСЕ
    # его треки — а не только тот единственный, где слово буквально есть в
    # названии. Без этого при тестовом прослушивании нескольких "гей"-треков
    # в рекомендации попадал только один трек с этим словом в заголовке.
    # Жанровые слова однозначны — хватает одного совпадения; теги вкуса
    # (title_tags) могут быть неоднозначным словом на тему ("гей") — там
    # требуем пару тегов разом, иначе один случайный серьёзный трек с тем же
    # словом у постороннего артиста тянет весь его чужой каталог.
    genreartist_keys = artists_matching_keywords(
        db,
        top_genre_keywords(profile.get("genre_counts", {})),
        restrict_artists=scope or None,
    )
    genreartist_keys |= artists_matching_keywords(
        db,
        profile.get("title_tags") or [],
        min_matches=2,
        restrict_artists=scope or None,
    )
    if genreartist_keys:
        filters.append(
            or_(
                func.lower(Track.artist).in_(genreartist_keys),
                Track.source == "soundcloud",
            )
        )

    # Доверяем только артистам, которых юзер сам добавил в лайки/плейлисты, либо
    # совместимому по жанру/языку треку. Обычная история могла загрязниться
    # предыдущими ошибочными рекомендациями — считать любого сыгранного артиста
    # «жанром пользователя» нельзя. Проверка общая с recommendations.py (taste.py).
    _keep = track_check(
        make_relevance_check(
            trusted_artist_keys=set(
                profile.get("trusted_artist_keys")
                or profile.get("curated_artist_keys")
                or []
            ),
            user_genres=set(profile.get("genres") or []),
            prefer_cyrillic=profile.get("prefer_cyrillic"),
        )
    )

    # Ротация артистов этого запроса (контекстный порядок из профиля) —
    # ею и упорядочиваем кандидатов. Сортировка по artist_weight * play_count
    # давала строго один и тот же порядок при каждой подгрузке: несколько самых
    # тяжёлых артистов забирали все слоты, остальная библиотека не доходила.
    rotation = {k: i for i, k in enumerate(profile["artist_keys"])}

    def _score(t: Track) -> tuple:
        key = artist_key(effective_track_artist_title(t)[0])
        # Артист вне ротации (пришёл по жанру/тегу) — после ротационных, внутри
        # своей группы по популярности.
        return (
            rotation.get(key, len(rotation)),
            -(t.play_count or 0),
            stable_jitter(profile["user_id"], f"local:{t.id}"),
            t.id,
        )

    candidates_by_id: dict[int, Track] = {}
    if filters:
        q = db.query(Track).filter(or_(*filters))
        # Кандидат обязан быть от артиста, по которому у юзера есть свой сигнал.
        # Жанр/ключевое слово/тег сами по себе матчат и чужие треки: слово
        # "phonk" в названии есть и у артиста, которого в базу привёл совсем
        # другой пользователь. Скоуп пуст только при холодном старте — сужать
        # там не до чего, и глобальная выборка остаётся осознанным поведением
        # (см. _taste_profile).
        if scope:
            q = q.filter(
                or_(func.lower(Track.artist).in_(scope), Track.source == "soundcloud")
            )
        if exclude_ids:
            q = q.filter(~Track.id.in_(exclude_ids))
        q = q.filter(~Track.id.in_(collection_track_ids))
        q = q.filter(~Track.id.in_(played_ids))
        # Широкое стабильное окно, а не top по play_count: иначе окно limit*8 —
        # это всегда самые заигранные треки нескольких артистов, и никакая
        # сортировка в Python уже не достанет остальных из библиотеки.
        # A large played catalog must not hide a single unseen track from the
        # same trusted artist simply because a small candidate window hid old rows.
        candidates = q.order_by(Track.id).limit(max(limit * 100, 500)).all()
        for track in candidates:
            effective_artist, _effective_title = effective_track_artist_title(track)
            if (
                (not scope or artist_key(effective_artist) in scope)
                and _keep(track)
                and _media_available(track)
            ):
                candidates_by_id[track.id] = track

    # Добор разрешён только совместимыми со вкусом треками. Раньше сюда без
    # жанровой проверки попадал случайный глобальный top по play_count — именно
    # этот путь подмешивал любителю русского рэпа поп, техно и музыку 90-х.
    # require_signal: трек обязан иметь положительное подтверждение вкуса (жанр,
    # язык или ключевые слова), а не просто «не противоречит». Иначе любой хит
    # без жанра от незнакомого артиста проходил бы проверку и попадал в выдачу.
    if len(candidates_by_id) < limit:
        _keep_strict = track_check(
            make_relevance_check(
                trusted_artist_keys=set(profile.get("curated_artist_keys") or []),
                user_genres=set(profile.get("genres") or []),
                prefer_cyrillic=profile.get("prefer_cyrillic"),
                require_signal=True,
            )
        )
        skip = set(candidates_by_id) | exclude_ids
        q = db.query(Track)
        # Тот же скоуп, что и у основного пула: Track.play_count — счётчик
        # ОБЩИЙ на всех юзеров (инкрементится в tracks.py на любом прослушивании
        # любым юзером), поэтому глобальный топ по нему возглавляет тот, кто
        # последним импортировал большой плейлист, — и его треки ехали в волну
        # всем. Порядок тоже меняем: desc(play_count) детерминирован, а значит
        # добор раз за разом отдавал ОДНУ И ТУ ЖЕ пачку треков — второй, помимо
        # кэша браузера, источник «одной и той же цепочки».
        if scope:
            q = q.filter(
                or_(func.lower(Track.artist).in_(scope), Track.source == "soundcloud")
            )
        if skip:
            q = q.filter(~Track.id.in_(skip))
        q = q.filter(~Track.id.in_(collection_track_ids))
        q = q.filter(~Track.id.in_(played_ids))
        pool = [
            t
            for t in q.order_by(Track.id).limit(limit * 20).all()
            if (
                (not scope or artist_key(effective_track_artist_title(t)[0]) in scope)
                and _keep_strict(t)
                and _media_available(t)
            )
        ]
        pool.sort(key=_score)
        for track in pool:
            candidates_by_id.setdefault(track.id, track)

    # Acoustic similarity is a content candidate source, not a quota.  It can
    # introduce a new artist when the audio profile is a strong match while
    # still respecting private-library isolation and all hard exclusions.
    acoustic_profile = profile.get("acoustic_profile") or {}
    if acoustic_profile:
        other_owner_tracks = (
            select(playlist_tracks.c.track_id)
            .select_from(
                playlist_tracks.join(
                    Playlist, Playlist.id == playlist_tracks.c.playlist_id
                )
            )
            .where(Playlist.owner_id != profile["user_id"])
        )
        acoustic_keep = track_check(
            make_relevance_check(
                trusted_artist_keys=set(),
                user_genres=set(profile.get("genres") or []),
                prefer_cyrillic=None,
                provenance_trusted=True,
            )
        )
        acoustic_rows = (
            db.query(Track)
            .filter(
                Track.acoustic_features.isnot(None),
                ~Track.id.in_(exclude_ids),
                ~Track.id.in_(collection_track_ids),
                ~Track.id.in_(played_ids),
                ~Track.id.in_(other_owner_tracks),
            )
            .order_by(Track.id)
            .limit(max(limit * 100, 500))
            .all()
        )
        for track in acoustic_rows:
            if (
                track.id in candidates_by_id
                or not _media_available(track)
                or not acoustic_keep(track)
                or acoustic_similarity(track.acoustic_features, acoustic_profile)
                < MIN_RECOMMENDATION_SIMILARITY
            ):
                continue
            candidates_by_id[track.id] = track

    candidates = list(candidates_by_id.values())
    candidates.sort(key=_score)

    return candidates


def _local_candidates_on_bind(
    bind,
    profile: dict,
    limit: int,
    extra_exclude_ids: Optional[set] = None,
) -> List[Track]:
    """Run the blocking catalogue query in its own short-lived session."""
    local_db = Session(bind=bind)
    try:
        return _local_candidates(local_db, profile, limit, extra_exclude_ids)
    finally:
        local_db.close()


def _normalize_watch_item(item: dict) -> Optional[ExternalTrackResponse]:
    """Трек из get_watch_playlist → ExternalTrackResponse (ключи отличаются от search)."""
    video_id = item.get("videoId")
    if not video_id:
        return None
    title = clean_title(item.get("title") or "Unknown")
    artists = item.get("artists") or []
    artist = ", ".join(a.get("name", "") for a in artists if a.get("name")).strip() or "Unknown Artist"
    album = None
    alb = item.get("album")
    if isinstance(alb, dict):
        album = alb.get("name")

    # length: строка "3:26"
    dur = 0
    for p in (item.get("length") or "").split(":"):
        if p.strip().isdigit():
            dur = dur * 60 + int(p)

    thumbs = item.get("thumbnail") or item.get("thumbnails") or []
    cover = ytdlp._thumb(thumbs)

    return ExternalTrackResponse(
        id=f"ytmusic:{video_id}",
        source="ytmusic",
        external_id=video_id,
        title=title,
        artist=artist,
        album=album,
        duration=dur,
        cover_url=cover,
        stream_url="",  # заполняется в эндпоинте
        download_url=None,
        download_allowed=False,
        play_count=ytdlp._metric_count(item.get("views")),
    )


def _fetch_radio(seed_video_id: str) -> List[dict]:
    """Радио YT Music от сида (блокирующая). Возвращает сырые items."""
    if ytdlp._ytmusic is None:
        return []
    wp = ytdlp._ytmusic.get_watch_playlist(seed_video_id, radio=True, limit=_RADIO_LIMIT)
    return wp.get("tracks") or []


async def _radio_pool(seed_video_id: str) -> List[ExternalTrackResponse]:
    """Радио-пул от сида с кэшем в Redis (включая негативный — не у каждого
    videoId есть радио, и не гоняем неудачные сиды повторно)."""
    key = f"flow:radio:{seed_video_id}"
    cached = await get_cache_async(key)
    if cached is not None:
        return [ExternalTrackResponse(**t) for t in cached]

    try:
        raw = await asyncio.to_thread(_fetch_radio, seed_video_id)
    except Exception:  # noqa: BLE001
        logger.warning("flow radio failed for seed %s", seed_video_id)
        await set_cache_async(key, [], expire=600)  # негативный кэш — сид без радио
        return []

    pool = []
    for item in raw:
        t = _normalize_watch_item(item)
        # Сам сид тоже приходит первым треком — не отбрасываем, дедуп ниже разберётся.
        if t:
            pool.append(t)

    await set_cache_async(key, [t.model_dump() for t in pool], expire=_RADIO_TTL)
    return pool


async def _lastfm_similar_names(artist: str, title: str) -> List[list]:
    """Похожие на (artist, title) треки как ИМЕНА, с кэшем в Redis.

    Кэш на пару артист+название, а не на пользователя: похожесть — свойство
    самого трека, и у популярного сида она переиспользуется всеми сразу.
    Негативный кэш короткий: Last.fm мог не знать трек сейчас, но узнать
    позже, — вычёркивать сид навсегда не за что (та же логика, что у
    _similar_artist_names).
    """
    norm_artist, norm_title = _norm_key(artist, title)
    key = f"flow:lastfm_similar:{norm_artist}|{norm_title}"
    cached = await get_cache_async(key)
    if cached is not None:
        return cached

    pairs = await beets_similar.similar_tracks_async(
        artist, title, limit=_LASTFM_SIMILAR_LIMIT
    )
    # json не знает про tuple — храним списками, чтобы кэш и свежий ответ
    # выглядели для вызывающего одинаково.
    payload = [[found_artist, found_title] for found_artist, found_title in pairs]
    await set_cache_async(
        key, payload, expire=_LASTFM_NAMES_TTL if payload else 600
    )
    return payload


def _is_same_track(artist: str, title: str, found: ExternalTrackResponse) -> bool:
    """Найденный у провайдера трек — это действительно искомые артист+название?

    Поиск у провайдеров полнотекстовый: по запросу "Artist Title" он с
    готовностью отдаёт чужие треки, где эти слова встретились в названии или
    описании (ровно та проблема, из-за которой фильтруется _soundcloud_pool).
    Имя артиста сверяем через artist_utils.same_artist — он снимает разницу
    алфавита и схемы романизации, — и дополнительно допускаем вхождение в любую
    сторону: у провайдера в поле artist часто стоит "A, B" (фичеринг) или
    сокращение.
    """
    want_artist, want_title = _norm_key(artist, title)
    found_artist, found_title = effective_track_artist_title(found)
    got_artist, got_title = _norm_key(found_artist, found_title)
    if not want_artist or not want_title or not got_artist or not got_title:
        return False
    artist_ok = (
        same_artist(artist, found.artist)
        or want_artist in got_artist
        or got_artist in want_artist
    )
    if not artist_ok:
        return False
    return want_title in got_title or got_title in want_title


async def _resolve_similar(
    request: Request, artist: str, title: str
) -> Optional[ExternalTrackResponse]:
    """Имя похожего трека → играбельный трек у провайдера.

    Last.fm отдаёт только имена, поэтому играбельным трек делает поиск. Оба
    провайдера спрашиваем ОДНОВРЕМЕННО (как в _tag_pool): последовательное
    ожидание удваивало бы задержку на каждом имени, которого нет в YT Music.
    YT Music предпочитаем — у него метаданные ближе к тому, что называет
    Last.fm, и меньше перезаливов.
    """
    query = f"{artist} {title}"
    yt_results, sc_results = await asyncio.gather(
        ytdlp.search_ytmusic(request, query, limit=3),
        soundcloud.search_soundcloud(request, query, limit=3),
        return_exceptions=True,
    )
    for results in (yt_results, sc_results):
        if isinstance(results, Exception):
            logger.warning("flow lastfm resolve failed for %s: %s", query, results)
            continue
        for found in results:
            if _is_same_track(artist, title, found):
                return found
    return None


async def _lastfm_pool(
    request: Request, artist: str, title: str
) -> List[ExternalTrackResponse]:
    """Похожие на трек треки, уже играбельные, с кэшем в Redis.

    Единственный источник похожести на уровне ТРЕКА, не требующий ytmusic-сида
    (см. beets_similar). Резолв ограничен _LASTFM_RESOLVE именами: он стоит по
    поиску на имя, и это самая дорогая часть источника.
    """
    norm_artist, norm_title = _norm_key(artist, title)
    key = f"flow:lastfm_pool:{norm_artist}|{norm_title}"
    cached = await get_cache_async(key)
    if cached is not None:
        return [ExternalTrackResponse(**t) for t in cached]

    names = await _lastfm_similar_names(artist, title)
    if not names:
        return []

    resolved = await asyncio.gather(
        *(
            _resolve_similar(request, pair[0], pair[1])
            for pair in names[:_LASTFM_RESOLVE]
            if len(pair) == 2
        )
    )
    pool = [t for t in resolved if t is not None]
    await set_cache_async(
        key,
        [t.model_dump() for t in pool],
        expire=_LASTFM_POOL_TTL if pool else 600,
    )
    return pool


async def _similar_artist_names(artist: str) -> List[dict]:
    """Соседи артиста по графу YT Music: [{"name", "browse_id"}, ...]."""
    key = f"flow:similar_names:{artist_key(artist)}"
    cached = await get_cache_async(key)
    if cached is not None:
        return cached

    related = await ytdlp.related_ytmusic_artists(artist, limit=_SIMILAR_ARTISTS)
    # Негативный кэш короткий: у нишевого артиста соседей может не быть сейчас,
    # но появиться позже — навсегда его вычёркивать не за что.
    await set_cache_async(
        key, related, expire=_SIMILAR_NAMES_TTL if related else 600
    )
    return related


async def _artist_songs_pool(browse_id: str) -> List[ExternalTrackResponse]:
    """Топ-треки артиста по browseId. Кэш на browseId, а не на пользователя —
    у популярных соседей он общий для всех, кто до них дотянулся."""
    key = f"flow:artist_songs:{browse_id}"
    cached = await get_cache_async(key)
    if cached is not None:
        return [ExternalTrackResponse(**t) for t in cached]

    songs = await ytdlp.ytmusic_artist_songs(browse_id)
    await set_cache_async(
        key,
        [t.model_dump() for t in songs],
        expire=_SIMILAR_TTL if songs else 600,
    )
    return songs


async def _similar_pool(artist: str) -> List[ExternalTrackResponse]:
    """Треки артистов, ПОХОЖИХ на переданного (его собственные не отдаём).

    Это единственный источник похожести, не завязанный на конкретный videoId:
    radio требует ytmusic-трека в профиле, а SoundCloud-разведка — это по сути
    дискография самого артиста (см. _soundcloud_pool), новых имён она не даёт.
    """
    related = await _similar_artist_names(artist)
    browse_ids = [r["browse_id"] for r in related if r.get("browse_id")]
    if not browse_ids:
        return []

    pools = await asyncio.gather(*(_artist_songs_pool(b) for b in browse_ids))
    own = artist_key(artist)
    return [
        t
        for pool in pools
        for t in pool
        if artist_key(effective_track_artist_title(t)[0]) != own
    ]


async def _favorite_artist_pool(request: Request, artist: str) -> List[ExternalTrackResponse]:
    key = f"flow:favorite:{artist_key(artist)}"
    cached = await get_cache_async(key)
    if cached is not None:
        return [ExternalTrackResponse(**t) for t in cached]
    try:
        tracks = await ytdlp.search_ytmusic(request, artist, limit=_FAVORITE_ARTIST_LIMIT)
    except Exception:  # noqa: BLE001
        logger.warning("flow favorite artist search failed for %s", artist)
        tracks = []
    own = artist_key(artist)
    tracks = [
        t
        for t in tracks
        if own and own in artist_key(effective_track_artist_title(t)[0])
    ]
    await set_cache_async(key, [t.model_dump() for t in tracks], expire=_SC_EXPLORE_TTL if tracks else 600)
    return tracks


async def _artist_seed_videos(request: Request, artist: str) -> List[str]:
    """videoId треков артиста в YT Music — сиды радио для юзера, у которого
    своих ytmusic-треков нет. Поиск полнотекстовый, поэтому оставляем только то,
    где артист реально фигурирует в поле artist (как в _soundcloud_pool)."""
    key = f"flow:artist_seed:{artist_key(artist)}"
    cached = await get_cache_async(key)
    if cached is not None:
        return cached

    try:
        found = await ytdlp.search_ytmusic(request, artist, limit=_ARTIST_SEED_LIMIT * 3)
    except Exception:  # noqa: BLE001
        logger.warning("flow artist seed search failed for %s", artist)
        await set_cache_async(key, [], expire=600)
        return []

    own = artist_key(artist)
    videos = [
        t.external_id
        for t in found
        if (
            t.external_id
            and own in artist_key(effective_track_artist_title(t)[0])
        )
    ][:_ARTIST_SEED_LIMIT]
    await set_cache_async(key, videos, expire=_SIMILAR_TTL if videos else 600)
    return videos


async def _soundcloud_pool(
    request: Request, artist: str
) -> List[ExternalTrackResponse]:
    """SoundCloud-«разведка» по любимому артисту с кэшем в Redis.

    Радио у SoundCloud нет — ближайший аналог «похожего» это поиск по имени
    артиста. Кэшируем на артиста, чтобы не дёргать yt-dlp на каждую подгрузку.
    """
    key = f"flow:sc:{artist.lower()}"
    cached = await get_cache_async(key)
    if cached is not None:
        return [ExternalTrackResponse(**t) for t in cached]

    try:
        pool = await soundcloud.search_soundcloud(
            request, artist, limit=_SC_EXPLORE_LIMIT
        )
    except Exception:  # noqa: BLE001
        logger.warning("flow soundcloud failed for artist %s", artist)
        await set_cache_async(key, [], expire=600)
        return []

    # SoundCloud "поиск по артисту" — это полнотекстовый поиск, а не радио: он
    # с готовностью матчит запрос по словам в названии/описании чужих треков.
    # На нетипичных именах (мемные ники, отдельные слова) это даёт кучу
    # результатов вообще от других авторов, никак не похожих на исходного
    # артиста. Оставляем только треки, где искомый артист реально фигурирует
    # в поле artist (в любую сторону — с учётом сокращений/фичеринга).
    query_key = _norm_key(artist, "")[0]
    if query_key:
        pool = [
            t
            for t in pool
            if query_key in _norm_key(effective_track_artist_title(t)[0], "")[0]
            or _norm_key(effective_track_artist_title(t)[0], "")[0] in query_key
        ]

    await set_cache_async(key, [t.model_dump() for t in pool], expire=_SC_EXPLORE_TTL)
    return pool


async def _tag_pool(request: Request, tag: str) -> List[ExternalTrackResponse]:
    """Разведка по пользовательскому тегу — ищем НОВЫЕ треки на SoundCloud и
    YT Music по слову из истории пользователя (title_tags), а не только в
    каталоге уже знакомых артистов. Кэш в Redis, как у _soundcloud_pool.
    """
    key = f"flow:tag:{tag.lower()}"
    cached = await get_cache_async(key)
    if cached is not None:
        return [ExternalTrackResponse(**t) for t in cached]

    sc_results, yt_results = await asyncio.gather(
        soundcloud.search_soundcloud(request, tag, limit=_TAG_EXPLORE_LIMIT),
        ytdlp.search_ytmusic(request, tag, limit=_TAG_EXPLORE_LIMIT),
        return_exceptions=True,
    )

    pool: List[ExternalTrackResponse] = []
    for results in (sc_results, yt_results):
        if isinstance(results, Exception):
            logger.warning("flow tag search failed for tag %s: %s", tag, results)
            continue
        pool.extend(results)

    await set_cache_async(key, [t.model_dump() for t in pool], expire=_TAG_EXPLORE_TTL)
    return pool


def _parse_exclude(exclude: str) -> tuple:
    """Разбирает exclude, не смешивая id разных провайдеров.

    Чистые числа — id локальной БД. Только ``ytmusic:*`` можно использовать
    как videoId и continuation-сид; ``soundcloud:*`` и неизвестные источники
    остаются внешними исключениями, но никогда не передаются в YT Music radio.
    """
    numeric, yt_videos, external_ids = set(), [], set()
    for part in (exclude or "").split(","):
        part = part.strip()
        if not part:
            continue
        if part.isdigit():
            numeric.add(int(part))
            continue
        if ":" not in part:
            continue
        source, external_id = part.split(":", 1)
        if not external_id:
            continue
        external_ids.add(f"{source}:{external_id}")
        if source == "ytmusic" and external_id not in yt_videos:
            yt_videos.append(external_id)
    return numeric, yt_videos, external_ids


def _persisted_flow_history(db: Session, user_id: int, limit: int) -> dict:
    """Recover recent flow history when the shared cache is unavailable.

    Redis is the normal fast path, but a cache outage must not turn a finite
    flow into the same external tracks on every request. Delivery telemetry is
    already durable, so it is a suitable bounded fallback for exclusion and
    artist rotation. Fail closed if an older database has not run telemetry
    migrations yet; the recommendation request itself should still work.
    """
    try:
        # Telemetry is an optional durability layer during rolling deploys.
        # Isolate the probe in a SAVEPOINT: a missing table (or a transient
        # schema error) must not roll back unrelated work already pending in
        # the request's outer transaction.
        with db.begin_nested():
            rows = db.execute(
                select(
                    recommendation_impressions.c.source,
                    recommendation_impressions.c.external_id,
                    recommendation_impressions.c.track_id,
                    recommendation_impressions.c.title,
                    recommendation_impressions.c.artist,
                )
                .where(
                    recommendation_impressions.c.user_id == user_id,
                    recommendation_impressions.c.surface == "flow",
                )
                .order_by(
                    recommendation_impressions.c.shown_at.desc(),
                    recommendation_impressions.c.id.desc(),
                )
                .limit(limit)
            ).mappings().all()
    except Exception:
        logger.debug("durable flow history is unavailable", exc_info=True)
        return {}

    rows.reverse()
    ids = []
    keys = []
    artists = []
    for row in rows:
        source = row.get("source")
        external_id = row.get("external_id")
        track_id = row.get("track_id")
        if source and external_id:
            ids.append(f"{source}:{external_id}")
        elif track_id is not None:
            ids.append(f"local:{track_id}")
        artist, title = effective_artist_title(
            row.get("title") or "",
            row.get("artist") or "",
            source=source or "",
        )
        keys.append(list(_norm_key(artist, title)))
        artists.append(primary_artist_key(artist))
    return {"ids": ids, "keys": keys, "artists": artists}


@router.get("/flow")
async def get_flow(
    request: Request,
    response: Response,
    limit: int = Query(8, ge=5, le=50),
    exclude: str = Query("", max_length=4000),
    hour: Optional[int] = Query(None, ge=0, le=23),
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db),
):
    """Порция персонального потока. exclude — id уже находящихся в очереди."""
    request_id = new_request_id()
    ranking_now = datetime.now(timezone.utc)
    user_id = current_user.id
    # Ответ уникален для каждого запроса (ротация артистов + серверная история),
    # кэшировать его нельзя ни на секунду. Прокси это и так запрещает (см.
    # `location = /api/recommendations/flow` в nginx.conf и в
    # snippets/app-locations.conf), но dev-путь через vite-прокси на :3000 идёт
    # мимо nginx вообще — там защититься можно только отсюда. Кэш браузера уже
    # приводил к тому, что после перезагрузки волна играла ту же цепочку: запрос
    # не доходил до бэкенда, flow:history не двигалась, ротация не работала.
    response.headers["Cache-Control"] = "no-store"
    base_url = str(request.base_url).rstrip("/")
    excl_ids, client_yt_videos, external_exclude = _parse_exclude(exclude)

    # Сначала сохраняем клиентские YT id как continuation-сиды, затем добавляем
    # серверную историю к строгим исключениям. История не должна сама бесконечно
    # раздувать список сетевых сидов.
    continuation_seeds = client_yt_videos[-_CONTINUATION_SEEDS:]
    # v2 сбрасывает чрезмерно строгую историю прошлой версии, из-за которой
    # после нескольких запусков весь небольшой локальный пул оказывался исключён.
    history_key = f"flow:history:v2:{user_id}"
    history = await get_cache_async(history_key) or {}
    if not any(history.get(name) for name in ("ids", "keys", "artists")):
        history = _persisted_flow_history(db, user_id, _FLOW_HISTORY_LIMIT)
    history_ids = set(history.get("ids") or [])
    history_keys = {
        tuple(key) for key in (history.get("keys") or [])
        if isinstance(key, list) and len(key) == 2
    }
    ranking_context = (
        f"flow:{user_id}:"
        + "|".join(str(value) for value in list(history.get("ids") or [])[-50:])
    )

    explore_ratio = discovery_ratio(current_user)
    profile = await asyncio.to_thread(_taste_profile, db, user_id)
    contextual_profile = build_context_profile(
        db, user_id, hour_bucket(hour), now=ranking_now
    )
    # Дальше идут секунды сетевых ожиданий (radio YT Music + поиск SoundCloud),
    # а сессия всё это время держала бы соединение открытым в состоянии
    # `idle in transaction` — под нагрузкой пул исчерпывается на ожидании сети,
    # а не на работе с БД. Закрываем: profile — уже готовый dict из примитивов,
    # а _local_candidates ниже возьмёт из пула новое соединение (сессия
    # переоткрывает его лениво). Нужные данные пользователя уже сохранены в
    # примитивах, поэтому после close к detached ORM-объекту не обращаемся.
    telemetry_bind = db.get_bind()
    db.close()

    score_by_item: dict[str, float] = {}
    selected_scores: dict[str, float] = {}
    content_bonus_by_identity: dict[str, float] = {}
    external_population: dict[str, dict] = {}

    def _item_artist_title(item) -> tuple[str, str]:
        if isinstance(item, dict):
            return effective_artist_title(
                item.get("title", ""),
                item.get("artist", ""),
                source=item.get("source", ""),
                album=item.get("album", ""),
            )
        return effective_track_artist_title(item)

    def _item_identity(item) -> str:
        source = item.get("source") if isinstance(item, dict) else getattr(item, "source", None)
        external_id = (
            item.get("external_id")
            if isinstance(item, dict)
            else getattr(item, "external_id", None)
        )
        item_id = item.get("id") if isinstance(item, dict) else getattr(item, "id", None)
        if source and external_id:
            return f"{source}:{external_id}"
        if item_id is not None:
            return f"local:{item_id}"
        artist, title = _item_artist_title(item)
        return ":".join(_norm_key(artist, title))

    def _flow_score(item, *, content_bonus: Optional[float] = None) -> float:
        identity = _item_identity(item)
        if content_bonus is None:
            content_bonus = content_bonus_by_identity.get(identity, 0.0)
        score_key = f"{identity}:{content_bonus:.3f}"
        if score_key in score_by_item:
            return score_by_item[score_key]
        artist, _title = _item_artist_title(item)
        key = artist_key(artist)
        population = external_population.get(identity) or {}
        item_play_count = (
            item.get("play_count", 0)
            if isinstance(item, dict)
            else getattr(item, "play_count", 0)
        ) or 0
        item_listener_count = (
            item.get("unique_listener_count", 0)
            if isinstance(item, dict)
            else getattr(item, "unique_listener_count", 0)
        ) or 0
        score = score_track(
            item,
            user_id=user_id,
            artist_affinity=(profile.get("artist_weight") or {}).get(key, 0.0),
            genres=profile.get("genres") or (),
            novelty=key not in (profile.get("artist_weight") or {}),
            source=item.get("source") if isinstance(item, dict) else getattr(item, "source", None),
            play_count=max(item_play_count, population.get("play_count", 0)),
            listener_count=max(
                item_listener_count, population.get("listener_count", 0)
            ),
            content_bonus=content_bonus,
            acoustic_profile=profile.get("acoustic_profile"),
            context_bonus=context_bonus(item, contextual_profile),
            population_quality=population.get("quality", 0.0),
            now=ranking_now,
        )
        is_novel_artist = key not in (profile.get("artist_weight") or {})
        # Keep the score itself continuous. A higher discovery target is
        # enforced after ranking, so relevance still decides which new tracks
        # fill the requested new-artist portion.
        score += (explore_ratio - 0.2) * (1.8 if is_novel_artist else -0.2)
        score_by_item[score_key] = score
        return score

    def _rank_pool(items, *, label: str):
        indexed = list(enumerate(items))
        indexed.sort(
            key=lambda pair: (
                -_flow_score(pair[1]),
                # Provider order is a relevance/popularity signal.  Keep it for
                # score ties instead of promoting a deep result by random hash.
                pair[0],
                stable_jitter(
                    ranking_context, f"{label}:{_item_identity(pair[1])}"
                ),
                _item_identity(pair[1]),
            )
        )
        return [item for _index, item in indexed]
    excl_ids |= profile["recent_ids"]
    excl_videos = (
        set(client_yt_videos)
        | set(profile["recent_video_ids"])
        | set(profile.get("collection_external_ids") or [])
    )
    external_exclude |= set(profile.get("skipped_external_ids") or [])
    for item_id in history_ids:
        # Локальный каталог конечен: не блокируем его на 6 часов. Уже стоящие в
        # очереди id всё равно приходят в exclude, а recent_ids защищает от
        # немедленного повтора. Долгая блокировка была причиной выдачи из 1 трека.
        if item_id.startswith("ytmusic:"):
            excl_videos.add(item_id.split(":", 1)[1])
        elif not item_id.startswith("local:"):
            external_exclude.add(item_id)
    # Долгая history_keys также блокировала локальные треки по artist/title даже
    # после того, как local:id перестал исключаться. Для текущей очереди хватает
    # client exclude, а от немедленных повторов защищает недавняя история БД.
    seen_keys = set(profile["recent_keys"])
    # Library tracks already selected by the user must not re-enter through a
    # provider's artist search, regardless of the requested page size.
    seen_keys.update(tuple(key) for key in profile.get("liked_keys") or [])
    seen_keys.update(profile.get("collection_keys") or set())

    # --- разведка: радио YT Music от сидов + поиск SoundCloud по любимым артистам ---
    # Не у каждого videoId есть радио, поэтому перебираем сиды волнами по 2,
    # пока не наберём достаточно СВЕЖИХ (после исключений) кандидатов.
    # До финального объединения держим происхождение кандидата отдельно, чтобы
    # точному каталогу и track-similar источнику дать разные soft-confidence.
    favorite_explore: List[ExternalTrackResponse] = []
    similar_explore: List[ExternalTrackResponse] = []
    explore: List[ExternalTrackResponse] = []
    banned = profile["banned_artists"]

    # Источники ниже только генерируют кандидатов. При дефолтном значении
    # настройка остаётся мягким prior, но явно поднятый ползунок получает
    # минимальную цель новых артистов на эту порцию.
    discovery_target = (
        discovery_slots(limit, explore_ratio)
        if explore_ratio > DEFAULT_DISCOVERY_RATIO
        else 0
    )

    def _add_explore(tracks, target: Optional[List[ExternalTrackResponse]] = None) -> None:
        # Дедуп и исключения применяем СРАЗУ при добавлении: решение «нужна ли
        # ещё волна радио» должно приниматься по числу свежих кандидатов.
        # Раньше волны останавливались на первом непустом СЫРОМ пуле, а
        # фильтрация исключений шла в самом конце — при подгрузке продолжения
        # кэшированный радио-пул (TTL 30 мин) целиком оказывался уже в очереди,
        # explore выходил пустым, и волна «замирала» на первых ~15 треках.
        for t in tracks:
            effective_artist, effective_title = effective_track_artist_title(t)
            key = _norm_key(effective_artist, effective_title)
            external_key = f"{t.source}:{t.external_id}"
            if (
                t.external_id in excl_videos
                or external_key in external_exclude
                or key in seen_keys
            ):
                continue
            # Артист, заскипанный в минус, не попадает в волну и из радио.
            if banned and any(
                artist_key(a) in banned for a in effective_artist.split(",")
            ):
                continue
            # Треки без рабочего источника не добавляем: ytmusic без external_id
            # или soundcloud без stream_url не смогут играться.
            if t.source == "ytmusic" and not t.external_id:
                continue
            if t.source == "soundcloud" and not t.stream_url:
                continue
            seen_keys.add(key)
            excl_videos.add(t.external_id)
            # ytmusic отдаёт пустой stream_url (нужен base_url); у soundcloud он
            # уже проставлен search-ом с токеном — не перетираем.
            if t.source == "ytmusic":
                t.stream_url = f"{base_url}/api/ytdlp/stream/{t.external_id}"
            (explore if target is None else target).append(t)

    # YT Music радио — это чужой алгоритм "похожести" от YouTube, никак не
    # завязанный на наши жанр/тег-фильтры. Когда у пользователя уже есть
    # выраженный вкусовой сигнал (жанр-ключевые слова или title_tags), он явно
    # ожидает поток В ТЕМУ ("даже когда 23 трека соответствуют теме, в потоке
    # появляются рандомные треки") — поэтому радио-результаты в этом случае
    # дополнительно фильтруем по совпадению с темой. Без сигнала (холодный
    # старт) фильтр пуст и радио остаётся как есть — иначе новым пользователям
    # без истории показывать было бы нечего.
    taste_keywords = [
        kw.lower()
        for kw in (
            top_genre_keywords(profile.get("genre_counts", {}))
            + list(profile.get("title_tags") or [])
        )
    ]

    # Та же проверка, что и для локальных кандидатов и для /recommendations
    # (taste.py). У внешних треков genre всегда пуст, поэтому решает жанр по
    # названию, а если он неопределим — язык библиотеки, и лишь затем
    # тематические слова.
    _matches_taste = track_check(
        make_relevance_check(
            trusted_artist_keys=set(profile.get("curated_artist_keys") or []),
            user_genres=set(profile.get("genres") or []),
            prefer_cyrillic=profile.get("prefer_cyrillic"),
            keywords=taste_keywords,
        )
    )
    # Кандидаты, добытые расширением курированного артиста (радио от его трека,
    # сосед по графу артистов, его же дискография в SoundCloud). Их родословная
    # — уже сигнал вкуса, поэтому неопределимый жанр им не в укор: у похожего
    # артиста нет ни genre в метаданных, ни слова «рэп» в названии, и обычная
    # проверка отбраковывала ПОХОЖИХ подчистую, оставляя в волне ровно тех
    # артистов, которых пользователь и так уже выбрал сам.
    _matches_related = track_check(
        make_relevance_check(
            trusted_artist_keys=set(profile.get("curated_artist_keys") or []),
            user_genres=set(profile.get("genres") or []),
            prefer_cyrillic=profile.get("prefer_cyrillic"),
            keywords=taste_keywords,
            provenance_trusted=True,
        )
    )

    # Сиды всегда берём из подтверждённого профиля пользователя. Переходы от
    # рекомендованного трека к его radio создавали жанровый дрейф на каждом
    # следующем hop. Случайная ротация по широкому набору профильных сидов даёт
    # новые пулы без ухода от русского рэпа к поп/техно/ретро.
    # Плейлистные сиды идут первыми, потому что сохраняют явный контекст
    # коллекции; их кандидаты всё равно конкурируют с остальными общим score.
    profile_seeds = list(dict.fromkeys(profile["playlist_seeds"]))
    if not profile_seeds:
        profile_seeds = list(dict.fromkeys(profile["seeds"]))
    profile_seeds.sort(
        key=lambda value: stable_jitter(ranking_context, f"profile-seed:{value}"),
        reverse=True,
    )
    seeds = profile_seeds[:_PROFILE_SEEDS]

    # Артисты вкуса, вокруг которых строим разведку этой подгрузки. Порядок в
    # profile["artists"] здесь ротируется хэшем текущей history, поэтому это
    # не фиксированный top.
    trusted_artist_keys = set(profile.get("trusted_artist_keys") or [])
    similar_artists = sorted(
        [
            artist
            for artist in profile["artists"]
            if artist_key(artist) in trusted_artist_keys
        ],
        key=lambda value: stable_jitter(ranking_context, f"similar-artist:{value}"),
        reverse=True,
    )[:_SIMILAR_SEED_ARTISTS]

    # Своих ytmusic-сидов может не быть вовсе — вся коллекция в SoundCloud.
    # Резолвим сид по ИМЕНИ курированного артиста: глобально популярное здесь
    # брать нельзя, это чужая библиотека (см. _taste_profile).
    if not seeds and similar_artists:
        resolved = await asyncio.gather(
            *(_artist_seed_videos(request, a) for a in similar_artists)
        )
        seeds = [v for videos in resolved for v in videos][:_PROFILE_SEEDS]

    logger.debug(
        "flow seeds user=%s continuation=%d profile=%d similar=%d history=%d",
        user_id,
        len(continuation_seeds),
        len(seeds),
        len(similar_artists),
        len(history_ids),
    )
    # Похожие артисты и радио — оба про НОВОЕ, поэтому запускаем их одной
    # пачкой. Раньше здесь было только радио: когда оно молчит (у юзера нет
    # ytmusic-сидов или провайдер отдал ошибку), разведка обнулялась целиком.
    # Artist catalog lookup is reserved for explicit/liked taste artists. Imported
    # playlists are useful local signals, but must not open a provider catalog for
    # every imported name.
    catalog_artists = list(dict.fromkeys(profile.get("catalog_artists") or []))
    # Curated/liked artists are useful catalog seeds at every page size. A
    # one-track imported playlist is deliberately absent from these profile
    # fields, so imports do not fan out into provider searches by themselves.
    catalog_artists = list(
        dict.fromkeys(
            (profile.get("liked_artists") or [])
            + (profile.get("playlist_artists") or [])
            + catalog_artists
        )
    )
    artist_history = Counter(history.get("artists") or [])
    favorite_artists = sorted(
        enumerate(catalog_artists),
        key=lambda item: (artist_history[artist_key(item[1])], item[0]),
    )
    # Ограничиваем только стоимость сетевой генерации, не число позиций в
    # ответе. Точный каталог каждого выбранного артиста затем конкурирует со
    # всеми остальными кандидатами в общей модели.
    favorite_explore_artists = max(
        _FAVORITE_EXPLORE_ARTISTS,
        min(len(catalog_artists), limit),
    )
    favorite_artists = [artist for _, artist in favorite_artists][:favorite_explore_artists]
    favorite_jobs = [_favorite_artist_pool(request, a) for a in favorite_artists]

    def _needs_more_pools() -> bool:
        """Whether an additional provider call can still widen the ranker."""
        available = len(favorite_explore) + len(similar_explore) + len(explore)
        if available < max(limit * 2, limit + 4):
            return True
        if not discovery_target:
            return False

        familiar_artists = set(profile.get("artist_weight") or {})
        novel_tracks = []
        novel_artists = set()
        for candidate in (*similar_explore, *explore):
            key = artist_key(effective_track_artist_title(candidate)[0])
            if key in familiar_artists:
                continue
            novel_tracks.append(candidate)
            novel_artists.add(key)

        # Keep looking when a large pool is made up of one or two new names:
        # the user asked for discovery, not merely a different provider copy of
        # the same artist. A smaller artist target keeps network work bounded.
        artist_target = min(
            discovery_target,
            max(1, math.ceil(discovery_target / 2)),
        )
        return len(novel_tracks) < discovery_target or len(novel_artists) < artist_target

    # Похожие по ТРЕКУ (Last.fm) держим отдельным списком только до общей
    # фильтрации и статистики качества. Никакого отдельного места в выдаче этот
    # пул не получает. Сиды перемешиваем, чтобы каждая подгрузка не ходила к
    # одному и тому же самому свежему лайку.
    seed_tracks = list(profile.get("seed_tracks") or [])
    seed_tracks.sort(
        key=lambda pair: stable_jitter(ranking_context, f"lastfm-seed:{pair[0]}:{pair[1]}"),
        reverse=True,
    )
    seed_tracks = seed_tracks[:_LASTFM_SEED_TRACKS]
    lastfm_jobs = [_lastfm_pool(request, pair[0], pair[1]) for pair in seed_tracks]

    def _round_robin(pools):
        """Interleave Last.fm pools so the first slots use different seeds."""
        pools = [list(pool) for pool in pools]
        for index in range(max((len(pool) for pool in pools), default=0)):
            for pool in pools:
                if index < len(pool):
                    yield pool[index]

    # Все ограниченные radio-запросы запускаем одновременно. Раньше они шли
    # волнами по два: при большом exclude каждая пустая волна добавляла полный
    # сетевой таймаут, поэтому быстрый пользователь успевал исчерпать очередь.
    discovery = [_radio_pool(seed) for seed in seeds]
    if favorite_jobs or lastfm_jobs or discovery:
        pools = await asyncio.gather(*favorite_jobs, *lastfm_jobs, *discovery)
        favorite_count = len(favorite_jobs)
        lastfm_count = len(lastfm_jobs)
        _add_explore(
            (t for pool in pools[:favorite_count] for t in pool), favorite_explore
        )
        _add_explore(
            (
                t for t in _round_robin(
                    pools[favorite_count : favorite_count + lastfm_count]
                )
                if _matches_related(t)
            ),
            similar_explore,
        )
        _add_explore(
            t
            for pool in pools[favorite_count + lastfm_count :]
            for t in pool
            if _matches_related(t)
        )

    # Граф артистов YT Music — дополнительный генератор кандидатов. Его можно
    # пропустить, когда основной внешний пул уже достаточно широк и цель
    # разведки выполнена; при повышенном ползунке он остаётся нужен, пока цель
    # новых имён не закрыта.
    if similar_artists and _needs_more_pools():
        graph_pools = await asyncio.gather(*(_similar_pool(a) for a in similar_artists))
        _add_explore(
            t for pool in graph_pools for t in pool if _matches_related(t)
        )

    # SoundCloud-разведка: ищем по нескольким любимым артистам. Источник радио
    # у SC нет, поэтому это поиск — зато волна перестаёт быть моно-ytmusic.
    # Уже целевой источник (сам артист — часть вкуса), доп. фильтр по теме не
    # нужен — иначе выкинули бы легитимные треки любимого артиста без тега в
    # заголовке.
    # Плейлистные артисты идут первыми среди SC-запросов, но полученные треки
    # затем ранжируются вместе со всеми остальными источниками.
    sc_artists = list(
        dict.fromkeys(
            profile["playlist_artists"]
            + [
                artist
                for artist in profile["artists"]
                if artist_key(artist) in trusted_artist_keys
            ]
        )
    )[:_SC_EXPLORE_ARTISTS]
    # SoundCloud — резервный источник. Не ждём его сетевые поиски, если YT уже
    # дал достаточно широкий свежий пул.
    if sc_artists and _needs_more_pools():
        sc_pools = await asyncio.gather(
            *(_soundcloud_pool(request, a) for a in sc_artists)
        )
        _add_explore(
            t for pool in sc_pools for t in pool if _matches_related(t)
        )

    # Разведка по тегам вкуса: реально новые треки (в т.ч. от незнакомых
    # авторов). НЕ ищем по одиночному неоднозначному слову ("гей") — провайдеры
    # отдают серьёзные/иностранные треки на тему. Ищем комбинацию top-тегов
    # ("сво гей", "гей порно") — это специфичный русский мем, а не firehose.
    # Нужно минимум 2 значимых тега, иначе разведку по тегам пропускаем.
    tag_words = list(profile.get("title_tags") or [])[:_TAG_EXPLORE_TAGS]
    tag_check = _matches_taste
    if not tag_words:
        # Своих слов у юзера нет — остаются жанры, но наши 12 ключей это общие
        # слова, и склейка двух ("phonk hip-hop") как поисковый запрос у
        # провайдера возвращает мусор. Дерево жанров beets разворачивает вкус в
        # НАСТОЯЩИЕ имена поджанров ("memphis rap", "witch house", "dark wave"),
        # по которым у SoundCloud и YT Music есть каталог. Берём одно контекстно
        # за подгрузку — это ротация разведки, а не фиксированный запрос.
        pool = beets_genre.subgenres(profile.get("genres") or [])
        if pool:
            subgenre = max(
                pool,
                key=lambda value: stable_jitter(ranking_context, f"subgenre:{value}"),
            )
            tag_words = [subgenre]
            # Имя поджанра добавляем в тематические слова ИМЕННО для этого пула:
            # запрос выведен из жанрового профиля юзера, поэтому трек, который
            # сам называет этот поджанр в заголовке, — подтверждённый вкусом
            # кандидат. Без этого треки, найденные по "memphis rap", у юзера с
            # кириллической библиотекой отбраковывались языковым прокси все до
            # одного, и разведка по жанрам не давала ничего.
            tag_check = track_check(
                make_relevance_check(
                    trusted_artist_keys=set(profile.get("curated_artist_keys") or []),
                    user_genres=set(profile.get("genres") or []),
                    prefer_cyrillic=profile.get("prefer_cyrillic"),
                    keywords=taste_keywords + subgenre.split(),
                )
            )
        else:
            tag_words = list(profile.get("genres") or [])[:_TAG_EXPLORE_TAGS]
    # Теговый поиск также остаётся fallback: последовательное ожидание трёх
    # провайдеров было основной причиной долгой подгрузки следующих 15 треков.
    if tag_words and _needs_more_pools():
        query = " ".join(tag_words[:2])
        _add_explore(
            t
            for t in await _tag_pool(request, query)
            if tag_check(t)
        )

    logger.debug(
        "flow explore user=%s favorite=%d similar=%d fresh_candidates=%d excluded_external=%d",
        user_id,
        len(favorite_explore),
        len(similar_explore),
        len(explore),
        len(external_exclude) + len(excl_videos),
    )
    external_population = await asyncio.to_thread(
        _external_population_stats_on_bind,
        telemetry_bind,
        favorite_explore + similar_explore + explore,
        ranking_now,
    )

    def _population_allows_discovery(item) -> bool:
        stats = external_population.get(_item_identity(item)) or {}
        return not population_rejects(
            stats.get("positive_users", 0), stats.get("negative_users", 0)
        )

    # Strong cross-user evidence may remove a discovery candidate. Exact
    # catalogs of explicitly liked artists are only down-ranked: a niche track
    # should not be globally banned from a listener who asked for that artist.
    similar_explore = [t for t in similar_explore if _population_allows_discovery(t)]
    explore = [t for t in explore if _population_allows_discovery(t)]
    # --- локальная библиотека и единый пул ---
    local = await asyncio.to_thread(
        _local_candidates_on_bind,
        telemetry_bind,
        profile,
        limit,
        set(excl_ids),
    )
    local_candidates: List[Track] = []
    for t in local:
        effective_artist, effective_title = effective_track_artist_title(t)
        key = _norm_key(effective_artist, effective_title)
        if t.id in excl_ids or key in seen_keys:
            continue
        if t.external_id and t.external_id in excl_videos:
            continue
        if profile["banned_artists"] and artist_key(effective_artist) in profile["banned_artists"]:
            continue
        seen_keys.add(key)
        excl_ids.add(t.id)
        local_candidates.append(t)

    def _candidate_payload(candidate) -> dict:
        if isinstance(candidate, dict):
            return dict(candidate)
        if isinstance(candidate, ExternalTrackResponse):
            return candidate.model_dump()
        return TrackResponse.model_validate(candidate).model_dump(mode="json")

    # Дедуп по нормализованной паре artist/title тоже важен: один трек может
    # прийти локально, через YT Music и SoundCloud с разными provider id. При
    # совпадении оставляем первый источник: локальный файл, затем точный каталог,
    # затем похожесть и прочую разведку. Треки из лайков и собственных
    # плейлистов сюда намеренно не добавляются: они уже отфильтрованы выше и
    # должны влиять на вкус, но не повторяться в потоке.
    unified_candidates = []
    unified_identities = set()
    unified_keys = set()
    for candidate in (
        *local_candidates,
        *favorite_explore,
        *similar_explore,
        *explore,
    ):
        identity = _item_identity(candidate)
        key = _norm_key(*_item_artist_title(candidate))
        if identity in unified_identities or key in unified_keys:
            continue
        unified_identities.add(identity)
        unified_keys.add(key)
        unified_candidates.append(candidate)
    for candidate in local_candidates:
        content_bonus_by_identity.setdefault(_item_identity(candidate), 0.05)
    for candidate in favorite_explore:
        content_bonus_by_identity.setdefault(_item_identity(candidate), 0.12)
    for candidate in similar_explore:
        content_bonus_by_identity.setdefault(_item_identity(candidate), 0.08)
    ranked_candidates = _rank_pool(
        unified_candidates,
        label="unified",
    )
    # Это мягкая поправка к общей релевантности, а не источник/artist quota.
    # Сильный повтор артиста остаётся доступен на бедном каталоге; близкий по
    # score альтернативный артист поднимается выше. После отбора interleave
    # отвечает только за порядок прослушивания внутри выбранной порции.
    ranked_candidates = soft_artist_rerank(
        ranked_candidates,
        _flow_score,
        artist_of=lambda item: _item_artist_title(item)[0],
        repeat_penalties=(0.0, 0.18, 0.48, 1.0, 1.7, 2.6),
    )
    familiar_artists = set(profile.get("artist_weight") or {})

    def _is_novel(candidate) -> bool:
        artist, _title = _item_artist_title(candidate)
        return artist_key(artist) not in familiar_artists

    selected_candidates = ranked_candidates[:limit]
    if discovery_target:
        novel_candidates = [
            candidate for candidate in ranked_candidates if _is_novel(candidate)
        ]
        novel_selection = []
        novel_artist_keys = set()

        # Prefer one track per new artist first, then use additional tracks from
        # those artists only when the requested target needs them.
        for candidate in novel_candidates:
            key = artist_key(_item_artist_title(candidate)[0])
            if key in novel_artist_keys:
                continue
            novel_artist_keys.add(key)
            novel_selection.append(candidate)
            if len(novel_selection) >= discovery_target:
                break
        if len(novel_selection) < discovery_target:
            selected_ids = {id(candidate) for candidate in novel_selection}
            novel_selection.extend(
                candidate
                for candidate in novel_candidates
                if id(candidate) not in selected_ids
            )
            novel_selection = novel_selection[:discovery_target]

        selected_ids = {id(candidate) for candidate in novel_selection}
        remaining_candidates = [
            candidate
            for candidate in ranked_candidates
            if id(candidate) not in selected_ids
        ]
        selected_candidates = novel_selection + remaining_candidates
        selected_candidates = selected_candidates[:limit]

    mix: List[dict] = [
        _candidate_payload(candidate) for candidate in selected_candidates
    ]
    selected_scores = {
        _item_identity(candidate): _flow_score(candidate)
        for candidate in selected_candidates
    }

    n_explore = sum(
        1
        for item in mix
        if artist_key(_item_artist_title(item)[0])
        not in (profile.get("artist_weight") or {})
    )
    n_exploit = len(mix) - n_explore
    # Хвост артистов прошлых порций — иначе разнос работал только внутри одной
    # выдачи, и на стыке подгрузок артист снова шёл почти подряд.
    mix = interleave_artists(
        mix,
        artist_getter=lambda item: _item_artist_title(item)[0],
        min_gap=_MIN_ARTIST_GAP,
        previous_artists=history.get("artists") or [],
        context=ranking_context,
    )

    # Attach one stable attribution envelope to every delivered item. It is
    # written before the response so the client can confirm a real impression
    # and later feedback without materialising provider tracks first.
    delivery_scores = {}
    for position, item in enumerate(mix):
        identity = _item_identity(item)
        score = selected_scores.get(identity, _flow_score(item))
        item.update(
            {
                "recommendation_id": request_id,
                "recommendation_surface": "flow",
                "recommendation_position": position,
                "recommendation_score": score,
                "recommendation_model_version": ALGORITHM_VERSION,
            }
        )
        delivery_scores[item.get("id")] = score

    # Запоминаем только реально отданные элементы. Нормализованные ключи режут
    # дубли одного трека между YT Music, SoundCloud и локальным каталогом.
    returned_ids = []
    returned_keys = []
    for item in mix:
        source = item.get("source")
        external_id = item.get("external_id")
        if source and external_id:
            returned_ids.append(f"{source}:{external_id}")
        elif item.get("id") is not None:
            returned_ids.append(f"local:{item['id']}")
        returned_keys.append(list(_norm_key(*_item_artist_title(item))))

    old_ids = list(history.get("ids") or [])
    old_keys = list(history.get("keys") or [])
    await set_cache_async(
        history_key,
        {
            "ids": list(dict.fromkeys(old_ids + returned_ids))[-_FLOW_HISTORY_LIMIT:],
            "keys": [list(k) for k in dict.fromkeys(
                tuple(k) for k in old_keys + returned_keys
                if isinstance(k, (list, tuple)) and len(k) == 2
            )][-_FLOW_HISTORY_LIMIT:],
            # Артисты последних отданных треков нужны только для разноса на
            # стыке подгрузок; source/familiarity budgets здесь больше нет.
            "artists": (
                [a for a in (history.get("artists") or []) if isinstance(a, str)]
                + [primary_artist_key(_item_artist_title(item)[0]) for item in mix]
            )[-_ARTIST_HISTORY:],
        },
        expire=_FLOW_HISTORY_TTL,
    )
    # Network exploration is complete at this point. Use a fresh short-lived
    # session for telemetry so the request never holds a DB connection while
    # waiting on YT Music/SoundCloud.
    telemetry_db = Session(bind=telemetry_bind)
    try:
        record_delivery(
            telemetry_db,
            user_id=user_id,
            items=mix,
            surface="flow",
            request_id=request_id,
            scores=delivery_scores,
            algorithm_version=ALGORITHM_VERSION,
        )
        telemetry_db.commit()
    except Exception:
        telemetry_db.rollback()
        logger.exception("flow delivery telemetry failed user=%s", user_id)
    finally:
        telemetry_db.close()
    logger.debug(
        "flow result user=%s explore=%d exploit=%d returned=%d",
        user_id,
        n_explore,
        n_exploit,
        len(mix),
    )
    return mix
