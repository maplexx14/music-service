"""Персональный поток («Моя волна»).

Генерирует бесконечную персональную очередь: смесь «разведки» и «эксплуатации»
(локальная библиотека по любимым артистам/жанрам). Фронт подгружает следующую
порцию, когда очередь подходит к концу, передавая exclude-список уже сыгранного.

Разведка идёт по трём источникам, и это разделение существенно:

* граф артистов YouTube Music (_similar_pool) — соседи курированного артиста.
  Работает от ИМЕНИ, поэтому доступен всегда;
* радио YouTube Music (_radio_pool) — похожесть на уровне трека. Требует
  ytmusic-видео в профиле, которого у SoundCloud-библиотеки может не быть;
* поиск SoundCloud по имени артиста (_soundcloud_pool) — по сути дискография
  самого артиста, НОВЫХ имён не даёт.

Когда единственным источником было радио, любой его отказ (сломанный провайдер,
нет ytmusic-сидов) обнулял всю разведку, и поток вырождался в дискографию тех
артистов, которых пользователь уже выбрал сам.
"""

import asyncio
import logging
import math
import os
import random
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy import desc, func, or_
from sqlalchemy.orm import Session

from app import storage
from app.cache import get_cache_async, set_cache_async
from app.database import get_db
from app.dependencies import get_current_active_user
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
    cap_per_artist,
    interleave_artists,
    primary_artist_key,
    take_capped,
    take_overflow,
    weighted_order,
)
from app.artist_utils import artist_key
from app.models import Track, User, Playlist, playlist_tracks, user_track_plays, user_track_skips
from app.routers import soundcloud, ytdlp
from app.routers.ytdlp import clean_title
from app.schemas import ExternalTrackResponse, TrackResponse

logger = logging.getLogger(__name__)

router = APIRouter()

