from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session, selectinload
from sqlalchemy import func, desc, or_, select, union
from sqlalchemy.dialects.postgresql import insert as pg_insert
from typing import List, Optional
from datetime import datetime, timezone
from collections import Counter
import math
import re
import random
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
)
from app.schemas import RecommendationResponse, TrackResponse, PlaylistResponse
from app.dependencies import get_current_active_user
from app.genre_keywords import infer_genre_from_text, build_keyword_filters, top_genre_keywords, genre_is_compatible
from app.lang import is_foreign_script
from app.title_tags import build_tag_filters, build_title_tag_profile
from app.artist_genre import artists_matching_keywords
from app.cooccurrence import similar_track_ids
from app.diversity import cap_per_artist, interleave_artists

router = APIRouter()

# Рекомендации пересчитывать на каждый запрос дорого (несколько запросов с
# IN-списками и сортировками), а меняются они медленно — короткий кэш.
# Явные действия (лайк/скип) инвалидируют его сразу (см. tracks.py), TTL
# остаётся для пассивных прослушиваний.
_RECS_TTL = 300

# Вес сигнала вкуса (лайк/прослушивание/скип) экспоненциально затухает со
# временем вместо жёсткого "топ-N" по позиции/play_count — иначе у активных
# пользователей более ранний, но всё ещё любимый артист резко выпадает из
# профиля, стоит наиграть чуть больше истории поверх него (см. аналогичный
# фикс в flow.py). Полураспад — раз в столько дней сигнал слабеет вдвое;
# лимит выборки — защита от неограниченного запроса, не смысловая отсечка.
_TASTE_HALF_LIFE_DAYS = 14.0
_TASTE_QUERY_LIMIT = 300

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
_ARTIST_TRUST_THRESHOLD = 3.0

# --- Дослушивания (completion из user_play_events) ---
# Средняя доля дослушивания уточняет бинарный play/skip: стабильно
# дослушиваемый трек — более сильный плюс, стабильно бросаемый на 10-30% —
# мягкий минус, даже если явного скипа (<25% и переключил) не было.
_COMPLETION_HI = 0.85   # >= — усиливаем вес прослушиваний трека
_COMPLETION_LO = 0.30   # <= — ослабляем и слегка штрафуем артиста
_COMPLETION_HI_BOOST = 1.3
_COMPLETION_LO_DAMP = 0.5
_COMPLETION_LO_ARTIST_PENALTY = 0.75

# --- Exploration / exploitation ---
# Доля слотов выдачи под «исследование»: co-occurrence-соседи любимых треков
# (коллаборативный сигнал), в приоритете — артисты, которых юзер ещё не
# слушал. Остальная выдача — «эксплуатация» известного вкуса.
_EXPLORE_RATIO = 0.2

# --- Показы (rec_impressions) ---
# Трек, показанный в рекомендациях столько раз и ни разу не сыгранный,
# выпадает из выдачи — иначе проигнорированные рекомендации возвращаются
# снова и снова, пока юзер не сыграет их «случайно».
_IMPRESSION_FATIGUE_THRESHOLD = 4

# --- Время суток ---
# Половина людей слушает разное утром и перед сном. События прослушивания в
# том же временном интервале, что текущий запрос (client_hour с фронта),
# дают артисту бонус — профиль мягко смещается к «вкусу этого времени дня».
_TIME_BUCKET_BONUS = 0.5


def _hour_bucket(hour: Optional[int]) -> Optional[str]:
    if hour is None:
        return None
    if 5 <= hour < 11:
        return "morning"
    if 11 <= hour < 17:
        return "day"
    if 17 <= hour < 23:
        return "evening"
    return "night"


_BUCKET_HOURS = {
    "morning": list(range(5, 11)),
    "day": list(range(11, 17)),
    "evening": list(range(17, 23)),
    "night": [23, 0, 1, 2, 3, 4],
}


