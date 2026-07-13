"""Персональный поток («Моя волна»).

Генерирует бесконечную персональную очередь: смесь «разведки» (похожие треки
через радио YouTube Music от сидов пользователя) и «эксплуатации» (локальная
библиотека по любимым артистам/жанрам). Фронт подгружает следующую порцию,
когда очередь подходит к концу, передавая exclude-список уже сыгранного.
"""

import asyncio
import logging
import math
import random
import re
from collections import Counter
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import desc, func, or_
from sqlalchemy.orm import Session

from app.cache import get_cache_async, set_cache_async
from app.database import get_db
from app.dependencies import get_current_active_user
from app.artist_genre import artists_matching_keywords
from app.genre_keywords import (
    build_keyword_filters,
    genre_is_compatible,
    infer_genre_from_text,
    top_genre_keywords,
)
from app.lang import is_foreign_script
from app.title_tags import build_tag_filters, build_title_tag_profile
from app.diversity import cap_per_artist
from app.models import Track, User, Playlist, playlist_tracks, user_track_plays, user_track_skips
from app.routers import soundcloud, ytdlp
from app.routers.ytdlp import clean_title
from app.schemas import ExternalTrackResponse, TrackResponse

logger = logging.getLogger(__name__)

router = APIRouter()

# Сколько последних прослушиваний исключаем из потока (свежесть).
_RECENT_PLAYS_EXCLUDE = 40
# Доля «разведки» (радио-кандидаты) в миксе.
_EXPLORE_RATIO = 0.6
# Кэш радио-пула на сид: радио YT Music стабильно на коротком горизонте,
# нет смысла дёргать его на каждую подгрузку.
_RADIO_TTL = 1800
_RADIO_LIMIT = 50
# У SoundCloud нет радио-эндпоинта в yt-dlp, поэтому «разведку» по нему делаем
# поиском по любимым артистам. Сколько артистов зондируем и глубина кэша.
_SC_EXPLORE_ARTISTS = 6
_SC_EXPLORE_LIMIT = 15
_SC_EXPLORE_TTL = 1800
# Сколько из SC-разведочных слотов ГАРАНТИРОВАННО отдаём артистам из
# импортированных плейлистов — независимо от их весового ранга. Без этого
# история прослушиваний (более высокий вес) вытесняет плейлистных артистов из
# разведки целиком, и импортированный плейлист не влияет на волну.
_SC_PLAYLIST_ARTISTS = 3
# Разведка по пользовательским тегам (title_tags) — поиск НОВЫХ треков (не
# обязательно от уже знакомых артистов) прямо у провайдеров по словам, которые
# пользователь сам "выбрал" своей историей прослушивания.
_TAG_EXPLORE_TAGS = 3
_TAG_EXPLORE_LIMIT = 15
_TAG_EXPLORE_TTL = 1800
# Максимум треков одного артиста в "эксплуатации" — иначе сортировка по
# play_count раз за разом выдаёт одних и тех же самых заигранных артистов.
_MAX_PER_ARTIST = 2
# Вес сигнала вкуса (лайк/прослушивание/скип) экспоненциально затухает со
# временем вместо жёсткого окна «последние N записей» — иначе у активных
# пользователей (сотни прослушиваний за сессию) более ранний, но всё ещё
# любимый артист резко выпадает из профиля, стоит наиграть чуть больше
# истории поверх него. Полураспад веса — раз в столько дней сигнал слабеет
# вдвое; пределы выборки — просто защита от неограниченного запроса, не
# смысловая отсечка.
_TASTE_HALF_LIFE_DAYS = 14.0
_TASTE_QUERY_LIMIT = 300


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
    skipped = (
        db.query(Track, user_track_skips.c.skip_count, user_track_skips.c.last_skipped)
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
    # ГАРАНТИРОВАННУЮ долю в разведке. Иначе импортированный плейлист (особенно
    # SoundCloud, чьи треки не могут сеять YT-радио) полностью вытесняется
    # историей прослушиваний: play_count перевешивает +2.0 за курирование, и
    # плейлистные артисты не попадают ни в топ-сидов, ни в топ-SC-разведки.
    playlist_artist_keys: List[str] = []  # порядок = свежесть добавления
    seen_pl_artist = set()
    playlist_seeds: List[str] = []  # ytmusic video_id из плейлистов, свежие первыми

    def _artist_key(name: str) -> str:
        return re.sub(r"\s+", " ", (name or "").strip().lower())

    for track, added_at in liked:
        key = _artist_key(track.artist)
        artist_weight[key] = artist_weight.get(key, 0) + 3.0 * _decay(added_at)
        artist_display.setdefault(key, track.artist)
        # Genre почти всегда пуст у внешних треков — как дополнительный сигнал
        # разбираем ключевые слова прямо в названии ("... Phonk Remix" и т.п.).
        genre = track.genre or infer_genre_from_text(track.title, track.artist)
        if genre:
            genres.append(genre)
        weighted_titles.append((track.title, 3.0 * _decay(added_at)))
        if track.source == "ytmusic" and track.external_id and track.external_id not in seen_seed:
            seeds.append(track.external_id)
            seen_seed.add(track.external_id)

    # Плейлистные треки — вес чуть ниже явных лайков (2.0 против 3.0), но выше
    # обычного прослушивания: курирование сильный сигнал.
    for track, added_at in playlisted:
        key = _artist_key(track.artist)
        artist_weight[key] = artist_weight.get(key, 0) + 2.0 * _decay(added_at)
        artist_display.setdefault(key, track.artist)
        genre = track.genre or infer_genre_from_text(track.title, track.artist)
        if genre:
            genres.append(genre)
        weighted_titles.append((track.title, 2.0 * _decay(added_at)))
        if key not in seen_pl_artist:
            playlist_artist_keys.append(key)
            seen_pl_artist.add(key)
        if track.source == "ytmusic" and track.external_id and track.external_id not in seen_seed:
            seeds.append(track.external_id)
            seen_seed.add(track.external_id)
        if track.source == "ytmusic" and track.external_id:
            playlist_seeds.append(track.external_id)

    for track, play_count, last_played in played:
        w = (1.0 + math.log1p(play_count or 1)) * _decay(last_played)
        key = _artist_key(track.artist)
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
    for track, skip_count, last_skipped in skipped:
        skipped_ids.add(track.id)
        skipped_keys.add(_norm_key(track.artist, track.title))
        if track.external_id:
            skipped_video_ids.add(track.external_id)
        key = _artist_key(track.artist)
        artist_weight[key] = (
            artist_weight.get(key, 0) - 1.5 * math.log1p(skip_count or 1) * _decay(last_skipped)
        )
        artist_display.setdefault(key, track.artist)

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

    # Холодный старт: нет своих сидов — берём популярные ytmusic-треки сервиса.
    # НЕ фиксированный топ-5 (тогда у ВСЕХ бессидовых юзеров волна одинаковая —
    # одни и те же сиды → один и тот же radio-пул), а случайная выборка из
    # широкого пула популярного: у каждого юзера (и на каждую подгрузку) свой
    # набор сидов → свой поток.
    if not seeds:
        popular_yt = (
            db.query(Track.external_id)
            .filter(Track.source == "ytmusic", Track.external_id.isnot(None))
            .order_by(desc(Track.play_count))
            .limit(60)
            .all()
        )
        pool = [r[0] for r in popular_yt if r[0] not in skipped_video_ids]
        seeds = random.sample(pool, min(5, len(pool)))

    # В топ идут только артисты с положительным итоговым весом.
    top_artist_keys = [
        a
        for a, w in sorted(artist_weight.items(), key=lambda kv: kv[1], reverse=True)
        if w > 0
    ][:12]
    top_artists = [artist_display.get(a, a) for a in top_artist_keys]
    # Артисты, ушедшие в минус, — фильтр для радио-кандидатов.
    banned_artists = {a for a, w in artist_weight.items() if w < 0}

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
        "artist_keys": top_artist_keys,
        "genres": list(dict.fromkeys(genres)),
        "genre_counts": dict(Counter(genres)),
        "title_tags": list(build_title_tag_profile(weighted_titles).keys()),
        "banned_artists": banned_artists,
        "recent_ids": recent_ids,
        "recent_keys": recent_keys,
        "recent_video_ids": recent_video_ids,
    }


