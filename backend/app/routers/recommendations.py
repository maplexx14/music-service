from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session, selectinload
from sqlalchemy import func, desc, or_
from typing import List
from datetime import datetime, timezone
from collections import Counter
import re
from app.database import get_db
from app.cache import get_cache, set_cache
from app.models import Track, Playlist, User, user_track_plays, user_track_skips, playlist_tracks
from app.schemas import RecommendationResponse, TrackResponse, PlaylistResponse
from app.dependencies import get_current_active_user
from app.genre_keywords import infer_genre_from_text, build_keyword_filters, top_genre_keywords
from app.title_tags import build_tag_filters, build_title_tag_profile
from app.artist_genre import artists_matching_keywords

router = APIRouter()

# Рекомендации пересчитывать на каждый запрос дорого (несколько запросов с
# IN-списками и сортировками), а меняются они медленно — короткий кэш.
_RECS_TTL = 300

# Вес сигнала вкуса (лайк/прослушивание/скип) экспоненциально затухает со
# временем вместо жёсткого "топ-N" по позиции/play_count — иначе у активных
# пользователей более ранний, но всё ещё любимый артист резко выпадает из
# профиля, стоит наиграть чуть больше истории поверх него (см. аналогичный
# фикс в flow.py). Полураспад — раз в столько дней сигнал слабеет вдвое;
# лимит выборки — защита от неограниченного запроса, не смысловая отсечка.
_TASTE_HALF_LIFE_DAYS = 14.0
_TASTE_QUERY_LIMIT = 300


def _decay(ts, half_life_days: float = _TASTE_HALF_LIFE_DAYS) -> float:
    if ts is None:
        return 1.0
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    age_days = max(0.0, (datetime.now(timezone.utc) - ts).total_seconds() / 86400)
    return 0.5 ** (age_days / half_life_days)


