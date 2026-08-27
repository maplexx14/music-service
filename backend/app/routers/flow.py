"""Персональный бесконечный поток («Моя волна»).

Локальный каталог, лайки, ручные и импортированные плейлисты, Last.fm,
YouTube Music, SoundCloud и жанровые теги генерируют кандидатов, которые
ранжируются общей моделью по поведению пользователя, акустическому профилю
beets/ffmpeg, жанру, контексту, качеству и свежести. Источники не получают
фиксированных мест. ``discovery_ratio`` остаётся мягким приоритетом на
дефолтном значении, а явно повышенный ползунок задаёт минимальную цель новых
артистов с fallback на знакомые треки при дефиците внешнего пула.

Два исключения из «никаких фиксированных мест» — обе стороны этого ползунка, и
обе заданы явной целью, а не веса́ми. Новые артисты получают ``discovery_slots``
при поднятом ползунке, понравившиеся треки — ``liked_slots``, которая наоборот
растёт к «знакомому» краю и обнуляется на максимуме разведки. Лайкам квота нужна
как пол, и сразу по двум причинам. Своего пути в поток у них не было вовсе:
каталожная выборка отсекала их и по id, и как треки плейлиста, и по
нормализованному ключу от провайдеров, — а на общем ранжировании уже слышанный
трек проигрывает свежему кандидату при прочих равных, так что и открытая дорога
сама по себе их бы не привела. Квота же и потолок: сверх неё лайки вытесняли бы
из порции то новое, за чем в поток и приходят (см. ``_liked_candidates`` и отбор
в ``get_flow``).

Last.fm, радио и граф YouTube Music, каталоги любимых артистов, SoundCloud и
жанровые теги расширяют пул. Их происхождение даёт небольшой confidence bonus;
внутри знакомой и новой частей порядок определяет общая модель. Генераторы
могут быть пропущены, когда пул уже широк и цель разведки выполнена.

Особняком стоит один кандидат — трек, который фоновый воркер выбрал СРАВНЕНИЕМ
незнакомых артистов по косинусу к вектору вкуса (см. ``app/artist_probe.py``).
От остальных источников он отличается тем, что за ним стоит измерение, а не
чужое утверждение о похожести, поэтому и confidence bonus у него выше
(``_PROBE_BONUS``), и внутри цели разведки он идёт первым. Фиксированного места
это всё равно не даёт: пик входит в тот же единый пул и может не пройти
ранжирование, а его отсутствие (воркер выключен, вкуса ещё нет, все кандидаты
далеко) поток не меняет никак.

Какой именно трек артист отдаёт в пул, зависит от того, доказал ли он
«любимость» (порог ``_ARTIST_PROVEN_WEIGHT`` по накопленному весу вкуса):
доказанный отдаёт любой трек из глубины каталога, ещё не проверенный — только
популярное, как и артист, найденный «похожим» на знакомое имя. Популярность
здесь — метрика ПЛОЩАДКИ, с которой трек подтянулся (views у YouTube Music,
playback_count у SoundCloud), а не наши внутренние счётчики: у только что
найденного трека их ещё нет.
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
from sqlalchemy import and_, case, desc, func, or_, select, tuple_
from sqlalchemy.orm import Session

from app import artist_probe, beets_genre, beets_similar, storage
from app.cache import get_cache_async, set_cache_async
from app.database import get_db
from app.dependencies import get_current_active_user
from app.discovery import (
    DEFAULT_DISCOVERY_RATIO,
    discovery_ratio,
    discovery_slots,
    liked_slots,
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
    spread_into,
    weighted_order,
)
from app.recommendation_scoring import (
    ALGORITHM_VERSION,
    LOCAL_POPULARITY_REFERENCE,
    SERVICE_POPULARITY_REFERENCE,
    popularity_score,
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
from app.playlist_signals import aggregate_playlist_origin, find_liked_playlist_id
from app.context_profile import build_context_profile, context_bonus, hour_bucket
from app.recommendation_telemetry import new_request_id, record_delivery
from app.artist_utils import (
    artist_key,
    effective_artist_title,
    effective_track_artist_title,
    query_names_artist,
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
# фильтр в обход всех проверок (taste.py — trusted_artist_keys). Так один
# попутный трек из импортированного плейлиста размывал профиль до «подходит всё»
# — особенно с SoundCloud, где артистом трека часто оказывается не исполнитель, а
# перезаливщик (см. artist_utils.resolve_track_artist).
# Порог по артисту, а не по плейлисту: три трека в коллекции — это выбор, один —
# попутный груз импорта. Ниже порога трек остаётся положительным сигналом (жанр,
# язык, скоуп своей библиотеки), но любимым артиста не делает.
# Порог управляет ТОЛЬКО доверием. Доступ к собственному каталогу артиста у
# провайдера он не закрывает (catalog_artist_keys наполняется с первого трека):
# иначе артист с одним-двумя треками не доходил до потока вообще — см. комментарий
# у catalog_artist_keys в _taste_profile.
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
# Порог популярности НА ПЛОЩАДКЕ для поисковой разведки (теги и SoundCloud по
# имени артиста). Это полнотекстовый поиск, а не радио и не каталог артиста:
# выдача забита случайными любительскими загрузками, у которых нет ни нашей
# телеметрии (population_rejects их не отсекает), ни истории у пользователя, —
# зато есть бонус за новизну. В ранжировании они конкурировали на равных,
# поэтому режем их на входе в пул.
#
# Ноль означает «провайдер метрику не прислал» (см. _service_play_count), и такой
# трек порог проходит: иначе мы бы выбросили всю выдачу там, где yt-dlp отдаёт
# плоский результат без счётчиков.
_EXPLORE_MIN_SERVICE_PLAYS = 5_000
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
# Артист «доказал любимость», когда накопленный положительный вес больше, чем
# даёт один сигнал (лайк 3.0, свой плейлист 4.0, явное предпочтение 2.5): два
# лайка, лайк плюс повторные прослушивания, курированный плейлист с историей.
# Доказанному артисту волна берёт ЛЮБОЙ трек каталога, непроверенному — только
# из его популярного: знакомство с новым именем начинается с того, чем оно
# известно, а не со случайного би-сайда.
_ARTIST_PROVEN_WEIGHT = 6.0
# Каталог доказанного артиста должен быть глубже верхушки поиска, иначе «любой
# случайный трек» вырождается в те же пятнадцать популярных.
_FAVORITE_CATALOG_LIMIT = 40
# Сколько треков одного любимого артиста доходит до ранкера за подгрузку. Окно
# не меньше запрошенной порции — иначе у пользователя с одним-двумя артистами
# выдача станет короче, чем он просил.
_FAVORITE_ARTIST_WINDOW = 10
# Сколько понравившихся треков доходит до ранкера за подгрузку (см.
# _liked_candidates). Заметно больше квоты liked_slots: у ранкера должен быть
# выбор, какой именно лайк уместен сейчас по жанру, акустике и контексту, —
# иначе квота каждый раз заполнялась бы одними и теми же треками.
_LIKED_WINDOW = 24
# Сколько трек «остывает» после прослушивания, прежде чем квота лайков может
# отдать его снова. Именно время, а не recent_ids: тот держит последние 100
# прослушиваний, то есть у юзера с короткой историей — вообще всё сыгранное, и
# ни один лайк сквозь него не проходил бы.
_LIKED_REPLAY_COOLDOWN_DAYS = 3
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
# Confidence bonus треку, который фоновый воркер выбрал сравнением артистов по
# косинусу (см. app/artist_probe.py). Выше, чем у соседа по графу (0.08), и
# выше точного каталога любимого артиста (0.12): за этим треком стоит
# измеренная близость к вектору вкуса, а не чужое утверждение о похожести. Но
# ниже явного лайка (0.15) — измерение всё-таки не подтверждение от юзера.
# Места в порции бонус не даёт: пик идёт в общий пул и конкурирует ранжированием.
_PROBE_BONUS = 0.14


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
    liked_playlist_id = find_liked_playlist_id(db, user_id)
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
    # работает порог «любимого» (_PLAYLIST_ARTIST_MIN_TRACKS). Считаем по ВСЕЙ
    # коллекции, а не по окну свежих сигналов: импорт приносит сотни треков
    # разом, поэтому в окно _TASTE_QUERY_LIMIT попадает произвольная его часть, и
    # артист с пятью треками в плейлисте мог не встретиться там ни разу — порог
    # не брал НИКТО из импорта, хотя именно число треков и есть мера любимости.
    # Тот же довод, что у collection_rows выше: исключения и пороги окном не
    # ограничены, окном ограничены только затухающие веса.
    #
    # group_by(Track.id) — трек может лежать в нескольких плейлистах, но в
    # счётчик артиста он должен попасть один раз. Эффективное имя артиста
    # считается в Python: у SoundCloud исполнитель часто сидит в названии
    # ("Artist - Title"), и GROUP BY по Track.artist собрал бы не тех.
    playlist_artist_rows = (
        db.query(
            Track.artist,
            Track.title,
            Track.source,
            Track.album,
            aggregate_playlist_origin().label("playlist_origin"),
        )
        .join(playlist_tracks, playlist_tracks.c.track_id == Track.id)
        .join(Playlist, Playlist.id == playlist_tracks.c.playlist_id)
        .filter(Playlist.owner_id == user_id, Playlist.is_liked == False)
        .group_by(Track.id)
        .all()
    )
    playlist_artist_totals: Counter = Counter()
    playlist_artist_display: dict = {}
    # Ручная курация сильнее импорта, поэтому для артиста она и побеждает.
    playlist_artist_manual: set[str] = set()
    for artist, title, source, album, playlist_origin in playlist_artist_rows:
        effective_artist, _effective_title = effective_artist_title(
            title or "",
            artist or "",
            source=source or "",
            album=album or "",
        )
        key = artist_key(effective_artist)
        playlist_artist_totals[key] += 1
        playlist_artist_display.setdefault(key, effective_artist)
        if str(playlist_origin or "manual").lower() == "manual":
            playlist_artist_manual.add(key)

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
        # Собственный каталог артиста разрешаем запрашивать у провайдера с
        # ПЕРВОГО трека в коллекции. Порог _PLAYLIST_ARTIST_MIN_TRACKS решал
        # сразу два разных вопроса — «доверять ли артисту настолько, чтобы
        # пускать его в обход вкусового фильтра» и «можно ли вообще спросить у
        # провайдера его треки», — и второй ответ делал первый фатальным:
        # импортированный артист с одним-двумя треками не попадал в поток НИ
        # ОДНИМ генератором (в catalog_artists его нет, в trusted_artist_keys
        # нет, а его собственные треки исключены как «уже в коллекции»), при
        # этом оставался в artist_weight и потому не считался и новым. Доступ к
        # каталогу порогом больше не управляется: пользователь сам положил этот
        # трек в свой плейлист и ждёт артиста в потоке. Доверием (curated /
        # trusted выше) порог управляет по-прежнему.
        if key and key not in seen_catalog_artist:
            catalog_artist_keys.append(key)
            seen_catalog_artist.add(key)
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

    # Артист, чьи треки в окно свежих сигналов не попали, всё равно любимый, если
    # их в плейлистах достаточно: у большого импорта (сотни треков с одним
    # added_at) иначе не оказывалось ни одного любимого имени вообще — цикл выше
    # его просто не видел, а значит артист не получал ни веса, ни доступа к
    # собственному каталогу у провайдера, ни места в сидах.
    for key, total in playlist_artist_totals.items():
        if not key or total < _PLAYLIST_ARTIST_MIN_TRACKS:
            continue
        manual = key in playlist_artist_manual
        if manual:
            non_imported_artist_keys.add(key)
        else:
            imported_playlist_artist_keys.add(key)
        artist_display.setdefault(key, playlist_artist_display.get(key, key))
        # Вес начисляем только тем, кого цикл выше не посчитал: иначе один и тот
        # же трек учтётся дважды. Затухания здесь нет — added_at этих треков
        # остался за окном, а членство в плейлисте это состояние, а не событие.
        if key not in artist_weight:
            artist_weight[key] = 4.0 if manual else _PLAYLIST_IMPORTED_WEIGHT
        if key not in seen_curated_artist:
            curated_artist_keys.append(key)
            seen_curated_artist.add(key)
        if key not in seen_catalog_artist:
            catalog_artist_keys.append(key)
            seen_catalog_artist.add(key)
        if key not in seen_pl_artist:
            playlist_artist_keys.append(key)
            seen_pl_artist.add(key)

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

    # Дизлайк — не вкусовой признак, а запрет («не нравится, больше не
    # показывать»), поэтому окном _TASTE_QUERY_LIMIT он НЕ ограничен: тот же
    # довод, что у collection_rows выше. Скипы пишутся автоматически (фронт шлёт
    # их при <25% прослушивания) и набегают сотнями, так что редкое ручное
    # «не хочу» вытеснялось из окна свежими скипами — и дизлайкнутый трек
    # возвращался в волну как ни в чём не бывало. Штраф артисту по-прежнему
    # считается только внутри окна (выше): один старый дизлайк не должен
    # навсегда банить артиста, которого пользователь в остальном слушает.
    disliked_rows = (
        db.query(
            Track.id,
            Track.artist,
            Track.title,
            Track.source,
            Track.external_id,
            Track.album,
        )
        .join(user_track_skips, user_track_skips.c.track_id == Track.id)
        .filter(
            user_track_skips.c.user_id == user_id,
            user_track_skips.c.disliked.is_(True),
        )
        .all()
    )
    for track_id, artist, title, source, external_id, album in disliked_rows:
        disliked_artist, disliked_title = effective_artist_title(
            title or "",
            artist or "",
            source=source or "",
            album=album or "",
        )
        skipped_ids.add(track_id)
        key = _norm_key(disliked_artist, disliked_title)
        if all(key):
            skipped_keys.add(key)
        if external_id:
            # Провайдерский id исключает трек и до материализации: тот же трек
            # приходит из радио/каталога снова именно под ним.
            skipped_video_ids.add(external_id)
            if source:
                skipped_external_ids.add(f"{source}:{external_id}")

    # Дизлайк внешнего трека доходит и телеметрией: материализация могла не
    # успеть или упасть (см. handleDislike во фронте — событие уходит ДО неё),
    # и тогда строки в user_track_skips нет вовсе, а пользователь уже сказал
    # «не хочу». Поверхность здесь не фильтруем, в отличие от скипов выше:
    # «больше не показывать» относится к треку, а не к экрану, где нажали
    # кнопку. Зато учитываем более позднее undislike — снятый дизлайк не должен
    # банить трек навсегда (в user_track_skips его снятие удаляет строку целиком,
    # а журнал событий помнит оба нажатия).
    dislike_event_rows = db.execute(
        select(
            recommendation_events.c.source,
            recommendation_events.c.external_id,
            recommendation_events.c.artist,
            recommendation_events.c.title,
            recommendation_events.c.event_type,
        ).where(
            recommendation_events.c.user_id == user_id,
            recommendation_events.c.event_type.in_(("dislike", "undislike")),
            recommendation_events.c.source.isnot(None),
            recommendation_events.c.external_id.isnot(None),
        ).order_by(recommendation_events.c.occurred_at.desc())
    ).all()
    dislike_verdicts: dict = {}
    for source, external_id, artist, title, event_type in dislike_event_rows:
        # Строки идут от свежих к старым, поэтому первое встреченное решение по
        # треку и есть актуальное.
        dislike_verdicts.setdefault(
            f"{source}:{external_id}", (event_type, source, external_id, artist, title)
        )
    for identity, (event_type, source, external_id, artist, title) in dislike_verdicts.items():
        if event_type != "dislike":
            continue
        skipped_external_ids.add(identity)
        if source == "ytmusic":
            skipped_video_ids.add(external_id)
        if artist and title:
            disliked_artist, disliked_title = effective_artist_title(
                title,
                artist,
                source=source or "",
            )
            key = _norm_key(disliked_artist, disliked_title)
            if all(key):
                skipped_keys.add(key)

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

    def _seed_pairs(rows) -> List[tuple]:
        """Пары (артист, название), годные в сиды похожести; свежие первыми.

        Ключи помечаются в общем seen_seed_track, поэтому вызванный первым
        источник забирает пересечение себе.
        """
        pairs: List[tuple] = []
        for row in rows:
            effective_artist, effective_title = effective_track_artist_title(row[0])
            key = _norm_key(effective_artist, effective_title)
            if key in skipped_keys or key in seen_seed_track:
                continue
            if not effective_artist or not effective_title:
                continue
            if artist_key(effective_artist) in excluded_artists:
                continue
            seen_seed_track.add(key)
            pairs.append((effective_artist, effective_title))
        return pairs

    # Лайки и плейлисты ЧЕРЕДУЕМ, а не дозаполняем одним после другого. Раньше
    # цикл по лайкам добирал _SEED_TRACK_LIMIT первым, и до плейлистов дело не
    # доходило вовсе: у юзера с 20+ лайками импортированная коллекция не давала
    # ни одного сида похожести. Лайк остаётся раньше плейлиста внутри каждого
    # круга — он по-прежнему более адресный сигнал про КОНКРЕТНЫЙ трек.
    liked_pairs = _seed_pairs(liked)
    playlisted_pairs = _seed_pairs(playlisted)
    for index in range(max(len(liked_pairs), len(playlisted_pairs))):
        for pairs in (liked_pairs, playlisted_pairs):
            if index < len(pairs):
                seed_tracks.append(pairs[index])
    seed_tracks = seed_tracks[:_SEED_TRACK_LIMIT]

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
        # Отдельно от recent_ids: тот склеивает скипы с «последними 100
        # прослушиваниями», а квоте лайков нужны именно отрицательные сигналы —
        # у юзера с историей короче окна в recent_ids лежат ВСЕ его сыгранные
        # треки, и лайки не прошли бы вовсе (см. _liked_candidates).
        "skipped_ids": skipped_ids,
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
    # Лайки из КАТАЛОЖНОЙ выборки исключаем: сюда они попадали бы вперемешку с
    # неслышанным и по общему рейтингу всегда ему проигрывали. В поток они идут
    # отдельным путём и по своей квоте — см. _liked_candidates.
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


def _liked_candidates(
    db: Session,
    profile: dict,
    limit: int,
    extra_exclude_ids: Optional[set] = None,
) -> List[Track]:
    """Понравившиеся треки как кандидаты потока (блокирующая).

    Отдельным запросом, а не через ``_local_candidates``: тот исключает всё
    когда-либо сыгранное (``played_ids``) и всё, что лежит в плейлистах юзера
    (``collection_track_ids``), а лайк по определению и сыгран, и лежит в
    плейлисте «Понравившиеся» — под этими двумя условиями он не мог попасть в
    поток НИКОГДА, ни на каком положении ползунка. Здесь задача обратная:
    достать именно их, оставив в силе только те исключения, которые к лайкам
    применимы, — скипы и дизлайки, очередь фронта, забаненные артисты и
    кулдаун ``_LIKED_REPLAY_COOLDOWN_DAYS`` после прослушивания.

    Кулдаун по времени, а НЕ ``recent_ids``: тот склеивает скипы с последними
    ``_RECENT_PLAYS_EXCLUDE`` прослушиваниями, и у юзера с историей короче этого
    окна в нём лежат все его сыгранные треки — квота осталась бы пустой у всех,
    кроме слушателей с огромной историей.

    Порядок — от давно не игранного: заново услышать лайк, до которого волна не
    доходила месяц, ценнее, чем тот, что играл вчера. Никогда не игранный
    (лайкнут из чужого плейлиста и не открыт) идёт самым первым.
    """
    liked_ids = profile.get("liked_track_ids") or []
    if not liked_ids:
        return []
    exclude_ids = set(profile.get("skipped_ids") or ()) | (extra_exclude_ids or set())
    wanted = [track_id for track_id in liked_ids if track_id not in exclude_ids]
    if not wanted:
        return []
    rows = (
        db.query(Track, user_track_plays.c.last_played)
        .outerjoin(
            user_track_plays,
            and_(
                user_track_plays.c.track_id == Track.id,
                user_track_plays.c.user_id == profile["user_id"],
            ),
        )
        .filter(Track.id.in_(wanted))
        .all()
    )

    def _played_seconds(last_played) -> float:
        # Числом, а не самим datetime: last_played приходит из БД то наивным, то
        # с таймзоной, и сортировка смешанного списка падала бы на сравнении
        # aware с naive. Наивное считаем UTC — та же конвенция, что в _decay.
        # Ни разу не игранный — впереди всех.
        if last_played is None:
            return float("-inf")
        if last_played.tzinfo is None:
            last_played = last_played.replace(tzinfo=timezone.utc)
        return last_played.timestamp()

    cooldown_before = (
        datetime.now(timezone.utc) - timedelta(days=_LIKED_REPLAY_COOLDOWN_DAYS)
    ).timestamp()
    banned = profile["banned_artists"]
    ordered: List[tuple] = []
    for track, last_played in rows:
        effective_artist, _effective_title = effective_track_artist_title(track)
        if banned and artist_key(effective_artist) in banned:
            continue
        if not _media_available(track):
            continue
        played_at = _played_seconds(last_played)
        if played_at > cooldown_before:
            continue
        ordered.append(
            (
                played_at,
                stable_jitter(profile["user_id"], f"liked:{track.id}"),
                track.id,
                track,
            )
        )
    ordered.sort(key=lambda row: row[:3])
    return [row[3] for row in ordered][: max(limit, _LIKED_WINDOW)]


def _familiar_candidates_on_bind(
    bind,
    profile: dict,
    limit: int,
    extra_exclude_ids: Optional[set] = None,
    liked_exclude_ids: Optional[set] = None,
    liked_limit: Optional[int] = None,
) -> tuple[List[Track], List[Track]]:
    """Каталог и понравившееся одной короткой сессией: (local, liked).

    Обе выборки блокирующие и обе нужны в один момент, поэтому они делят одну
    сессию и один поток — второй Session ради второго запроса брал бы из пула
    лишнее соединение на то же самое время.

    Исключения у выборок РАЗНЫЕ, и это главное, зачем здесь два параметра.
    Каталогу передают полный ``extra_exclude_ids`` (очередь фронта плюс
    ``recent_ids``), а квоте лайков — только ``liked_exclude_ids``, то есть
    очередь. Дай лайкам полный набор — и ``recent_ids`` («последние 100
    прослушиваний ∪ скипы ∪ треки плейлистов») перекрыл бы им путь ровно так же,
    как это делал каталожный запрос: лайк по определению уже слушали. Когда
    лайку возвращаться, решает ``_LIKED_REPLAY_COOLDOWN_DAYS``.

    ``liked_limit`` — квота этой порции (``None`` = как ``limit``). Нулевая
    квота, то есть ползунок на максимуме разведки, пропускает выборку лайков
    целиком: её результат всё равно был бы отброшен при отборе.
    """
    local_db = Session(bind=bind)
    try:
        if liked_limit is None:
            liked_limit = limit
        liked = (
            _liked_candidates(local_db, profile, liked_limit, liked_exclude_ids)
            if liked_limit > 0
            else []
        )
        return (
            _local_candidates(local_db, profile, limit, extra_exclude_ids),
            liked,
        )
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

    return await _pool_single_flight(
        key, lambda: _lastfm_similar_names_fetch(artist, title)
    )


async def _lastfm_similar_names_fetch(artist: str, title: str) -> List[list]:
    norm_artist, norm_title = _norm_key(artist, title)
    key = f"flow:lastfm_similar:{norm_artist}|{norm_title}"
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


# Single-flight на пулы внешних кандидатов. Ключи пулов НЕ зависят от
# пользователя (только artist/title/tag), поэтому одновременные веера разных
# пользователей с общим вкусом должны ждать ОДНУ задачу, а не плодить
# одинаковые запросы к провайдерам: N юзеров на утреннем пике — это N вееров
# Last.fm/YT/SoundCloud на те же хиты. Регистр живёт в процессе (4 воркера
# gunicorn дадут максимум 4 параллельных веера на один сид — всё лучше N).
# ensure_future, а не await factory(): создателя могут отменить, а задача
# должна дожить до set_cache_async, иначе её результат потеряют все ждущие.
_inflight_pools: dict = {}


def _pool_single_flight(key: str, factory):
    task = _inflight_pools.get(key)
    if task is None:
        task = asyncio.ensure_future(factory())
        _inflight_pools[key] = task
        task.add_done_callback(lambda _t, k=key: _inflight_pools.pop(k, None))
    return task


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
    return await _pool_single_flight(
        key, lambda: _lastfm_pool_fetch(request, artist, title)
    )


async def _lastfm_pool_fetch(
    request: Request, artist: str, title: str
) -> List[ExternalTrackResponse]:
    """Сетевая часть _lastfm_pool — без проверки кэша, под single-flight."""
    norm_artist, norm_title = _norm_key(artist, title)
    key = f"flow:lastfm_pool:{norm_artist}|{norm_title}"
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

    return await _pool_single_flight(
        key, lambda: _similar_artist_names_fetch(artist)
    )


async def _similar_artist_names_fetch(artist: str) -> List[dict]:
    key = f"flow:similar_names:{artist_key(artist)}"
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

    return await _pool_single_flight(
        key, lambda: _artist_songs_pool_fetch(browse_id)
    )


async def _artist_songs_pool_fetch(browse_id: str) -> List[ExternalTrackResponse]:
    key = f"flow:artist_songs:{browse_id}"
    songs = await ytdlp.ytmusic_artist_songs(browse_id)
    await set_cache_async(
        key,
        [t.model_dump() for t in songs],
        expire=_SIMILAR_TTL if songs else 600,
    )
    return songs


def _service_play_count(item) -> int:
    """Прослушивания трека на площадке, с которой он подтянулся.

    Популярность внешнего кандидата — это метрика ПРОВАЙДЕРА (views у YT Music,
    playback_count у SoundCloud; см. _normalize в соответствующих роутерах), а не
    наши собственные счётчики: у только что найденного трека их ещё нет. Ноль
    означает «провайдер метрику не прислал» — тогда порядок остаётся его.
    """
    try:
        return max(0, int(getattr(item, "play_count", 0) or 0))
    except (TypeError, ValueError):
        return 0


def _drop_service_unpopular(
    pool, floor: int = _EXPLORE_MIN_SERVICE_PLAYS
) -> List[ExternalTrackResponse]:
    """Отсечь по метрике площадки то, что нашлось поиском, а не радио.

    Трек без метрики (ноль — «провайдер не прислал») остаётся: у yt-dlp плоская
    выдача бывает вообще без счётчиков, и жёсткий порог выбросил бы её целиком.
    """
    kept = []
    for item in pool:
        plays = _service_play_count(item)
        if plays == 0 or plays >= floor:
            kept.append(item)
    return kept


def _by_service_popularity(pool) -> List[ExternalTrackResponse]:
    """Пул артиста в порядке популярности на его площадке.

    При равной (в том числе неизвестной) метрике сохраняется порядок провайдера:
    выдача страницы артиста и так отсортирована его популярным вперёд.
    """
    return [
        item
        for _rank, item in sorted(
            enumerate(pool),
            key=lambda pair: (-_service_play_count(pair[1]), pair[0]),
        )
    ]


def _interleave(pools):
    """Круговой обход пулов: сначала головы каждого, а не весь первый целиком."""
    pools = [list(pool) for pool in pools]
    for index in range(max((len(pool) for pool in pools), default=0)):
        for pool in pools:
            if index < len(pool):
                yield pool[index]


def _neighbour_popular_mix(pools, own: str) -> List[ExternalTrackResponse]:
    """Пулы похожих артистов → очередь, где от каждого сначала популярное.

    Треки самого сид-артиста отбрасываются: «похожее» на него — это другие имена.
    """
    return list(
        _interleave(
            _by_service_popularity(
                t
                for t in pool
                if artist_key(effective_track_artist_title(t)[0]) != own
            )
            for pool in pools
        )
    )


async def _similar_pool(artist: str) -> List[ExternalTrackResponse]:
    """Треки артистов, ПОХОЖИХ на переданного (его собственные не отдаём).

    Это единственный источник похожести, не завязанный на конкретный videoId:
    radio требует ytmusic-трека в профиле, а SoundCloud-разведка — это по сути
    дискография самого артиста (см. _soundcloud_pool), новых имён она не даёт.

    От похожего артиста следующим в очереди должен идти его ПОПУЛЯРНЫЙ трек:
    незнакомое имя представляют тем, чем оно известно. Поэтому каждый сосед
    сначала упорядочивается по прослушиваниям на площадке, а затем соседи
    обходятся по кругу — иначе вся выдача была бы дискографией первого из них.
    """
    # Своего кэша нет (внутри кэшируются _similar_artist_names/_artist_songs_pool),
    # поэтому single-flight на виртуальном ключе: соседи одного артиста — общий
    # граф, его не должны параллельно качать несколько пользователей.
    return await _pool_single_flight(
        f"flow:similar_pool:{artist_key(artist)}",
        lambda: _similar_pool_fetch(artist),
    )


async def _similar_pool_fetch(artist: str) -> List[ExternalTrackResponse]:
    related = await _similar_artist_names(artist)
    browse_ids = [r["browse_id"] for r in related if r.get("browse_id")]
    if not browse_ids:
        return []

    pools = await asyncio.gather(*(_artist_songs_pool(b) for b in browse_ids))
    return _neighbour_popular_mix(pools, artist_key(artist))


async def _favorite_artist_pool(request: Request, artist: str) -> List[ExternalTrackResponse]:
    """Каталог любимого/знакомого артиста — как можно глубже.

    Порядок выдачи здесь НЕ решается: его выбирает вызывающий по тому, доказал
    ли артист «любимость» (см. _ARTIST_PROVEN_WEIGHT), поэтому пул кэшируется
    один на артиста и переиспользуется всеми пользователями.
    """
    key = f"flow:favorite:{artist_key(artist)}"
    cached = await get_cache_async(key)
    if cached is not None:
        return [ExternalTrackResponse(**t) for t in cached]
    return await _pool_single_flight(
        key, lambda: _favorite_artist_pool_fetch(request, artist)
    )


async def _favorite_artist_pool_fetch(
    request: Request, artist: str
) -> List[ExternalTrackResponse]:
    key = f"flow:favorite:{artist_key(artist)}"
    # Страница артиста — его собственная выдача во всю глубину. Она нужна именно
    # доказанному артисту: «любой случайный трек» по верхушке поиска — это всё
    # тот же его хит. search остаётся фолбэком: карточки артиста у провайдера
    # может не быть вовсе (ремиксеры, локальные ники), а каталог тогда пуст.
    try:
        tracks = await ytdlp.ytmusic_artist_catalog(
            request, artist, limit=_FAVORITE_CATALOG_LIMIT
        )
    except Exception:  # noqa: BLE001
        logger.warning("flow favorite artist catalog failed for %s", artist)
        tracks = []
    if not tracks:
        try:
            tracks = await ytdlp.search_ytmusic(request, artist, limit=_FAVORITE_ARTIST_LIMIT)
        except Exception:  # noqa: BLE001
            logger.warning("flow favorite artist search failed for %s", artist)
            tracks = []
    own = artist_key(artist)
    # Сверяем имя ПО СЛОВАМ, а не подстрокой. Подстрока по нормализованному
    # ключу склеивает разных артистов на коротких именах: "sky" совпадало с
    # "skylar grey", "yung" — с "yungblud", и такой трек шёл в выдачу без
    # вкусовой проверки вообще (favorite_explore её не проходит — это по замыслу
    # точный каталог своего артиста). query_names_artist требует, чтобы каждое
    # слово запроса было словом имени, и при этом снимает разницу алфавита и
    # допускает фичеринг ("A, B") — ровно то, что нужно от поиска у провайдера.
    tracks = [
        t
        for t in tracks
        if own and query_names_artist(artist, effective_track_artist_title(t)[0])
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
        return _drop_service_unpopular(
            [ExternalTrackResponse(**t) for t in cached]
        )

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
    return _drop_service_unpopular(pool)


async def _tag_pool(request: Request, tag: str) -> List[ExternalTrackResponse]:
    """Разведка по пользовательскому тегу — ищем НОВЫЕ треки на SoundCloud и
    YT Music по слову из истории пользователя (title_tags), а не только в
    каталоге уже знакомых артистов. Кэш в Redis, как у _soundcloud_pool.
    """
    key = f"flow:tag:{tag.lower()}"
    cached = await get_cache_async(key)
    if cached is not None:
        return _drop_service_unpopular(
            [ExternalTrackResponse(**t) for t in cached]
        )
    return await _pool_single_flight(
        key, lambda: _tag_pool_fetch(request, tag)
    )


async def _tag_pool_fetch(request: Request, tag: str) -> List[ExternalTrackResponse]:
    key = f"flow:tag:{tag.lower()}"
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
    return _drop_service_unpopular(pool)


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
        history = await asyncio.to_thread(
            _persisted_flow_history, db, user_id, _FLOW_HISTORY_LIMIT
        )
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
    # Тоже через to_thread: синхронный Session блокирует event loop, а воркер в
    # dev'е один — на время этих запросов замирали ВСЕ параллельные запросы.
    # Последовательно, а не в gather: Session не потокобезопасна, и обе функции
    # работают с одним и тем же db.
    contextual_profile = await asyncio.to_thread(
        build_context_profile, db, user_id, hour_bucket(hour), now=ranking_now
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
        # Два счётчика на РАЗНЫХ шкалах, и раньше они шли в один max() по сырому
        # числу: у внешнего кандидата play_count — метрика площадки (views,
        # playback_count), у строки каталога — наш собственный счётчик. Любое
        # число просмотров перебивало наш счётчик, а на общей кривой и хит, и
        # безымянная загрузка выходили одинаково «популярными». Считаем обе
        # популярности на своей шкале и берём лучшую уже НОРМАЛИЗОВАННУЮ.
        is_external = not isinstance(getattr(item, "id", None), int)
        local_popularity = popularity_score(
            population.get("play_count", 0) if is_external else item_play_count,
            max(item_listener_count, population.get("listener_count", 0)),
            reference=LOCAL_POPULARITY_REFERENCE,
        )
        service_popularity = (
            popularity_score(
                item_play_count, reference=SERVICE_POPULARITY_REFERENCE
            )
            if is_external
            else 0.0
        )
        score = score_track(
            item,
            user_id=user_id,
            artist_affinity=(profile.get("artist_weight") or {}).get(key, 0.0),
            genres=profile.get("genres") or (),
            novelty=key not in (profile.get("artist_weight") or {}),
            source=item.get("source") if isinstance(item, dict) else getattr(item, "source", None),
            popularity=max(local_popularity, service_popularity),
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
    # Клиентский exclude запоминаем ДО объединения с историей: это id треков,
    # уже стоящих в очереди у фронта, и для квоты лайков применимы только они.
    # Всё остальное, что попадает в excl_ids, — это recent_ids, то есть
    # «последние 100 прослушиваний ∪ скипы ∪ треки плейлистов»; для лайка это
    # значило бы «услышал однажды — не вернётся, пока его не вытеснит сотня
    # чужих прослушиваний», а у юзера с короткой историей — «не вернётся
    # никогда». Когда лайк можно услышать снова, решает кулдаун по времени
    # (_LIKED_REPLAY_COOLDOWN_DAYS), скипы и дизлайки — profile["skipped_ids"].
    queued_ids = set(excl_ids)
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
    # provider's artist search, regardless of the requested page size. Это про
    # ПРОВАЙДЕРОВ: сам лайк в поток попадает, но своей строкой из библиотеки, а
    # не найденной у YT Music копией. Поэтому разбор liked_candidates ниже
    # seen_keys не проверяет — иначе отсеял бы каждый лайк до единого.
    seen_keys.update(tuple(key) for key in profile.get("liked_keys") or [])
    seen_keys.update(profile.get("collection_keys") or set())

    # --- разведка: радио YT Music от сидов + поиск SoundCloud по любимым артистам ---
    # Не у каждого videoId есть радио, поэтому перебираем сиды волнами по 2,
    # пока не наберём достаточно СВЕЖИХ (после исключений) кандидатов.
    # До финального объединения держим происхождение кандидата отдельно, чтобы
    # точному каталогу и track-similar источнику дать разные soft-confidence.
    favorite_explore: List[ExternalTrackResponse] = []
    similar_explore: List[ExternalTrackResponse] = []
    # Готовый пик фонового сравнения артистов по косинусу. Отдельный список —
    # только чтобы дать ему свой confidence bonus и приоритет ВНУТРИ уже
    # существующей цели разведки; своей квоты у него нет.
    probe_explore: List[ExternalTrackResponse] = []
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
    # Квота понравившегося — И пол, И потолок (см. отбор ниже). Пол нужен
    # потому, что без него лайки не попадали в поток вообще: они проигрывали
    # общему ранжированию свежим кандидатам всегда. Потолок — потому, что
    # волна должна оставаться волной, а не повтором плейлиста лайков.
    # Зажимаем целью разведки: две квоты не должны вместе съесть всю порцию,
    # и приоритет у явно попрошенных новых имён.
    liked_target = min(
        liked_slots(limit, explore_ratio), max(0, limit - discovery_target)
    )

    def _add_explore(
        tracks,
        target: Optional[List[ExternalTrackResponse]] = None,
        *,
        accept_limit: Optional[int] = None,
    ) -> None:
        # Дедуп и исключения применяем СРАЗУ при добавлении: решение «нужна ли
        # ещё волна радио» должно приниматься по числу свежих кандидатов.
        # Раньше волны останавливались на первом непустом СЫРОМ пуле, а
        # фильтрация исключений шла в самом конце — при подгрузке продолжения
        # кэшированный радио-пул (TTL 30 мин) целиком оказывался уже в очереди,
        # explore выходил пустым, и волна «замирала» на первых ~15 треках.
        #
        # accept_limit считает ПРИНЯТЫЕ треки, а не просмотренные. Обрезать пул
        # заранее нельзя: у знакомого артиста его популярное — это ровно то, что
        # уже лежит в коллекции пользователя, и предварительно обрезанное окно
        # целиком уходило в исключения, а артист исчезал из потока.
        accepted = 0
        for t in tracks:
            if accept_limit is not None and accepted >= accept_limit:
                break
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
            accepted += 1

    # Пик фонового сравнения — первым, до сетевых источников: он уже посчитан,
    # и при совпадении с тем же треком от радио/графа в пул должна попасть
    # именно эта копия, со своим bonus. Синхронно сравнение НЕ запускаем —
    # каталоги кандидатов стоят до шести сетевых вызовов, а это прямая задержка
    # запроса; нет посчитанного пика — поток работает ровно как раньше.
    probe_pick = await artist_probe.cached_pick(user_id)
    if probe_pick is not None:
        _add_explore([probe_pick], probe_explore)

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

    # Кандидаты, добытые расширением курированного артиста (радио от его трека,
    # сосед по графу артистов, его же дискография в SoundCloud). Их родословная
    # — уже сигнал вкуса, поэтому неопределимый жанр им не в укор: у похожего
    # артиста нет ни genre в метаданных, ни слова «рэп» в названии, и обычная
    # проверка отбраковывала ПОХОЖИХ подчистую, оставляя в волне ровно тех
    # артистов, которых пользователь и так уже выбрал сам.
    # Пропуск по родословной действует ТОЛЬКО на пулы, засеянные вкусом.
    # Теговый поиск ниже строит свою проверку: у него родословной нет.
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
    # Каталог запрашиваем для любого артиста из СОБСТВЕННОЙ коллекции юзера —
    # лайки, свои плейлисты, импорт, явные предпочтения. Это не разведка: пул
    # возвращает треки именно запрошенного артиста (_favorite_artist_pool
    # сверяет имя), поэтому «чужого» в поток он привести не может, а вот без
    # него импортированный артист не попадал в выдачу ни одним путём.
    catalog_artists = list(dict.fromkeys(profile.get("catalog_artists") or []))
    # Порядок: сначала лайки, затем курированные плейлистные имена, затем
    # остальная коллекция. Число сетевых запросов ограничено ниже, а очередь
    # ротируется по artist_history — не сыгранные имена (в том числе только что
    # импортированные) поднимаются вперёд сами.
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
    # Здесь ограничивается только стоимость сетевой генерации. Сколько треков
    # выбранного артиста дойдёт до ранкера, решает accept_limit ниже (считая уже
    # прошедшие исключения), а места в ответе по-прежнему не закреплены ни за
    # одним источником: каталог каждого артиста конкурирует со всеми остальными
    # кандидатами в общей модели.
    favorite_explore_artists = max(
        _FAVORITE_EXPLORE_ARTISTS,
        min(len(catalog_artists), limit),
    )
    favorite_artists = [artist for _, artist in favorite_artists][:favorite_explore_artists]
    favorite_jobs = [_favorite_artist_pool(request, a) for a in favorite_artists]
    artist_weights = profile.get("artist_weight") or {}
    favorite_window = max(limit, _FAVORITE_ARTIST_WINDOW)

    def _favorite_order(artist: str, pool) -> List[ExternalTrackResponse]:
        """В каком порядке любимый артист предлагает свой каталог ранкеру.

        Доказавший «любимость» артист отдаёт ЛЮБОЙ свой трек: порядок
        стабильно-псевдослучайный по контексту подгрузки, поэтому от запроса к
        запросу всплывают разные вещи из глубины каталога, а внутри одного
        ответа выдача детерминирована. Непроверенный артист предлагает сначала
        популярное на своей площадке — его ещё представляют слушателю.

        Здесь только ПОРЯДОК: сколько треков артиста дойдёт до ранкера, решает
        accept_limit в _add_explore, уже после исключений.
        """
        if artist_weights.get(artist_key(artist), 0.0) < _ARTIST_PROVEN_WEIGHT:
            return _by_service_popularity(pool)
        return sorted(
            pool,
            key=lambda t: stable_jitter(
                ranking_context, f"favorite-any:{artist}:{_item_identity(t)}"
            ),
            reverse=True,
        )

    def _needs_more_pools() -> bool:
        """Whether an additional provider call can still widen the ranker."""
        available = (
            len(favorite_explore)
            + len(similar_explore)
            + len(probe_explore)
            + len(explore)
        )
        if available < max(limit * 2, limit + 4):
            return True
        if not discovery_target:
            return False

        familiar_artists = set(profile.get("artist_weight") or {})
        novel_tracks = []
        novel_artists = set()
        for candidate in (*similar_explore, *probe_explore, *explore):
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

    # Все ограниченные radio-запросы запускаем одновременно. Раньше они шли
    # волнами по два: при большом exclude каждая пустая волна добавляла полный
    # сетевой таймаут, поэтому быстрый пользователь успевал исчерпать очередь.
    discovery = [_radio_pool(seed) for seed in seeds]
    if favorite_jobs or lastfm_jobs or discovery:
        pools = await asyncio.gather(*favorite_jobs, *lastfm_jobs, *discovery)
        favorite_count = len(favorite_jobs)
        lastfm_count = len(lastfm_jobs)
        # По артисту отдельным вызовом: бюджет favorite_window должен считаться
        # на каждого, иначе первый же артист с глубоким каталогом съедает его
        # целиком и остальные знакомые имена до ранкера не доходят.
        for artist, pool in zip(favorite_artists, pools[:favorite_count]):
            _add_explore(
                _favorite_order(artist, pool),
                favorite_explore,
                accept_limit=favorite_window,
            )
        _add_explore(
            (
                t for t in _interleave(
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
    if not tag_words:
        # Своих слов у юзера нет — остаются жанры, но наши 12 ключей это общие
        # слова, и склейка двух ("phonk hip-hop") как поисковый запрос у
        # провайдера возвращает мусор. Дерево жанров beets разворачивает вкус в
        # НАСТОЯЩИЕ имена поджанров ("memphis rap", "witch house", "dark wave"),
        # по которым у SoundCloud и YT Music есть каталог. Берём одно контекстно
        # за подгрузку — это ротация разведки, а не фиксированный запрос.
        pool = beets_genre.subgenres(profile.get("genres") or [])
        if pool:
            tag_words = [
                max(
                    pool,
                    key=lambda value: stable_jitter(
                        ranking_context, f"subgenre:{value}"
                    ),
                )
            ]
        else:
            tag_words = list(profile.get("genres") or [])[:_TAG_EXPLORE_TAGS]
    # Теговый поиск также остаётся fallback: последовательное ожидание трёх
    # провайдеров было основной причиной долгой подгрузки следующих 15 треков.
    if tag_words and _needs_more_pools():
        query = " ".join(tag_words[:2])
        # Это ЕДИНСТВЕННЫЙ генератор без родословной: сырой полнотекстовый поиск
        # у провайдера, который на запрос из пары слов охотно отдаёт что угодно.
        # Требуем, чтобы кандидат сам называл искомые слова, и намеренно НЕ
        # передаём prefer_cyrillic. Языковой прокси здесь работал ровно наоборот:
        # у юзера с кириллической библиотекой make_relevance_check доходит до
        # языка раньше ключевых слов (жанр у внешнего трека пуст) и там
        # возвращает ответ, поэтому по запросу "memphis rap" отбраковывались все
        # найденные по теме треки, а любой посторонний русскоязычный трек
        # проходил. Именно этим путём в поток попадали новые артисты, не имеющие
        # к вкусу отношения.
        tag_check = track_check(
            make_relevance_check(
                trusted_artist_keys=set(profile.get("curated_artist_keys") or []),
                user_genres=set(profile.get("genres") or []),
                prefer_cyrillic=None,
                keywords=list(dict.fromkeys(query.split())),
            )
        )
        _add_explore(
            t
            for t in await _tag_pool(request, query)
            if tag_check(t)
        )

    logger.debug(
        "flow explore user=%s favorite=%d similar=%d probe=%d fresh_candidates=%d excluded_external=%d",
        user_id,
        len(favorite_explore),
        len(similar_explore),
        len(probe_explore),
        len(explore),
        len(external_exclude) + len(excl_videos),
    )
    external_population = await asyncio.to_thread(
        _external_population_stats_on_bind,
        telemetry_bind,
        favorite_explore + similar_explore + probe_explore + explore,
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
    # Пик воркера проверяем так же: косинус мерил близость к ВКУСУ, а не то,
    # как этот трек уже приняли живые слушатели.
    probe_explore = [t for t in probe_explore if _population_allows_discovery(t)]
    explore = [t for t in explore if _population_allows_discovery(t)]
    # --- локальная библиотека, понравившееся и единый пул ---
    local, liked_pool = await asyncio.to_thread(
        _familiar_candidates_on_bind,
        telemetry_bind,
        profile,
        limit,
        set(excl_ids),
        queued_ids,
        liked_target,
    )
    # Понравившееся разбираем ПЕРВЫМ: при совпадении нормализованного ключа с
    # другой строкой каталога в единый пул должна попасть именно лайкнутая.
    #
    # seen_keys здесь намеренно не проверяется: ключи всех лайков лежат в нём
    # изначально (выше, чтобы провайдеры не отдавали копию уже собранного
    # трека), и такая проверка отсекла бы каждый лайк до единого. Так же и по
    # id: сверяемся с queued_ids (очередь фронта), а не с excl_ids — в тот уже
    # влиты recent_ids, где лайк оказывается от одного прослушивания. Остальные
    # исключения — скипы, дизлайки, баны, кулдаун — учтены внутри
    # _liked_candidates.
    #
    # Из excl_videos по той же причине вычитаем collection_external_ids: там
    # provider id ВСЕГО, что лежит в плейлистах юзера, лайки в том числе. Для
    # лайка из YT Music или SoundCloud (а таких большинство) проверка «уже в
    # коллекции» отсекала бы ровно то, что мы здесь и отдаём. А вот клиентский
    # exclude возвращаем обратно поверх вычитания: provider id лайка лежит и в
    # коллекции, и в очереди одновременно, и без этого шага одна и та же песня
    # пришла бы в волне дважды — своей лайкнутой строкой и уже стоящей в очереди
    # копией от провайдера. Недавно сыгранное (recent_video_ids) в вычитании
    # остаётся: когда лайку можно вернуться, решает кулдаун.
    liked_excl_videos = (
        excl_videos - set(profile.get("collection_external_ids") or [])
    ) | set(client_yt_videos)
    liked_candidates: List[Track] = []
    liked_identities: set[str] = set()
    for t in liked_pool:
        effective_artist, _effective_title = effective_track_artist_title(t)
        if t.id in queued_ids:
            continue
        if t.external_id and t.external_id in liked_excl_videos:
            continue
        if profile["banned_artists"] and artist_key(effective_artist) in profile["banned_artists"]:
            continue
        excl_ids.add(t.id)
        liked_candidates.append(t)
        liked_identities.add(_item_identity(t))
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
    # совпадении оставляем первый источник: понравившееся, локальный файл, затем
    # точный каталог, затем похожесть и прочую разведку. Треки из собственных
    # (не «Понравившиеся») плейлистов сюда намеренно не добавляются: они уже
    # отфильтрованы выше и должны влиять на вкус, но не повторяться в потоке.
    unified_candidates = []
    unified_identities = set()
    unified_keys = set()
    for candidate in (
        *liked_candidates,
        *local_candidates,
        *probe_explore,
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
    # Явный лайк — самый сильный первичный сигнал, какой у нас есть про
    # КОНКРЕТНЫЙ трек, поэтому bonus выше, чем у точного каталога любимого
    # артиста. На попадание в порцию это влияет только внутри своей квоты (см.
    # отбор ниже), а вот на место внутри неё — да.
    for candidate in liked_candidates:
        content_bonus_by_identity.setdefault(_item_identity(candidate), 0.15)
    for candidate in local_candidates:
        content_bonus_by_identity.setdefault(_item_identity(candidate), 0.05)
    for candidate in probe_explore:
        content_bonus_by_identity.setdefault(_item_identity(candidate), _PROBE_BONUS)
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

    novel_selection: List = []
    if discovery_target:
        novel_candidates = [
            candidate for candidate in ranked_candidates if _is_novel(candidate)
        ]
        # Пик воркера — первый среди новых имён, но именно ВНУТРИ уже
        # существующей цели разведки: третьей квоты он не получает, и когда
        # цели нет (ползунок на дефолте), этой ветки просто не будет. Сортировка
        # стабильная, так что для всех остальных порядок общего ранжирования
        # сохраняется. Приоритет здесь потому, что косинус померил близость
        # каталогом целиком, а ранкер видит один трек — при равном score
        # проверенное имя стоит показать раньше.
        probe_identities = {_item_identity(t) for t in probe_explore}
        if probe_identities:
            novel_candidates.sort(
                key=lambda candidate: _item_identity(candidate) not in probe_identities
            )
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

    # Понравившееся берём в порядке общего рейтинга, но ровно liked_target штук.
    # Лайк — трек знакомого артиста, так что с novel_selection пересечений нет;
    # дедуп по id ниже всё равно на месте, чтобы порядок отбора не был неявным
    # условием корректности.
    liked_selection: List = []
    if liked_target:
        for candidate in ranked_candidates:
            if _item_identity(candidate) not in liked_identities:
                continue
            liked_selection.append(candidate)
            if len(liked_selection) >= liked_target:
                break

    reserved: List = []
    reserved_ids: set[int] = set()
    for candidate in (*novel_selection, *liked_selection):
        if id(candidate) in reserved_ids:
            continue
        reserved_ids.add(id(candidate))
        reserved.append(candidate)
    # Добор — общим рейтингом, но БЕЗ лайков: их квота уже заполнена, и всё
    # сверх неё вытеснило бы из порции то новое, за чем в поток и приходят.
    filler = [
        candidate
        for candidate in ranked_candidates
        if id(candidate) not in reserved_ids
        and _item_identity(candidate) not in liked_identities
    ]
    selected_candidates = (reserved + filler)[:limit]

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
    #
    # Понравившееся разносим ОТДЕЛЬНО и после: его отобрала квота, то есть
    # порядок общего рейтинга к нему не применим, и в mix оно лежит блоком в
    # начале — волна открывалась пачкой уже знакомого. interleave_artists
    # раскладывает остальное, spread_into ставит лайки равными интервалами по
    # всей порции. Именно в таком порядке: убрать лайки из готовой раскладки
    # значило бы склеить соседей, которых лайк собой разделял.
    liked_items = [
        item for item in mix if _item_identity(item) in liked_identities
    ]
    mix = spread_into(
        interleave_artists(
            [item for item in mix if _item_identity(item) not in liked_identities],
            artist_getter=lambda item: _item_artist_title(item)[0],
            min_gap=_MIN_ARTIST_GAP,
            previous_artists=history.get("artists") or [],
            context=ranking_context,
        ),
        liked_items,
        artist_getter=lambda item: _item_artist_title(item)[0],
        min_gap=_MIN_ARTIST_GAP,
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
    probe_identities_delivered = {_item_identity(t) for t in probe_explore}
    logger.debug(
        "flow result user=%s explore=%d exploit=%d liked=%d/%d probe=%d returned=%d",
        user_id,
        n_explore,
        n_exploit,
        len(liked_selection),
        liked_target,
        sum(1 for item in mix if _item_identity(item) in probe_identities_delivered),
        len(mix),
    )
    return mix