def _varied_popular(db: Session, exclude_ids: set, need: int) -> list:
    """Случайная выборка из широкого пула популярного (без иностранного).
    Не фиксированный топ-N: у каждого юзера свой набор — и для холодного
    старта, и для добора тонкой выдачи, чтобы рекомендации были свои у
    каждого, а не один и тот же глобальный список."""
    if need <= 0:
        return []
    q = db.query(Track)
    if exclude_ids:
        q = q.filter(~Track.id.in_(exclude_ids))
    pool = [
        t
        for t in q.order_by(desc(Track.play_count)).limit(max(need * 5, 100)).all()
        # Фильтр иностранного здесь и обещан docstring'ом, и нужен: холодный
        # старт не должен подсовывать стабильно скипаемые CJK/вьетнамские хиты.
        if not is_foreign_script(t.title)
    ]
    random.shuffle(pool)
    return cap_per_artist(pool, _MAX_PER_ARTIST)[:need]


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
def get_recommendations(
    limit: int = 20,
    hour: Optional[int] = Query(None, ge=0, le=23),
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    # hour — локальный час клиента (таймзона юзера серверу неизвестна).
    # Кэш сегментируем по временному интервалу: утренняя и вечерняя выдачи
    # различаются и не должны перетирать друг друга.
    bucket = _hour_bucket(hour)
    cache_key = f"recs:v3-library:{current_user.id}:{limit}:{bucket or 'any'}"
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

    # Треки из СОБСТВЕННЫХ (не is_liked) плейлистов юзера — он их сам курировал,
    # это тоже положительный сигнал вкуса. Учитываем наравне с лайками и
    # исключаем из выдачи (уже в коллекции). Трек может быть в нескольких
    # плейлистах — дедуп по Track.id, берём самое свежее добавление.
    playlisted = (
        db.query(Track, func.max(playlist_tracks.c.added_at).label("added_at"))
        .join(playlist_tracks, playlist_tracks.c.track_id == Track.id)
        .join(Playlist, Playlist.id == playlist_tracks.c.playlist_id)
        .filter(Playlist.owner_id == current_user.id, Playlist.is_liked == False)
        .group_by(Track.id)
        .order_by(desc("added_at"))
        .limit(_TASTE_QUERY_LIMIT)
        .all()
    )
    playlisted_track_ids = [t.id for t, _ in playlisted]

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
    fatigued_ids = set(
        db.execute(
            select(rec_impressions.c.track_id).where(
                rec_impressions.c.user_id == current_user.id,
                rec_impressions.c.shown_count >= _IMPRESSION_FATIGUE_THRESHOLD,
            )
        ).scalars()
    )

    # Combine liked, played and playlisted track IDs (всё это уже в коллекции
    # юзера — исключаем из выдачи и используем как сигнал вкуса).
    user_track_ids = list(set(liked_track_ids + played_track_ids + playlisted_track_ids))

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

        # Положительный сигнал вкуса (лайк/плейлист/повторы) и штраф за скипы
        # считаем РАЗДЕЛЬНО — чтобы порог доверия применять к чистому плюсу.
        # Интенсивность учитывается симметрично лог-масштабом (иначе любимый,
        # но мемно-«пролистываемый» артист уходил в минус: play_count раньше
        # игнорировался, а скип вычитал полный skip_count). Веса как во flow.py:
        # лайк +3, плейлист +2, прослушивание 1+log1p(play_count), скип
        # −1.5·log1p(skip_count).
        artist_positive: dict = {}
        artist_skip_penalty: dict = {}
        # Сколько треков артиста юзер КУРИРОВАЛ (лайк/плейлист) — для
        # доверия по факту курирования, независимо от затухающих весов.
        artist_curated_count: dict = {}
        genres = []
        weighted_titles = []  # (title, decay_weight) — для build_title_tag_profile
        # Лайки и треки из собственных плейлистов — сигнал курирования; лайк
        # весомее (юзер явно добавил в «Мне нравится»). Затухание — медленное
        # кураторское (_curation_decay), НЕ 14-дневное поведенческое: иначе
        # плейлисты месячной давности почти не влияли на рекомендации.
        for t, added_at in liked:
            key = _artist_key(t.artist)
            artist_positive[key] = artist_positive.get(key, 0) + 3.0 * _curation_decay(added_at)
            artist_curated_count[key] = artist_curated_count.get(key, 0) + 1
            genre = t.genre or infer_genre_from_text(t.title, t.artist)
            if genre:
                genres.append(genre)
            weighted_titles.append((t.title, 3.0 * _curation_decay(added_at)))
        for t, added_at in playlisted:
            key = _artist_key(t.artist)
            artist_positive[key] = artist_positive.get(key, 0) + 2.0 * _curation_decay(added_at)
            artist_curated_count[key] = artist_curated_count.get(key, 0) + 1
            genre = t.genre or infer_genre_from_text(t.title, t.artist)
            if genre:
                genres.append(genre)
            weighted_titles.append((t.title, 2.0 * _curation_decay(added_at)))
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
                        key = _artist_key(t.artist)
                        artist_skip_penalty[key] = (
                            artist_skip_penalty.get(key, 0)
                            + _COMPLETION_LO_ARTIST_PENALTY * _decay(last_played)
                        )
            key = _artist_key(t.artist)
            artist_positive[key] = artist_positive.get(key, 0) + w
            genre = t.genre or infer_genre_from_text(t.title, t.artist)
            if genre:
                genres.append(genre)
            weighted_titles.append((t.title, w))
        for _tid, artist, skip_count, last_skipped in skipped:
            key = _artist_key(artist)
            artist_skip_penalty[key] = (
                artist_skip_penalty.get(key, 0) + 1.5 * math.log1p(skip_count or 1) * _decay(last_skipped)
            )

        # Контекст времени суток: артисты, которых юзер слушает в текущем
        # временном интервале (по client_hour из лога событий), получают бонус
        # — утренняя выдача тяготеет к «утреннему» вкусу, вечерняя к вечернему.
        if bucket is not None:
            time_rows = db.execute(
                select(Track.artist, func.count().label("cnt"))
                .select_from(
                    user_play_events.join(Track, Track.id == user_play_events.c.track_id)
                )
                .where(
                    user_play_events.c.user_id == current_user.id,
                    user_play_events.c.client_hour.in_(_BUCKET_HOURS[bucket]),
                )
                .group_by(Track.artist)
            ).all()
            for artist, cnt in time_rows:
                key = _artist_key(artist)
                if key in artist_positive:
                    artist_positive[key] += _TIME_BUCKET_BONUS * math.log1p(cnt)

        # Доверенный артист: положительный сигнал сам по себе уверенный
        # (>= порога), ЛИБО юзер курировал 2+ его трека (лайк/плейлист —
        # осознанные добавления в коллекцию, давность не важна) — тогда скипы
        # НЕ бьют по всему каталогу, работают только на уровне скипнутого
        # трека (он и так в exclude_ids). Ещё НЕ доверенный — скипы влияют
        # сильно: пускаем в сид, только если плюс перевешивает штраф за скипы.
        artist_keys = [
            key
            for key, pos in artist_positive.items()
            if pos >= _ARTIST_TRUST_THRESHOLD
            or artist_curated_count.get(key, 0) >= _CURATED_TRUST_COUNT
            or pos - artist_skip_penalty.get(key, 0) > 0
        ]

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
        # Слова, которые пользователь сам "выбрал" тем, что регулярно слушает
        # треки с ними в названии. Одиночное неоднозначное слово ("гей") как
        # фильтр НЕ используется (тянет серьёзные/иностранные треки на ту же
        # тему) — build_tag_filters требует пару тегов и вернёт [] на одном.
        tag_conditions = build_tag_filters(Track.title, title_tags)
        if tag_conditions:
            taste_filters.append(or_(*tag_conditions))
        if artist_keys:
            taste_filters.append(func.lower(Track.artist).in_(artist_keys))

        # Привязка жанра/темы к артисту целиком: если хотя бы часть каталога
        # артиста в базе матчит нужные слова, подтягиваем ВСЕ его треки — не
        # только тот единственный, где слово буквально есть в названии (иначе
        # тестовое прослушивание нескольких "гей"-треков даёт в рекомендациях
        # только один совпавший по заголовку трек). Жанровые слова однозначны
        # — им хватает одного совпадения; теги вкуса (title_tags) могут быть
        # неоднозначным словом на тему ("гей") — там требуем пару тегов
        # разом, иначе один случайный серьёзный трек с тем же словом у
        # постороннего артиста тянет весь его чужой каталог.
        genre_artist_keys = artists_matching_keywords(db, top_genre_keywords(Counter(genres)))
        genre_artist_keys |= artists_matching_keywords(db, title_tags, min_matches=2)
        if genre_artist_keys:
            taste_filters.append(func.lower(Track.artist).in_(genre_artist_keys))

        # Python-set — для фильтрации в памяти (exploration и т.п.); SQL-
        # исключение коллекции идёт подзапросом (см. _collection_exclude_select).
        exclude_ids = set(user_track_ids) | skipped_track_ids | fatigued_ids
        exclude_select = _collection_exclude_select(current_user.id)
        if taste_filters:
            # Берём с запасом (limit*3) — после genre-фильтра и cap_per_artist
            # часть кандидатов отсеется.
            q = db.query(Track).filter(or_(*taste_filters)).filter(
                ~Track.id.in_(exclude_select)
            )
            # «Уставшие» показы — маленький список, ему литеральный NOT IN ок.
            if fatigued_ids:
                q = q.filter(~Track.id.in_(fatigued_ids))
            pool = q.order_by(desc(Track.play_count)).limit(limit * 3).all()
            # Совпадение по слову в названии/теге само по себе не значит
            # "тот же дух" — трек мог попасть в выдачу по случайному слову в
            # заголовке, будучи из совсем другого жанра. Артистов, которых
            # пользователь уже реально слушает, из проверки исключаем — это
            # доверенный сигнал сам по себе.
            user_genres = set(genres)
            pool = [
                t for t in pool
                if _artist_key(t.artist) in artist_keys
                or genre_is_compatible(t.genre, t.title, t.artist, user_genres)
            ]
            # Иностранное (вьетнам/CJK/деванагари и т.п.) юзер стабильно
            # скипает — режем, кроме треков уже слушаемых им артистов.
            pool = [
                t for t in pool
                if _artist_key(t.artist) in artist_keys or not is_foreign_script(t.title)
            ]
            recommended_tracks = cap_per_artist(pool, _MAX_PER_ARTIST)[:limit]

        # Exploration-слоты: ~20% выдачи — co-occurrence-соседи любимых треков
        # («слушавшие X слушают и Y»). Единственный сигнал, открывающий юзеру
        # НОВЫХ артистов: контентные фильтры выше рекомендуют в основном
        # каталог уже знакомых. Приоритет — треки артистов вне artist_keys.
        n_explore = max(1, int(limit * _EXPLORE_RATIO))
        got_ids = {t.id for t in recommended_tracks}
        seeds = (liked_track_ids + played_track_ids)[:60]
        neighbor_ids = [
            tid
            for tid, _score in similar_track_ids(db, seeds, limit=150)
            if tid not in exclude_ids and tid not in got_ids
        ]
        explore_tracks = []
        if neighbor_ids:
            by_id = {
                t.id: t
                for t in db.query(Track).filter(Track.id.in_(neighbor_ids)).all()
            }
            ordered = [
                by_id[tid]
                for tid in neighbor_ids
                if tid in by_id and not is_foreign_script(by_id[tid].title)
            ]
            fresh = [t for t in ordered if _artist_key(t.artist) not in artist_keys]
            known = [t for t in ordered if _artist_key(t.artist) in artist_keys]
            # 1 трек на артиста: exploration должен максимизировать охват
            # нового, а не заполнять слоты одним новым артистом.
            explore_tracks = cap_per_artist(fresh + known, 1)[:n_explore]
        if explore_tracks:
            keep = limit - len(explore_tracks)
            recommended_tracks = recommended_tracks[:keep] + explore_tracks

        # Добор варьируемым популярным, если вкусовых нашлось мало ИЛИ вообще
        # не набралось фильтров (напр. у юзера один played-трек, чей артист
        # ушёл в минус из-за скипов → taste_filters пуст). Без этого такие
        # юзеры видели ПУСТУЮ выдачу. Активных не задевает: у них уже >= limit.
        if len(recommended_tracks) < limit:
            got = {t.id for t in recommended_tracks}
            recommended_tracks += _varied_popular(
                db, exclude_ids | got, limit - len(recommended_tracks)
            )
    else:
        # Холодный старт: сигналов вкуса ещё нет — показываем популярное сервиса.
        # (Раньше популярным добивали ЛЮБУЮ неполную выдачу, из-за чего у активных
        # юзеров место релевантного занимали глобальные хиты — это и убрано.)
        recommended_tracks = _varied_popular(db, skipped_track_ids | fatigued_ids, limit)

    recommended_tracks = interleave_artists(recommended_tracks)[:limit]

    # Фиксируем показы (для сигнала «показан N раз — не сыгран»). Пока ответ
    # живёт в кэше, повторные отдачи того же списка показом не считаются —
    # это осознанно: юзер видел ОДНУ выдачу, а не пять.
    for t in recommended_tracks:
        db.execute(
            pg_insert(rec_impressions)
            .values(
                user_id=current_user.id,
                track_id=t.id,
                shown_count=1,
                last_shown=func.now(),
            )
            .on_conflict_do_update(
                index_elements=[rec_impressions.c.user_id, rec_impressions.c.track_id],
                set_={
                    "shown_count": rec_impressions.c.shown_count + 1,
                    "last_shown": func.now(),
                },
            )
        )
    db.commit()

    # Get popular playlists (selectinload: ответ встраивает tracks — иначе N+1)
    popular_playlists = db.query(Playlist).options(selectinload(Playlist.tracks)).filter(
        Playlist.is_public == True
    ).order_by(desc(Playlist.created_at)).limit(10).all()

    response = RecommendationResponse(
        tracks=[TrackResponse.model_validate(t) for t in recommended_tracks],
        playlists=[PlaylistResponse.model_validate(p) for p in popular_playlists]
    )
    set_cache(cache_key, response.model_dump(mode="json"), expire=_RECS_TTL)
    return response


@router.get("/tracks", response_model=List[TrackResponse])
def get_recommended_tracks(
    limit: int = 20,
    hour: Optional[int] = Query(None, ge=0, le=23),
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    recommendations = get_recommendations(limit=limit, hour=hour, current_user=current_user, db=db)
    return recommendations.tracks


@router.get("/playlists", response_model=List[PlaylistResponse])
def get_recommended_playlists(
    limit: int = 10,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    recommendations = get_recommendations(limit=limit, current_user=current_user, db=db)
    return recommendations.playlists