@router.get("/", response_model=RecommendationResponse)
def get_recommendations(
    limit: int = 20,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    cache_key = f"recs:{current_user.id}:{limit}"
    cached = get_cache(cache_key)
    if cached is not None:
        return RecommendationResponse(**cached)

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
        db.query(Track.id, Track.artist, user_track_skips.c.skip_count, user_track_skips.c.last_skipped)
        .join(user_track_skips, user_track_skips.c.track_id == Track.id)
        .filter(user_track_skips.c.user_id == current_user.id)
        .order_by(desc(user_track_skips.c.last_skipped))
        .limit(_TASTE_QUERY_LIMIT)
        .all()
    )
    skipped_track_ids = {row[0] for row in skipped}

    # Combine liked and played track IDs
    user_track_ids = list(set(liked_track_ids + played_track_ids))

    recommended_tracks = []

    if user_track_ids:
        # Вес артиста: лайк/повтор — плюс (затухающий со временем), скип —
        # минус. В сид идут только те, у кого итог положительный (banned-
        # артисты — с отрицательным — выпадают).
        # Ключ — нормализованное (lowercase/trim) имя: SoundCloud и YT Music
        # отдают одного и того же артиста в разном написании, точное сравнение
        # раньше считало их разными артистами и резало матчинг для SC-треков.
        def _artist_key(name: str) -> str:
            return re.sub(r"\s+", " ", (name or "").strip().lower())

        artist_weight: dict = {}
        genres = []
        weighted_titles = []  # (title, decay_weight) — для build_title_tag_profile
        for t, added_at in liked:
            key = _artist_key(t.artist)
            artist_weight[key] = artist_weight.get(key, 0) + 1 * _decay(added_at)
            genre = t.genre or infer_genre_from_text(t.title, t.artist)
            if genre:
                genres.append(genre)
            weighted_titles.append((t.title, 1 * _decay(added_at)))
        for t, _play_count, last_played in played:
            key = _artist_key(t.artist)
            artist_weight[key] = artist_weight.get(key, 0) + 1 * _decay(last_played)
            genre = t.genre or infer_genre_from_text(t.title, t.artist)
            if genre:
                genres.append(genre)
            weighted_titles.append((t.title, 1 * _decay(last_played)))
        for _tid, artist, skip_count, last_skipped in skipped:
            key = _artist_key(artist)
            artist_weight[key] = artist_weight.get(key, 0) - (skip_count or 1) * _decay(last_skipped)
        artist_keys = [a for a, w in artist_weight.items() if w > 0]

        # Кандидаты по вкусу; скипнутые треки исключаем целиком. Условия строим
        # только для непустых списков — у внешних треков жанра нет, и пустой
        # IN (NULL) и матчил бы ничего, и сыпал бы предупреждением SQLAlchemy.
        taste_filters = []
        if genres:
            taste_filters.append(Track.genre.in_(set(genres)))
            # Плюс грубый матчинг по ключевым словам в названии — у внешних
            # треков genre почти всегда пуст, но само название часто прямо
            # называет жанр ("... Phonk Remix", "... Trap"). Берём top-3 самых
            # частых жанров вкуса (явных + угаданных), чтобы не раздувать
            # запрос десятками OR-условий.
            kw_conditions = build_keyword_filters(Track.title, Counter(genres))
            if kw_conditions:
                taste_filters.append(or_(*kw_conditions))
        title_tags = list(build_title_tag_profile(weighted_titles).keys())
        if title_tags:
            # Слова, которые пользователь сам "выбрал" тем, что регулярно
            # слушает треки с ними в названии — не привязаны ни к какому
            # заранее прописанному жанру (в отличие от genre_keywords выше).
            taste_filters.append(or_(*build_tag_filters(Track.title, title_tags)))
        if artist_keys:
            taste_filters.append(func.lower(Track.artist).in_(artist_keys))

        # Привязка жанра/темы к артисту целиком: если хотя бы часть каталога
        # артиста в базе матчит нужные слова, подтягиваем ВСЕ его треки — не
        # только тот единственный, где слово буквально есть в названии (иначе
        # тестовое прослушивание нескольких "гей"-треков даёт в рекомендациях
        # только один совпавший по заголовку трек).
        artist_bound_keywords = top_genre_keywords(Counter(genres)) + title_tags
        genre_artist_keys = artists_matching_keywords(db, artist_bound_keywords)
        if genre_artist_keys:
            taste_filters.append(func.lower(Track.artist).in_(genre_artist_keys))

        if taste_filters:
            exclude_ids = set(user_track_ids) | skipped_track_ids
            recommended_tracks = db.query(Track).filter(
                or_(*taste_filters)
            ).filter(~Track.id.in_(exclude_ids)).order_by(
                desc(Track.play_count)
            ).limit(limit).all()
    else:
        # Холодный старт: сигналов вкуса ещё нет — показываем популярное сервиса.
        # (Раньше популярным добивали ЛЮБУЮ неполную выдачу, из-за чего у активных
        # юзеров место релевантного занимали глобальные хиты — это и убрано.)
        cold = db.query(Track)
        if skipped_track_ids:
            cold = cold.filter(~Track.id.in_(skipped_track_ids))
        recommended_tracks = cold.order_by(desc(Track.play_count)).limit(limit).all()

    # Get popular playlists (selectinload: ответ встраивает tracks — иначе N+1)
    popular_playlists = db.query(Playlist).options(selectinload(Playlist.tracks)).filter(
        Playlist.is_public == True
    ).order_by(desc(Playlist.created_at)).limit(10).all()
    
    response = RecommendationResponse(
        tracks=[TrackResponse.model_validate(t) for t in recommended_tracks[:limit]],
        playlists=[PlaylistResponse.model_validate(p) for p in popular_playlists]
    )
    set_cache(cache_key, response.model_dump(mode="json"), expire=_RECS_TTL)
    return response


@router.get("/tracks", response_model=List[TrackResponse])
def get_recommended_tracks(
    limit: int = 20,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    recommendations = get_recommendations(limit=limit, current_user=current_user, db=db)
    return recommendations.tracks


@router.get("/playlists", response_model=List[PlaylistResponse])
def get_recommended_playlists(
    limit: int = 10,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    recommendations = get_recommendations(limit=limit, current_user=current_user, db=db)
    return recommendations.playlists