def _local_candidates(db: Session, profile: dict, limit: int) -> List[Track]:
    """Локальные кандидаты: треки любимых артистов/жанров + популярное (блокирующая)."""
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
    genre_artist_keys = artists_matching_keywords(db, top_genre_keywords(profile.get("genre_counts", {})))
    genre_artist_keys |= artists_matching_keywords(db, profile.get("title_tags") or [], min_matches=2)
    if genre_artist_keys:
        filters.append(func.lower(Track.artist).in_(genre_artist_keys))

    artist_keys = set(profile["artist_keys"])
    user_genres = set(profile.get("genres") or [])

    def _keep(t: Track) -> bool:
        # Артисты, которых пользователь уже реально слушает, — доверенный
        # сигнал сам по себе, жанр не сверяем. Остальное (совпадение по
        # ключевому слову/тегу в названии) само по себе не значит "тот же
        # дух" — трек мог попасть в кандидаты по случайному слову в
        # заголовке, будучи из совсем другого жанра.
        key = re.sub(r"\s+", " ", (t.artist or "").strip().lower())
        if key in artist_keys:
            return True
        # Иностранное (вьетнам/CJK/деванагари…) юзер стабильно скипает.
        if is_foreign_script(t.title):
            return False
        return genre_is_compatible(t.genre, t.title, t.artist, user_genres)

    candidates: List[Track] = []
    if filters:
        q = db.query(Track).filter(or_(*filters))
        if profile["recent_ids"]:
            q = q.filter(~Track.id.in_(profile["recent_ids"]))
        candidates = q.order_by(desc(Track.play_count)).limit(limit * 6).all()
        candidates = [t for t in candidates if _keep(t)]
        candidates = cap_per_artist(candidates, _MAX_PER_ARTIST)

    # Добор популярным, если по вкусу нашлось мало. Даже глобально популярное
    # НЕ должно быть иностранным (вьетнам/CJK/…) — юзер такое стабильно скипает,
    # а этот путь идёт мимо тег-матчинга, так что без фильтра сюда протекали
    # нерелевантные иностранные хиты вообще без совпадения по тегам. И берём
    # СЛУЧАЙНУЮ выборку из широкого пула популярного, а не фиксированный топ —
    # иначе у всех юзеров с тонким вкусом добор одинаковый (не «свой у каждого»).
    if len(candidates) < limit:
        skip = {t.id for t in candidates} | profile["recent_ids"]
        q = db.query(Track)
        if skip:
            q = q.filter(~Track.id.in_(skip))
        pool = [t for t in q.order_by(desc(Track.play_count)).limit(limit * 10).all()
                if not is_foreign_script(t.title)]
        random.shuffle(pool)
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
    """'12,ytmusic:abc,...' → (numeric_ids, video_ids)."""
    numeric, videos = set(), set()
    for part in (exclude or "").split(","):
        part = part.strip()
        if not part:
            continue
        if part.isdigit():
            numeric.add(int(part))
        elif ":" in part:
            videos.add(part.split(":", 1)[1])
    return numeric, videos