# Сколько последних прослушиваний исключаем из потока (свежесть).
# 100 треков хватает на ~5-6 часов активного прослушивания — поток не
# повторяется даже при длительных сессиях.
_RECENT_PLAYS_EXCLUDE = 100
# Кэш радио-пула на сид: радио YT Music стабильно на коротком горизонте,
# нет смысла дёргать его на каждую подгрузку.
_RADIO_TTL = 1800
_RADIO_LIMIT = 50
# Разведка по ГРАФУ АРТИСТОВ YT Music. Радио строится от videoId, поэтому у
# пользователя, чья библиотека целиком в SoundCloud, оно недоступно в принципе,
# и «похожие артисты» из волны исчезали совсем — оставались ровно те, кого юзер
# выбрал сам. Граф работает от имени артиста и этой дырки не имеет.
# Сколько соседей берём у одного артиста и сколько артистов вкуса зондируем за
# подгрузку (порядок в profile["artists"] уже взвешенно случайный, так что это
# ротация, а не фиксированный топ).
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
# Сколько из SC-разведочных слотов ГАРАНТИРОВАННО отдаём артистам из
# импортированных плейлистов — независимо от их весового ранга. Плейлистные
# треки имеют strongest weight (+4.0), но эта квота сохраняется для SC-разведки,
# чтобы импорт из SoundCloud точно влиял на волну (SC-треки не сеют YT-радио).
_SC_PLAYLIST_ARTISTS = 3
# Разведка по пользовательским тегам (title_tags) — поиск НОВЫХ треков (не
# обязательно от уже знакомых артистов) прямо у провайдеров по словам, которые
# пользователь сам "выбрал" своей историей прослушивания.
_TAG_EXPLORE_TAGS = 3
_TAG_EXPLORE_LIMIT = 15
_TAG_EXPLORE_TTL = 1800
# Максимум треков одного артиста в "эксплуатации" — иначе сортировка по
# play_count раз за разом выдаёт одних и тех же самых заигранных артистов.
_MAX_PER_ARTIST = 6
# Доля порции, ГАРАНТИРОВАННО отдаваемая разведке. Именно доля, а не остаток
# после локальных кандидатов: локальный пул почти всегда богаче (один запрос в
# БД против сети и кэшей у разведки), поэтому на добор разведке не оставалось
# ничего, и волна вырождалась в каталог тех артистов, которых юзер и так
# слушает, — то есть в список бывшего раздела «Рекомендуем для вас».
# Жанровая гарантия от этого не страдает: внешние кандидаты тоже проходят
# _matches_related/_matches_taste, меняется только очерёдность на слоты.
_EXPLORE_SHARE = 0.0
# Сколько артистов вкуса берём в работу за один запрос. Порядок взвешенно
# случайный (см. diversity.weighted_order), поэтому это не «топ-N навсегда», а
# ротация: любимые попадают чаще, но каждая подгрузка достаёт и других из
# библиотеки. Прежний фиксированный топ-12 был причиной «крутит одних и тех же».
_FLOW_ARTISTS = 30
# Сколько последних ОТДАННЫХ треков помним для разноса артистов между
# подгрузками. Раньше помнили ровно min_gap (3 артиста) — только чтобы артист
# с конца прошлой порции не пошёл первым в следующей. Этого мало: лимит
# _MAX_PER_ARTIST считался заново на каждые 15 треков, поэтому один артист
# спокойно брал свои 2 трека в КАЖДОЙ подгрузке. За сессию это и читается как
# «один и тот же артист попадается снова и снова».
_ARTIST_HISTORY = 45
# Минимальный разнос между треками одного артиста внутри выдачи. Прежние 3
# допускали A _ _ A _ _ A — формально «не подряд», на слух «опять он».
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
_FAVORITE_EXPLORE_ARTISTS = 6


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
        db.query(Track, func.max(playlist_tracks.c.added_at).label("added_at"))
        .join(playlist_tracks, playlist_tracks.c.track_id == Track.id)
        .join(Playlist, Playlist.id == playlist_tracks.c.playlist_id)
        .filter(Playlist.owner_id == user_id, Playlist.is_liked == False)
        .group_by(Track.id)
        .order_by(desc("added_at"))
        .limit(_TASTE_QUERY_LIMIT)
        .all()
    )
    # Часто играемые: только с реальным весом (>=2 проигрываний), иначе разовые
    # клики (тест/случайный запуск) создают сигнал вкуса из шума — особенно
    # заметно на SC-разведке, которая ищет по имени артиста напрямую.
    played = (
        db.query(Track, user_track_plays.c.play_count, user_track_plays.c.last_played)
        .join(user_track_plays, user_track_plays.c.track_id == Track.id)
        .filter(
            user_track_plays.c.user_id == user_id,
            user_track_plays.c.play_count >= 2,
        )
        .order_by(desc(user_track_plays.c.last_played))
        .limit(_TASTE_QUERY_LIMIT)
        .all()
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
    genres: list = []  # с повторами — нужна частота для приоритезации ключевых слов
    weighted_titles: list = []  # (title, decay_weight) — для build_title_tag_profile
    seeds: List[str] = []  # video_id ytmusic-треков, свежие первыми
    seen_seed = set()
    # Плейлист-ПРОИЗВОДНЫЕ сигналы — отдельно от весового топа, чтобы дать им
    # ГАРАНТИРОВАННУЮ долю в разведке. Плейлистные треки имеют最强ший вес (+4.0),
    # но историческая логика сохраняется: SC-разведка плейлистных артистов
    # гарантирована отдельной квотой, чтобы импорт из SoundCloud (чьи треки
    # не могут сеять YT-радио) точно влиял на волну.
    playlist_artist_keys: List[str] = []  # порядок = свежесть добавления
    seen_pl_artist = set()
    # Курированные артисты (лайки + собственные плейлисты) — самый надёжный
    # доступный жанровый сигнал. У импортированных треков genre обычно пуст,
    # поэтому нельзя выдавать «14 жанровых» только на основании Track.genre.
    curated_artist_keys: List[str] = []
    seen_curated_artist = set()
    playlist_seeds: List[str] = []  # ytmusic video_id из плейлистов, свежие первыми

    # Тексты (название + артист) всех положительных сигналов — по ним определяем
    # доминирующий язык библиотеки (см. lang.dominant_is_cyrillic).
    lang_texts: List[str] = []

    for track, added_at in liked:
        lang_texts.append(f"{track.title} {track.artist}")
        key = artist_key(track.artist)
        artist_weight[key] = artist_weight.get(key, 0) + 3.0 * _decay(added_at)
        artist_display.setdefault(key, track.artist)
        if key and key not in seen_curated_artist:
            curated_artist_keys.append(key)
            seen_curated_artist.add(key)
        # Genre почти всегда пуст у внешних треков — как дополнительный сигнал
        # разбираем ключевые слова прямо в названии ("... Phonk Remix" и т.п.).
        genre = track.genre or infer_genre_from_text(track.title, track.artist)
        if genre:
            genres.append(genre)
        weighted_titles.append((track.title, 3.0 * _decay(added_at)))
        if track.source == "ytmusic" and track.external_id and track.external_id not in seen_seed:
            seeds.append(track.external_id)
            seen_seed.add(track.external_id)

    # Плейлистные треки — сильнейший сигнал вкуса (вес выше лайков):
    # пользователь осознанно подбирал композиции в плейлист, что является
    # более надёжным индикатором предпочтений, чем одиночный лайк.
    for track, added_at in playlisted:
        lang_texts.append(f"{track.title} {track.artist}")
        key = artist_key(track.artist)
        artist_weight[key] = artist_weight.get(key, 0) + 4.0 * _decay(added_at)
        artist_display.setdefault(key, track.artist)
        if key and key not in seen_curated_artist:
            curated_artist_keys.append(key)
            seen_curated_artist.add(key)
        genre = track.genre or infer_genre_from_text(track.title, track.artist)
        if genre:
            genres.append(genre)
        weighted_titles.append((track.title, 4.0 * _decay(added_at)))
        if key not in seen_pl_artist:
            playlist_artist_keys.append(key)
            seen_pl_artist.add(key)
        if track.source == "ytmusic" and track.external_id and track.external_id not in seen_seed:
            seeds.append(track.external_id)
            seen_seed.add(track.external_id)
        if track.source == "ytmusic" and track.external_id:
            playlist_seeds.append(track.external_id)

    for track, play_count, last_played in played:
        lang_texts.append(f"{track.title} {track.artist}")
        w = (1.0 + math.log1p(play_count or 1)) * _decay(last_played)
        key = artist_key(track.artist)
        artist_weight[key] = artist_weight.get(key, 0) + w
        artist_display.setdefault(key, track.artist)
        genre = track.genre or infer_genre_from_text(track.title, track.artist)
        if genre:
            genres.append(genre)
        weighted_titles.append((track.title, w))
        if track.source == "ytmusic" and track.external_id and track.external_id not in seen_seed:
            seeds.append(track.external_id)
            seen_seed.add(track.external_id)

    # Штраф за скипы: сам трек исключаем из волны совсем, артисту снижаем вес
    # (задолбавший артист вылетает из топа, а сид от его трека не выбирается).
    skipped_ids: set = set()
    skipped_keys: set = set()
    skipped_video_ids: set = set()
    for track, skip_count, last_skipped, disliked in skipped:
        skipped_ids.add(track.id)
        skipped_keys.add(_norm_key(track.artist, track.title))
        if track.external_id:
            skipped_video_ids.add(track.external_id)
        key = artist_key(track.artist)
        # Явный дизлайк весомее случайного скипа и не затухает: пользователь
        # сказал «не хочу» осознанно. Вес подобран так, чтобы один дизлайк
        # перебивал один лайк (+3.0) и уводил артиста в banned_artists.
        penalty = (
            _DISLIKE_ARTIST_PENALTY
            if disliked
            else 1.5 * math.log1p(skip_count or 1) * _decay(last_skipped)
        )
        artist_weight[key] = artist_weight.get(key, 0) - penalty
        artist_display.setdefault(key, track.artist)

    # --- Явные предпочтения пользователя (онбординг/настройки) ---
    # Встраиваем ПЕРЕД финализацией профиля как сильный позитивный
    # сигнал. Ключевой смысл — «холодный старт»: у нового юзера нет
    # истории, и без этого поток свёлся бы к глобально популярному.
    # Явные артисты/жанры ведут себя как курированные (лайки/плейлисты):
    # попадают в гарантированную квоту локальных кандидатов и в SC-разведку.
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
        # Вес сопоставим с курированием (плейлист=2.0); не затухает по
        # времени — это осознанный устойчивый выбор пользователя.
        artist_weight[key] = artist_weight.get(key, 0) + 2.5
        artist_display.setdefault(key, name)
        if key not in seen_curated_artist:
            curated_artist_keys.append(key)
            seen_curated_artist.add(key)
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
    pl_tracks = [t for t, _ in playlisted]
    recent_ids = {t.id for t in recent} | skipped_ids | {t.id for t in pl_tracks}
    recent_keys = (
        {_norm_key(t.artist, t.title) for t in recent}
        | skipped_keys
        | {_norm_key(t.artist, t.title) for t in pl_tracks}
    )
    recent_video_ids = (
        {t.external_id for t in recent if t.external_id}
        | skipped_video_ids
        | {t.external_id for t in pl_tracks if t.external_id}
    )

    # Холодный старт: нет НИ сидов, НИ курированных артистов — берём популярные
    # ytmusic-треки сервиса. НЕ фиксированный топ-5 (тогда у ВСЕХ бессидовых
    # юзеров волна одинаковая — одни и те же сиды → один и тот же radio-пул), а
    # случайная выборка из широкого пула популярного: у каждого юзера (и на
    # каждую подгрузку) свой набор сидов → свой поток.
    #
    # Если курированные артисты ЕСТЬ, глобальный топ брать нельзя: это чужая
    # библиотека. Своих ytmusic-треков может не быть вовсе (вся коллекция в
    # SoundCloud), и тогда любителю русского рэпа сюда попадал ню-метал другого
    # пользователя сервиса, а радио строилось вокруг него. Сиды для такого
    # случая резолвит эндпоинт по именам артистов (_artist_seed_videos).
    if not seeds and not curated_artist_keys:
        popular_yt = (
            db.query(Track.external_id)
            .filter(Track.source == "ytmusic", Track.external_id.isnot(None))
            .order_by(desc(Track.play_count))
            .limit(60)
            .all()
        )
        pool = [r[0] for r in popular_yt if r[0] not in skipped_video_ids]
        seeds = random.sample(pool, min(5, len(pool)))

    # Артисты вкуса — только с положительным итоговым весом. Порядок взвешенно
    # СЛУЧАЙНЫЙ, а не фиксированный топ по весу: детерминированный топ-N
    # означал, что каждая подгрузка волны собирает кандидатов вокруг одних и
    # тех же нескольких имён, а остальная библиотека юзера не доходит до
    # выдачи вообще. Берём шире (_FLOW_ARTISTS из всех положительных).
    positive_keys = [a for a, w in artist_weight.items() if w > 0]
    topartist_keys = weighted_order(positive_keys, artist_weight)[:_FLOW_ARTISTS]
    top_artists = [artist_display.get(a, a) for a in topartist_keys]
    # Артисты, ушедшие в минус, — фильтр для радио-кандидатов.
    banned_artists = {a for a, w in artist_weight.items() if w < 0}
    banned_artists |= excluded_artists
    for key in excluded_artists:
        artist_weight.pop(key, None)
        artist_display.pop(key, None)
        curated_artist_keys[:] = [a for a in curated_artist_keys if a != key]
        playlist_artist_keys[:] = [a for a in playlist_artist_keys if a != key]
    topartist_keys = [key for key in topartist_keys if key not in excluded_artists]
    top_artists = [artist_display.get(key, key) for key in topartist_keys]

    # Плейлистные артисты для ГАРАНТИРОВАННОЙ SC-разведки: свежие первыми,
    # заскипанные в минус — исключаем (их пользователь явно не хочет).
    playlist_artists = [
        artist_display.get(k, k)
        for k in playlist_artist_keys
        if k not in banned_artists
    ]
    # Сиды-производные плейлистов (ytmusic) — исключаем скипнутые.
    playlist_seeds = [s for s in playlist_seeds if s not in skipped_video_ids]

    return {
        "seeds": seeds,
        "playlist_artists": playlist_artists,
        "playlist_seeds": playlist_seeds,
        "artists": top_artists,
        "artist_keys": topartist_keys,
        "artist_weight": {k: v for k, v in artist_weight.items() if v > 0},
        "curated_artist_keys": curated_artist_keys,
        "genres": list(dict.fromkeys(genres)),
        "genre_counts": dict(Counter(genres)),
        "title_tags": list(build_title_tag_profile(weighted_titles).keys()),
        "banned_artists": banned_artists,
        "prefer_cyrillic": dominant_is_cyrillic(lang_texts),
        "recent_ids": recent_ids,
        "recent_keys": recent_keys,
        "recent_video_ids": recent_video_ids,
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
        filters.append(func.lower(Track.artist).in_(profile["artist_keys"]))
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
        filters.append(func.lower(Track.artist).in_(genreartist_keys))

    # Доверяем только артистам, которых юзер сам добавил в лайки/плейлисты, либо
    # совместимому по жанру/языку треку. Обычная история могла загрязниться
    # предыдущими ошибочными рекомендациями — считать любого сыгранного артиста
    # «жанром пользователя» нельзя. Проверка общая с recommendations.py (taste.py).
    _keep = track_check(
        make_relevance_check(
            trusted_artist_keys=set(profile.get("curated_artist_keys") or []),
            user_genres=set(profile.get("genres") or []),
            prefer_cyrillic=profile.get("prefer_cyrillic"),
        )
    )

    # Ротация артистов этого запроса (взвешенно случайный порядок из профиля) —
    # ею и упорядочиваем кандидатов. Сортировка по artist_weight * play_count
    # давала строго один и тот же порядок при каждой подгрузке: несколько самых
    # тяжёлых артистов забирали все слоты, остальная библиотека не доходила.
    rotation = {k: i for i, k in enumerate(profile["artist_keys"])}

    def _score(t: Track) -> tuple:
        key = artist_key(t.artist)
        # Артист вне ротации (пришёл по жанру/тегу) — после ротационных, внутри
        # своей группы по популярности.
        return (rotation.get(key, len(rotation)), -(t.play_count or 0))

    candidates: List[Track] = []
    if filters:
        q = db.query(Track).filter(or_(*filters))
        # Кандидат обязан быть от артиста, по которому у юзера есть свой сигнал.
        # Жанр/ключевое слово/тег сами по себе матчат и чужие треки: слово
        # "phonk" в названии есть и у артиста, которого в базу привёл совсем
        # другой пользователь. Скоуп пуст только при холодном старте — сужать
        # там не до чего, и глобальная выборка остаётся осознанным поведением
        # (см. _taste_profile).
        if scope:
            q = q.filter(func.lower(Track.artist).in_(scope))
        if exclude_ids:
            q = q.filter(~Track.id.in_(exclude_ids))
        # Случайная выборка окна, а не топ по play_count: иначе окно limit*8 —
        # это всегда самые заигранные треки нескольких артистов, и никакая
        # сортировка в Python уже не достанет остальных из библиотеки.
        candidates = q.order_by(func.random()).limit(limit * 8).all()
        candidates = [t for t in candidates if _keep(t) and _media_available(t)]
        candidates.sort(key=_score)
        candidates = cap_per_artist(candidates, _MAX_PER_ARTIST)

    # Добор разрешён только совместимыми со вкусом треками. Раньше сюда без
    # жанровой проверки попадал случайный глобальный top по play_count — именно
    # этот путь подмешивал любителю русского рэпа поп, техно и музыку 90-х.
    # require_signal: трек обязан иметь положительное подтверждение вкуса (жанр,
    # язык или ключевые слова), а не просто «не противоречит». Иначе любой хит
    # без жанра от незнакомого артиста проходил бы проверку и попадал в выдачу.
    if len(candidates) < limit:
        _keep_strict = track_check(
            make_relevance_check(
                trusted_artist_keys=set(profile.get("curated_artist_keys") or []),
                user_genres=set(profile.get("genres") or []),
                prefer_cyrillic=profile.get("prefer_cyrillic"),
                require_signal=True,
            )
        )
        skip = {t.id for t in candidates} | exclude_ids
        q = db.query(Track)
        # Тот же скоуп, что и у основного пула: Track.play_count — счётчик
        # ОБЩИЙ на всех юзеров (инкрементится в tracks.py на любом прослушивании
        # любым юзером), поэтому глобальный топ по нему возглавляет тот, кто
        # последним импортировал большой плейлист, — и его треки ехали в волну
        # всем. Порядок тоже меняем: desc(play_count) детерминирован, а значит
        # добор раз за разом отдавал ОДНУ И ТУ ЖЕ пачку треков — второй, помимо
        # кэша браузера, источник «одной и той же цепочки».
        if scope:
            q = q.filter(func.lower(Track.artist).in_(scope))
        if skip:
            q = q.filter(~Track.id.in_(skip))
        pool = [
            t for t in q.order_by(func.random()).limit(limit * 20).all()
            if _keep_strict(t) and _media_available(t)
        ]
        pool.sort(key=_score)
        candidates.extend(cap_per_artist(pool, _MAX_PER_ARTIST)[: limit * 2])

    return candidates


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
    return [t for pool in pools for t in pool if artist_key(t.artist) != own]


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
    tracks = [t for t in tracks if own and own in artist_key(t.artist)]
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
        if t.external_id and own in artist_key(t.artist)
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
            if query_key in _norm_key(t.artist, "")[0]
            or _norm_key(t.artist, "")[0] in query_key
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


@router.get("/flow")
async def get_flow(
    request: Request,
    response: Response,
    limit: int = Query(8, ge=5, le=50),
    exclude: str = Query("", max_length=4000),
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db),
):
    """Порция персонального потока. exclude — id уже находящихся в очереди."""
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
    history_key = f"flow:history:v2:{current_user.id}"
    history = await get_cache_async(history_key) or {}
    history_ids = set(history.get("ids") or [])
    history_keys = {
        tuple(key) for key in (history.get("keys") or [])
        if isinstance(key, list) and len(key) == 2
    }

    profile = await asyncio.to_thread(_taste_profile, db, current_user.id)
    # Дальше идут секунды сетевых ожиданий (radio YT Music + поиск SoundCloud),
    # а сессия всё это время держала бы соединение открытым в состоянии
    # `idle in transaction` — под нагрузкой пул исчерпывается на ожидании сети,
    # а не на работе с БД. Закрываем: profile — уже готовый dict из примитивов,
    # а _local_candidates ниже возьмёт из пула новое соединение (сессия
    # переоткрывает его лениво). current_user становится detached, но все его
    # загруженные поля (нужен только .id) остаются доступны.
    db.close()
    excl_ids |= profile["recent_ids"]
    excl_videos = set(client_yt_videos) | profile["recent_video_ids"]
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

    # --- разведка: радио YT Music от сидов + поиск SoundCloud по любимым артистам ---
    # Не у каждого videoId есть радио, поэтому перебираем сиды волнами по 2,
    # пока не наберём достаточно СВЕЖИХ (после исключений) кандидатов.
    explore: List[ExternalTrackResponse] = []
    banned = profile["banned_artists"]

    def _add_explore(tracks) -> None:
        # Дедуп и исключения применяем СРАЗУ при добавлении: решение «нужна ли
        # ещё волна радио» должно приниматься по числу свежих кандидатов.
        # Раньше волны останавливались на первом непустом СЫРОМ пуле, а
        # фильтрация исключений шла в самом конце — при подгрузке продолжения
        # кэшированный радио-пул (TTL 30 мин) целиком оказывался уже в очереди,
        # explore выходил пустым, и волна «замирала» на первых ~15 треках.
        for t in tracks:
            key = _norm_key(t.artist, t.title)
            external_key = f"{t.source}:{t.external_id}"
            if (
                t.external_id in excl_videos
                or external_key in external_exclude
                or key in seen_keys
            ):
                continue
            # Артист, заскипанный в минус, не попадает в волну и из радио.
            if banned and any(a.strip().lower() in banned for a in t.artist.split(",")):
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
            explore.append(t)

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
    # Плейлистные сиды имеют абсолютный приоритет: плейлист — strongest signal
    # вкуса (+4.0), сиды от него строят радио вокруг предпочтений пользователя.
    profile_seeds = list(dict.fromkeys(profile["playlist_seeds"]))
    if not profile_seeds:
        profile_seeds = list(dict.fromkeys(profile["seeds"]))
    random.shuffle(profile_seeds)
    seeds = profile_seeds[:_PROFILE_SEEDS]

    # Артисты вкуса, вокруг которых строим разведку этой подгрузки. Порядок в
    # profile["artists"] взвешенно случайный (weighted_order), поэтому это
    # ротация, а не фиксированный топ.
    similar_artists = list(profile["artists"])[:_SIMILAR_SEED_ARTISTS]

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
        current_user.id,
        len(continuation_seeds),
        len(seeds),
        len(similar_artists),
        len(history_ids),
    )
    # Похожие артисты и радио — оба про НОВОЕ, поэтому запускаем их одной
    # пачкой. Раньше здесь было только радио: когда оно молчит (у юзера нет
    # ytmusic-сидов или провайдер отдал ошибку), разведка обнулялась целиком.
    favorite_artists = list(
        dict.fromkeys(profile["playlist_artists"][:_SC_PLAYLIST_ARTISTS] + profile["artists"])
    )[:_FAVORITE_EXPLORE_ARTISTS]
    favorite_jobs = [_favorite_artist_pool(request, a) for a in favorite_artists]
    discovery = [_similar_pool(a) for a in similar_artists]
    # Все ограниченные radio-запросы запускаем одновременно. Раньше они шли
    # волнами по два: при большом exclude каждая пустая волна добавляла полный
    # сетевой таймаут, поэтому быстрый пользователь успевал исчерпать очередь.
    discovery += [_radio_pool(seed) for seed in seeds]
    if discovery:
        pools = await asyncio.gather(*favorite_jobs, *discovery)
        favorite_count = len(favorite_jobs)
        _add_explore(t for pool in pools[:favorite_count] for t in pool)
        _add_explore(
            t for pool in pools[favorite_count:] for t in pool if _matches_related(t)
        )
    elif favorite_jobs:
        pools = await asyncio.gather(*favorite_jobs)
        _add_explore(t for pool in pools for t in pool)

    # SoundCloud-разведка: ищем по нескольким любимым артистам. Источник радио
    # у SC нет, поэтому это поиск — зато волна перестаёт быть моно-ytmusic.
    # Уже целевой источник (сам артист — часть вкуса), доп. фильтр по теме не
    # нужен — иначе выкинули бы легитимные треки любимого артиста без тега в
    # заголовке.
    # Гарантированная доля плейлистным артистам + добор весовым топом. Плейлист
    # (особенно SoundCloud, чьи треки не сеют YT-радио) получает strongest
    # weight (+4.0), но эта квота сохраняется для гарантированного SC-оверлея.
    sc_artists = list(
        dict.fromkeys(
            profile["playlist_artists"][:_SC_PLAYLIST_ARTISTS] + profile["artists"]
        )
    )[:_SC_EXPLORE_ARTISTS]
    # SoundCloud — резервный источник. Не ждём его сетевые поиски, если YT
    # уже дал полную порцию свежих кандидатов.
    if sc_artists and len(explore) < limit:
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
    # Теговый поиск также остаётся fallback: последовательное ожидание трёх
    # провайдеров было основной причиной долгой подгрузки следующих 15 треков.
    if len(tag_words) >= 2 and len(explore) < limit:
        query = " ".join(tag_words[:2])
        _add_explore(
            t
            for t in await _tag_pool(request, query)
            if _matches_taste(t)
        )

    logger.debug(
        "flow explore user=%s fresh_candidates=%d excluded_external=%d",
        current_user.id,
        len(explore),
        len(external_exclude) + len(excl_videos),
    )
    # Порядок внутри выдачи случайный, как и раньше (shuffle шёл по merged).
    random.shuffle(explore)

    # --- эксплуатация: локальная библиотека по вкусу ---
    local = await asyncio.to_thread(_local_candidates, db, profile, limit, set(excl_ids))
    exploit: List[Track] = []
    for t in local:
        key = _norm_key(t.artist, t.title)
        if t.id in excl_ids or key in seen_keys:
            continue
        if t.external_id and t.external_id in excl_videos:
            continue
        if profile["banned_artists"] and t.artist.strip().lower() in profile["banned_artists"]:
            continue
        seen_keys.add(key)
        excl_ids.add(t.id)
        exploit.append(t)

    # --- жанровая квота ---
    # Все элементы exploit прошли локальный _keep, а explore — _matches_taste.
    # Для стандартной порции из 15 сначала резервируем 14 жанрово проверенных
    # позиций. Пятнадцатая остаётся разведочной, но она тоже проходит жанровый
    # фильтр: квота гарантирует минимум 14/15, а обычно релевантны все 15.
    genre_quota = min(limit, 14 if limit == 15 else max(0, limit - 1))

    random.shuffle(exploit)

    # ОДИН бюджет мест на артиста — на локальных и внешних кандидатов сразу и с
    # переносом на несколько подгрузок вперёд (history["artists"]). Раньше кап
    # применялся к каждому пулу отдельно (_local_candidates капил ещё и в каждом
    # из двух своих проходов) и обнулялся на каждой порции из 15 — поэтому один
    # артист исправно набирал по 2-4 трека в каждой подгрузке.
    artist_budget: dict = dict(Counter(history.get("artists") or []))
    artist_cap = min(_MAX_PER_ARTIST, max(4, limit // 2))

    def _artist_of(t) -> str:
        return t.artist

    # Разведка забирает свою долю ПЕРВОЙ. Раньше первыми шли локальные
    # кандидаты на все genre_quota мест, а разведке доставался остаток —
    # и когда локальный пул богат, остатка не было вовсе. Пока пул был тощим
    # (страховочный добор брал глобальный топ и почти весь отсеивался по
    # require_signal), это не проявлялось; после ограничения добора артистами
    # самого юзера трекам стало легко проходить проверку — у курированного
    # артиста make_relevance_check возвращает True сразу, — локальных
    # кандидатов стало вдоволь, и они вытеснили разведку целиком.
    explore_quota = min(len(explore), round(limit * _EXPLORE_SHARE))
    relevant_external, explore_rest = take_capped(
        explore, explore_quota, artist_cap, _artist_of, artist_budget
    )
    used_external = len(relevant_external)

    relevant_local, exploit_rest = take_capped(
        exploit, genre_quota - used_external, artist_cap, _artist_of, artist_budget
    )

    mix: List[dict] = [
        TrackResponse.model_validate(t).model_dump(mode="json")
        for t in relevant_local
    ]
    mix.extend(t.model_dump() for t in relevant_external)

    # Добираем обязательные 14 мест внешними кандидатами, которые уже прошли
    # _matches_taste и пришли из radio подтверждённых плейлистных сидов. Раньше
    # внешний добор был полностью запрещён, а локальный каталог часто содержал
    # лишь один подходящий трек — поэтому поток заканчивался сразу и Home
    # переходил к секции «Рекомендуем новинки».
    #
    # Радио одного сида и SC-поиск по артисту возвращают пачками треки ОДНОГО
    # исполнителя, поэтому внешние кандидаты идут через тот же бюджет.
    if len(mix) < genre_quota:
        extra_external, explore_rest = take_capped(
            explore_rest, genre_quota - len(mix), artist_cap, _artist_of, artist_budget
        )
        mix.extend(t.model_dump() for t in extra_external)
        used_external += len(extra_external)

    # Пятнадцатое место — разведка. Оно также проходит базовый taste-фильтр, но
    # не участвует в гарантированных 14 жанровых позициях.
    remaining = limit - len(mix)
    if remaining:
        discovery, explore_rest = take_capped(
            explore_rest, remaining, artist_cap, _artist_of, artist_budget
        )
        mix.extend(t.model_dump() for t in discovery)
        used_external += len(discovery)
        remaining = limit - len(mix)
    if remaining:
        extra_local, exploit_rest = take_capped(
            exploit_rest, remaining, artist_cap, _artist_of, artist_budget
        )
        mix.extend(
            TrackResponse.model_validate(t).model_dump(mode="json")
            for t in extra_local
        )
        remaining = limit - len(mix)

    # Последний резерв — добор СВЕРХ лимита на артиста, начиная с наименее
    # представленных. Короткая порция хуже повтора: на бедном каталоге волна
    # иначе «замирает» на первых треках (см. историю фиксов выше).
    # Never bypass the per-artist cap for external discovery results.
    if remaining:
        mix.extend(
            TrackResponse.model_validate(t).model_dump(mode="json")
            for t in take_overflow(exploit_rest, remaining, _artist_of, artist_budget)
        )

    n_explore = used_external
    n_exploit = len(mix) - n_explore
    random.shuffle(mix)
    # Хвост артистов прошлых порций — иначе разнос работал только внутри одной
    # выдачи, и на стыке подгрузок артист снова шёл почти подряд.
    mix = interleave_artists(
        mix,
        artist_getter=lambda item: item.get("artist"),
        min_gap=_MIN_ARTIST_GAP,
        previous_artists=history.get("artists") or [],
    )

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
        returned_keys.append(list(_norm_key(item.get("artist", ""), item.get("title", ""))))

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
            # Артисты последних отданных треков — и для разноса на стыке
            # подгрузок (interleave_artists), и как бюджет мест на артиста
            # (take_capped). Копим окно, а не хвост последней порции: лимит,
            # обнуляемый каждые 15 треков, и был причиной «снова он».
            "artists": (
                [a for a in (history.get("artists") or []) if isinstance(a, str)]
                + [primary_artist_key(item.get("artist", "")) for item in mix]
            )[-_ARTIST_HISTORY:],
        },
        expire=_FLOW_HISTORY_TTL,
    )
    logger.debug(
        "flow result user=%s explore=%d exploit=%d returned=%d",
        current_user.id,
        n_explore,
        n_exploit,
        len(mix),
    )
    return mix
