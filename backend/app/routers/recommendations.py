from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
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
from app.genre_keywords import infer_genre_from_text, build_keyword_filters, top_genre_keywords
from app.lang import dominant_is_cyrillic, is_foreign_script
from app.taste import make_relevance_check, track_check
from app.title_tags import build_tag_filters, build_title_tag_profile
from app.artist_genre import artists_matching_keywords
from app.cooccurrence import pair_scores, similar_track_ids
from app.diversity import cap_per_artist, interleave_artists, mmr, primary_artist_key, weighted_order
from app.artist_utils import artist_key

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
# Плейлистные треки (вес +4.0) достигают порога ещё быстрее.
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

# --- Exploration / exploitation ---
# Доля слотов выдачи под «исследование»: co-occurrence-соседи любимых треков
# (коллаборативный сигнал), в приоритете — артисты, которых юзер ещё не
# слушал. Остальная выдача — «эксплуатация» известного вкуса.
_EXPLORE_RATIO = 0.2

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


def _varied_popular(
    db: Session,
    exclude_ids: set,
    need: int,
    keep=None,
    used: Optional[dict] = None,
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
    """
    if need <= 0:
        return []
    q = db.query(Track)
    if exclude_ids:
        q = q.filter(~Track.id.in_(exclude_ids))
    # С предикатом вкуса отсев жёстче, поэтому берём пул с большим запасом.
    window = max(need * (40 if keep else 5), 100)
    pool = [
        t
        for t in q.order_by(desc(Track.play_count)).limit(window).all()
        # Фильтр иностранного здесь и обещан docstring'ом, и нужен: холодный
        # старт не должен подсовывать стабильно скипаемые CJK/вьетнамские хиты.
        if not is_foreign_script(t.title) and (keep is None or keep(t))
    ]
    random.shuffle(pool)
    return cap_per_artist(pool, _MAX_PER_ARTIST, used=used)[:need]


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
    # это самый сильный положительный сигнал вкуса (весомее лайков). Учитываем
    # и исключаем из выдачи (уже в коллекции). Трек может быть в нескольких
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

        # Положительный сигнал вкуса (лайк/плейлист/повторы) и штраф за скипы
        # считаем РАЗДЕЛЬНО — чтобы порог доверия применять к чистому плюсу.
        # Интенсивность учитывается симметрично лог-масштабом (иначе любимый,
        # но мемно-«пролистываемый» артист уходил в минус: play_count раньше
        # игнорировался, а скип вычитал полный skip_count). Веса как во flow.py:
        # лайк +3, плейлист +4, прослушивание 1+log1p(play_count), скип
        # −1.5·log1p(skip_count).
        artist_positive: dict = {}
        artist_skip_penalty: dict = {}
        # Сколько треков артиста юзер КУРИРОВАЛ (лайк/плейлист) — для
        # доверия по факту курирования, независимо от затухающих весов.
        artist_curated_count: dict = {}
        genres = []
        weighted_titles = []  # (title, decay_weight) — для build_title_tag_profile
        # Артисты ИЗ КАСТОМНЫХ плейлистов (не «Понравившиеся») — strongest signal.
        # Их треки должны гарантированно попадать в выдачу, даже если play_count
        # низкий. Используется для приоритизации в пуле рекомендаций.
        playlist_artist_keys: set = set()
        # Лайки и треки из собственных плейлистов — сигнал курирования; плейлист
        # весомее лайков (юзер осознанно подбирал композиции). Затухание — медленное
        # кураторское (_curation_decay), НЕ 14-дневное поведенческое: иначе
        # плейлисты месячной давности почти не влияли на рекомендации.
        for t, added_at in liked:
            key = artist_key(t.artist)
            artist_positive[key] = artist_positive.get(key, 0) + 3.0 * _curation_decay(added_at)
            artist_curated_count[key] = artist_curated_count.get(key, 0) + 1
            genre = t.genre or infer_genre_from_text(t.title, t.artist)
            if genre:
                genres.append(genre)
            weighted_titles.append((t.title, 3.0 * _curation_decay(added_at)))
        for t, added_at in playlisted:
            key = artist_key(t.artist)
            artist_positive[key] = artist_positive.get(key, 0) + 4.0 * _curation_decay(added_at)
            artist_curated_count[key] = artist_curated_count.get(key, 0) + 1
            playlist_artist_keys.add(key)
            genre = t.genre or infer_genre_from_text(t.title, t.artist)
            if genre:
                genres.append(genre)
            weighted_titles.append((t.title, 4.0 * _curation_decay(added_at)))
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
                        key = artist_key(t.artist)
                        artist_skip_penalty[key] = (
                            artist_skip_penalty.get(key, 0)
                            + _COMPLETION_LO_ARTIST_PENALTY * _decay(last_played)
                        )
            key = artist_key(t.artist)
            artist_positive[key] = artist_positive.get(key, 0) + w
            genre = t.genre or infer_genre_from_text(t.title, t.artist)
            if genre:
                genres.append(genre)
            weighted_titles.append((t.title, w))
        for _tid, artist, skip_count, last_skipped, disliked in skipped:
            key = artist_key(artist)
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
                key = artist_key(artist)
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
            or pos - artist_skip_penalty.get(key, 0) >= _NET_TRUST_MARGIN
        ]

        # Единая проверка релевантности для ВСЕХ путей выдачи (основной пул,
        # co-occurrence-соседи, добор популярным). Раньше каждый путь фильтровал
        # по-своему, и постороннее протекало через тот, что чинили последним.
        _prefer_cyrillic = dominant_is_cyrillic(
            [f"{t.title} {t.artist}" for t, *_ in liked]
            + [f"{t.title} {t.artist}" for t, *_ in playlisted]
            + [f"{t.title} {t.artist}" for t, *_ in played]
        )
        keep_track = track_check(
            make_relevance_check(
                trusted_artist_keys=set(artist_keys),
                user_genres=set(genres),
                prefer_cyrillic=_prefer_cyrillic,
            )
        )
        # Для добора глобально популярным — строгий вариант: там кандидат не
        # связан со вкусом ничем, поэтому нужно положительное подтверждение.
        keep_unrelated = track_check(
            make_relevance_check(
                trusted_artist_keys=set(artist_keys),
                user_genres=set(genres),
                prefer_cyrillic=_prefer_cyrillic,
                require_signal=True,
            )
        )

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
        genreartist_keys = artists_matching_keywords(db, top_genre_keywords(Counter(genres)))
        genreartist_keys |= artists_matching_keywords(db, title_tags, min_matches=2)
        if genreartist_keys:
            taste_filters.append(func.lower(Track.artist).in_(genreartist_keys))

        # Python-set — для фильтрации в памяти (exploration и т.п.); SQL-
        # исключение коллекции идёт подзапросом (см. _collection_exclude_select).
        # Усталость показов — сигнал ПОРЯДКА, а не исключения: «показан 4 раза и
        # не сыгран» ставит трек в конец очереди, но не выбрасывает его. Жёсткое
        # исключение выжигало пул у активных юзеров (у одного — 191 трек из 300
        # показанных), после чего выдача добивалась чем попало. Релевантный
        # повтор лучше нерелевантной новинки.
        exclude_ids = set(user_track_ids) | skipped_track_ids
        exclude_select = _collection_exclude_select(current_user.id)
        if taste_filters:
            # Берём с запасом — после genre-фильтра и cap_per_artist
            # часть кандидатов отсеется. Увеличиваем выборку, чтобы нишевые
            # артисты из плейлистов (play_count=1-6) не вытеснялись
            # глобально популярными треками из лайкнутого.
            q = db.query(Track).filter(or_(*taste_filters)).filter(
                ~Track.id.in_(exclude_select)
            )
            # Окно берём СЛУЧАЙНО, а не топом по play_count: топ окна — это
            # всегда самые заигранные треки нескольких артистов, поэтому выдача
            # крутила одних и тех же, хотя вкусовых артистов в библиотеке сотни.
            # Никакая сортировка в Python остальных уже не достанет — их просто
            # нет в выборке.
            pool = q.order_by(func.random()).limit(limit * 8).all()
            # Гарантируем, что треки доверенных артистов (из плейлистов)
            # попадают в пул, даже если их play_count низкий и они не
            # прошли в limit*8 по популярности. Иначе плейлисты с нишевыми
            # артистами (SoundCloud, малая база) систематически игнорируются.
            curated_in_pool = {t.id for t in pool}
            # Гарантируем треки доверенных артистов (из плейлистов): делаем
            # ОТДЕЛЬНЫЙ запрос по каждому плейлистному артисту, т.к. общий
            # `.in_(artist_keys)` с 97+ элементами (кириллица/юникод) может
            # молча не матчить отдельных артистов.
            _played_liked_keys = {artist_key(t.artist) for t, _ in liked}
            _played_liked_keys |= {artist_key(t.artist) for t, _, _ in played}
            _new_playlist_keys = playlist_artist_keys - _played_liked_keys
            for pk in _new_playlist_keys:
                extra = db.query(Track).filter(
                    func.lower(Track.artist) == pk,
                    ~Track.id.in_(exclude_select),
                ).order_by(desc(Track.play_count)).all()
                for t in extra:
                    if t.id not in curated_in_pool:
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
            rotation = {
                key: i
                for i, key in enumerate(weighted_order(artist_keys, artist_positive))
            }
            pool.sort(
                key=lambda t: (
                    1 if t.id in fatigued_ids else 0,
                    0 if artist_key(t.artist) in playlist_artist_keys else 1,
                    rotation.get(artist_key(t.artist), len(rotation)),
                    -t.play_count,
                )
            )
            # Совпадение по слову в названии/теге само по себе не значит
            # "тот же дух" — трек мог попасть в выдачу по случайному слову в
            # заголовке, будучи из совсем другого жанра (плюс отсев иностранного
            # и, при одноязычной библиотеке, чужого языка). Артисты, которых
            # юзер реально слушает, проходят проверку сами по себе.
            pool = [t for t in pool if keep_track(t)]
            capped = cap_per_artist(pool, _MAX_PER_ARTIST)
            # Разнообразие по АУДИТОРИИ, а не только по имени артиста: cap выше
            # не видит, когда артисты формально разные, но все из одной тусовки.
            # Похожесть берём из co-occurrence по кандидатам-финалистам (запас
            # limit*3, чтобы MMR было из чего выбирать, но запрос остался мелким).
            shortlist = capped[: limit * 3]
            recommended_tracks = mmr(
                shortlist, pair_scores(db, [t.id for t in shortlist])
            )[:limit]

        # Exploration-слоты: ~20% выдачи — co-occurrence-соседи любимых треков
        # («слушавшие X слушают и Y»). Единственный сигнал, открывающий юзеру
        # НОВЫХ артистов: контентные фильтры выше рекомендуют в основном
        # каталог уже знакомых. Приоритет — треки артистов вне artist_keys.
        # Плейлистные треки — strongest signal (+4.0), их сиды должны
        # питать co-occurrence, иначе нишевые артисты из плейлистов
        # не открывают похожих (см. баг: playlist 30 → user 11 пусто).
        n_explore = max(1, int(limit * _EXPLORE_RATIO))
        got_ids = {t.id for t in recommended_tracks}
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
            fresh = [t for t in ordered if artist_key(t.artist) not in artist_keys]
            known = [t for t in ordered if artist_key(t.artist) in artist_keys]
            # 1 трек на артиста: exploration должен максимизировать охват
            # нового, а не заполнять слоты одним новым артистом. Лимит считаем
            # с учётом уже отобранного основного пула — иначе артист, у
            # которого там уже 2 трека, получал сверху ещё и explore-слот.
            neighbors = cap_per_artist(
                fresh + known,
                1,
                used=Counter(
                    primary_artist_key(t.artist) for t in recommended_tracks
                ),
            )
        explore_tracks = neighbors[:n_explore]
        if explore_tracks:
            n_keep = limit - len(explore_tracks)
            recommended_tracks = recommended_tracks[:n_keep] + explore_tracks

        # Добор, когда вкусовых кандидатов нашлось мало ИЛИ фильтры вообще не
        # набрались (напр. единственный played-трек, чей артист ушёл в минус по
        # скипам) — иначе такие юзеры видели ПУСТУЮ выдачу.
        #
        # Сначала — ОСТАЛЬНЫЕ co-occurrence-соседи (сверх explore-квоты): это
        # всё ещё «слушавшие ваше слушают и это», т.е. персональный сигнал.
        # Раньше добор шёл сразу глобальным популярным, и на небольшом локальном
        # каталоге он забирал БОЛЬШИНСТВО слотов: у слушателя русского рэпа
        # 11 из 18 позиций занимали Hell March, Rick Astley и AC/DC, хотя
        # непоказанных релевантных соседей оставалось больше сотни.
        if len(recommended_tracks) < limit:
            got = {t.id for t in recommended_tracks}
            # Через тот же лимит на артиста, что и основной пул: добор шёл
            # сырым срезом соседей, и один артист добирал здесь сверх своих
            # двух мест.
            used = Counter(primary_artist_key(t.artist) for t in recommended_tracks)
            recommended_tracks += cap_per_artist(
                [t for t in neighbors if t.id not in got],
                _MAX_PER_ARTIST,
                used=used,
            )[: limit - len(recommended_tracks)]
        # Глобально популярное — последний резерв: только если персональных
        # кандидатов не хватило даже вместе с соседями.
        if len(recommended_tracks) < limit:
            got = {t.id for t in recommended_tracks}
            recommended_tracks += _varied_popular(
                db,
                exclude_ids | got,
                limit - len(recommended_tracks),
                keep=keep_unrelated,
                used=Counter(
                    primary_artist_key(t.artist) for t in recommended_tracks
                ),
            )
            # Пул вкуса исчерпан (у активного юзера почти весь релевантный
            # каталог уже в коллекции/показах) — отдаём КОРОТКУЮ выдачу вместо
            # добивки посторонним. Раньше именно здесь слушателю русского рэпа
            # прилетали поп и ретро.
    else:
        # Холодный старт: сигналов вкуса ещё нет — показываем популярное сервиса.
        # (Раньше популярным добивали ЛЮБУЮ неполную выдачу, из-за чего у активных
        # юзеров место релевантного занимали глобальные хиты — это и убрано.)
        recommended_tracks = _varied_popular(db, skipped_track_ids | fatigued_ids, limit)

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
    seen_impression_ids = set()
    impression_rows = []
    for t in recommended_tracks:
        if t.id in seen_impression_ids:
            continue
        seen_impression_ids.add(t.id)
        impression_rows.append(
            {
                "user_id": current_user.id,
                "track_id": t.id,
                "shown_count": 1,
                "last_shown": func.now(),
            }
        )
    if impression_rows:
        stmt = pg_insert(rec_impressions).values(impression_rows)
        db.execute(
            stmt.on_conflict_do_update(
                index_elements=[rec_impressions.c.user_id, rec_impressions.c.track_id],
                set_={
                    "shown_count": rec_impressions.c.shown_count + 1,
                    "last_shown": func.now(),
                },
            )
        )
        db.commit()

    # Get popular playlists — без selectinload(tracks): ответ встраивает только
    # метаданные плейлистов (название, обложка), а не все их треки. Полный
    # список треков плейлиста загружается при открытии PlaylistDetail.
    popular_playlists = db.query(Playlist).filter(
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