@router.get("/flow")
async def get_flow(
    request: Request,
    limit: int = Query(8, ge=5, le=50),
    exclude: str = Query("", max_length=4000),
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db),
):
    """Порция персонального потока. exclude — id уже находящихся в очереди."""
    base_url = str(request.base_url).rstrip("/")
    excl_ids, excl_videos = _parse_exclude(exclude)

    profile = await asyncio.to_thread(_taste_profile, db, current_user.id)
    excl_ids |= profile["recent_ids"]
    excl_videos |= profile["recent_video_ids"]
    seen_keys = set(profile["recent_keys"])

    # --- разведка: радио YT Music от сидов + поиск SoundCloud по любимым артистам ---
    # Не у каждого videoId есть радио, поэтому перебираем сиды волнами по 2,
    # пока не соберём хотя бы один непустой пул (максимум 3 волны).
    explore: List[ExternalTrackResponse] = []
    merged: List[ExternalTrackResponse] = []

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

    def _matches_taste(t: ExternalTrackResponse) -> bool:
        # Иностранное (вьетнам/CJK/…) юзер стабильно скипает — режем из радио.
        if is_foreign_script(t.title):
            return False
        if not taste_keywords:
            return True
        text = f"{t.title} {t.artist}".lower()
        return any(kw in text for kw in taste_keywords)

    # Сиды из ytmusic-плейлистов идут ПЕРВЫМИ (гарантированная доля радио от
    # курированного), затем остальные по свежести. dict.fromkeys дедупит,
    # сохраняя приоритет плейлистных.
    seeds = list(dict.fromkeys(profile["playlist_seeds"] + profile["seeds"]))[:10]
    if seeds:
        order = random.sample(seeds, len(seeds))
        for wave in range(0, min(len(order), 6), 2):
            batch = order[wave : wave + 2]
            pools = await asyncio.gather(*(_radio_pool(s) for s in batch))
            radio_tracks = [t for pool in pools for t in pool if _matches_taste(t)]
            merged.extend(radio_tracks)
            if merged:
                break

    # SoundCloud-разведка: ищем по нескольким любимым артистам. Источник радио
    # у SC нет, поэтому это поиск — зато волна перестаёт быть моно-ytmusic.
    # Уже целевой источник (сам артист — часть вкуса), доп. фильтр по теме не
    # нужен — иначе выкинули бы легитимные треки любимого артиста без тега в
    # заголовке.
    # Гарантированная доля плейлистным артистам + добор весовым топом. Плейлист
    # (особенно SoundCloud, чьи треки не сеют YT-радио) иначе не влияет на
    # разведку вообще: его артисты по весу проигрывают истории прослушиваний.
    sc_artists = list(
        dict.fromkeys(
            profile["playlist_artists"][:_SC_PLAYLIST_ARTISTS] + profile["artists"]
        )
    )[:_SC_EXPLORE_ARTISTS]
    if sc_artists:
        sc_pools = await asyncio.gather(
            *(_soundcloud_pool(request, a) for a in sc_artists)
        )
        merged.extend(t for pool in sc_pools for t in pool)

    # Разведка по тегам вкуса: реально новые треки (в т.ч. от незнакомых
    # авторов). НЕ ищем по одиночному неоднозначному слову ("гей") — провайдеры
    # отдают серьёзные/иностранные треки на тему. Ищем комбинацию top-тегов
    # ("сво гей", "гей порно") — это специфичный русский мем, а не firehose.
    # Нужно минимум 2 значимых тега, иначе разведку по тегам пропускаем.
    tag_words = list(profile.get("title_tags") or [])[:_TAG_EXPLORE_TAGS]
    if len(tag_words) >= 2:
        query = " ".join(tag_words[:2])
        tag_tracks = [
            t
            for t in await _tag_pool(request, query)
            if not is_foreign_script(t.title)
        ]
        merged.extend(tag_tracks)

    if merged:
        random.shuffle(merged)
        banned = profile["banned_artists"]
        for t in merged:
            key = _norm_key(t.artist, t.title)
            if t.external_id in excl_videos or key in seen_keys:
                continue
            # Артист, заскипанный в минус, не попадает в волну и из радио.
            if banned and any(a.strip().lower() in banned for a in t.artist.split(",")):
                continue
            seen_keys.add(key)
            excl_videos.add(t.external_id)
            # ytmusic отдаёт пустой stream_url (нужен base_url); у soundcloud он
            # уже проставлен search-ом с токеном — не перетираем.
            if t.source == "ytmusic":
                t.stream_url = f"{base_url}/api/ytdlp/stream/{t.external_id}"
            explore.append(t)

    # --- эксплуатация: локальная библиотека по вкусу ---
    local = await asyncio.to_thread(_local_candidates, db, profile, limit)
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

    # --- микс: ~60% разведка / 40% знакомое, добор из того, что осталось ---
    n_explore = min(len(explore), round(limit * _EXPLORE_RATIO))
    n_exploit = min(len(exploit), limit - n_explore)
    n_explore = min(len(explore), limit - n_exploit)  # добор разведкой

    random.shuffle(exploit)
    mix: List[dict] = []
    mix.extend(t.model_dump() for t in explore[:n_explore])
    mix.extend(
        TrackResponse.model_validate(t).model_dump(mode="json") for t in exploit[:n_exploit]
    )
    random.shuffle(mix)
    return mix
