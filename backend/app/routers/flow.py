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
import functools
import json
import logging
import time
from contextvars import ContextVar
import math
import os
import re
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional

import requests
from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.encoders import jsonable_encoder
from sqlalchemy import and_, desc, func, or_, select, tuple_
from sqlalchemy.orm import Session

from app import (
    artist_probe,
    beets_genre,
    beets_similar,
    censorship,
    flow_session,
    lastfm_genres,
    learned_ranker,
    storage,
)
from app.cache import delete_cache, get_cache_async, redis_client, set_cache_async
from app.database import get_db
from app.dependencies import get_current_active_user
from app.discovery import (
    DEFAULT_DISCOVERY_RATIO,
    discovery_ratio,
    discovery_slots,
    liked_slots,
)
from app.discovery_feedback import (
    cached_outcome_stats,
    cached_population_stats,
    language_terms,
    origin_terms,
    source_posteriors,
    thompson_source_order,
)
from app.artist_genre import artists_matching_keywords
from app.genre_keywords import (
    build_keyword_filters,
    infer_genre_from_text,
    top_genre_keywords,
    weighted_explicit_genres,
)
from app.lang import cyrillic_share, dominant_is_cyrillic, script_of
from app.taste import make_relevance_check, track_check
from app.title_tags import build_tag_filters, build_title_tag_profile
from app.flow_slate import SlateRules, compose_slate
from app.diversity import (
    artist_part_keys,
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
    rank_popularity,
    population_quality_score,
    population_rejects,
    score_components,
    score_track,
    stable_jitter,
)
from app.acoustic_features import weighted_centroid
from app.feedback_labels import FEEDBACK_EVENT_TYPES, GOOD_COMPLETION, OutcomeTracker
from app.playlist_signals import aggregate_playlist_origin, find_liked_playlist_id
from app.context_profile import build_context_profile, context_bonus, hour_bucket
from app.recommendation_cache import flow_pc_meta_key, flow_ready_key, negative_signal_key
from app.recommendation_telemetry import new_request_id, record_delivery
from app.artist_utils import (
    artist_key,
    effective_artist_title,
    effective_track_artist_title,
    is_derivative_title,
    names_whole_artist,
    same_artist,
)
from app.models import (
    Track,
    User,
    Playlist,
    playlist_tracks,
    user_play_events,
    user_track_plays,
    user_track_skips,
    recommendation_events,
    recommendation_impressions,
)
from app import mainstream
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
# Сколько разных песен артиста в коллекции (лайки и свои плейлисты) делают его
# любимым в смысле мейнстрим-фильтра: только любимым волна отдаёт глубокий
# каталог, у остальных — лишь хиты (app/mainstream.py). Выбор владельца
# продукта, 2026-10-01; у активных юзеров это 15 и 9 артистов.
_DEEP_CATALOG_MIN_TRACKS = 5
# Потолок доли порции у артистов, впервые попавших в коллекцию за последние
# _FRESH_CLUSTER_DAYS. Прод, 2026-10-09: за 5–8 окт. владелец лайкнул в волне
# ~40 хитов 70–80-х, каждый лайк открывал каталог артиста и свежие сиды, и за
# 3 дня AC/DC, Lynyrd Skynyrd, Status Quo, CCR… шли вровень с Limp Bizkit (98
# треков в коллекции). Свежий кластер не вырезаем — он ограничен долей, а
# долгосрочное ядро вкуса получает остальную порцию.
_FRESH_CLUSTER_DAYS = 7
_FRESH_CLUSTER_SHARE = 0.3
# Сколько ждём Last.fm в мейнстрим-фильтре сверх сетевых источников. Не успевшие
# запросы догреют кэш в фоне — см. mainstream.artist_hits.
_MAINSTREAM_WAIT = 1.5
# Хиты похожих артистов — источник под мейнстрим-фильтр: сам фильтр только
# отбирает, а radio и Last.fm getSimilar приносят у соседа что попало, и сосед
# выпадал целиком вместо того, чтобы прийти своими хитами. Сид — артист (любимый
# или из свежих позитивов), _SIMILAR_HITS_SEEDS на запрос. У сида проверяем
# известность первых _SIMILAR_HITS_CHECK соседей, берём _SIMILAR_HITS_ARTISTS
# известных и по _SIMILAR_HITS_PER_ARTIST трека из их топа. Резолв — поиск у
# провайдеров на трек, поэтому пул кэшируется на сид.
_SIMILAR_HITS_SEEDS = 2
_SIMILAR_HITS_CHECK = 12
_SIMILAR_HITS_ARTISTS = 5
_SIMILAR_HITS_PER_ARTIST = 2
_SIMILAR_HITS_TTL = 6 * 60 * 60
# Выбранный в настройках жанр (_genre_hits_pool): артисты жанра — топ тега
# Last.fm, сверенный с тегами самих артистов, — и их хиты. Не поиск по слову:
# 2026-10-13 поиск «rock»/«pop» за час принёс владельцу «POP IT», «Icona Pop»,
# «Rock That Body» и перезаливки, 8 дизлайков подряд (откат f63fde2). Срез из
# _GENRE_SLICE артистов на порцию, по кругу из _GENRE_PARTS срезов.
_GENRE_ARTISTS = 24
_GENRE_SLICE = 6
_GENRE_PARTS = 4
_GENRE_HITS_PER_ARTIST = 2
_GENRE_TTL = 24 * 60 * 60
# Потолок доли жанрового источника в порции. Прод, 2026-10-14: в первые сутки
# хиты выбранного жанра заняли 29% видимой волны владельца при 0 хороших из 25
# исходов — популярные новинки выигрывали места новизны у всех источников.
# Потолок мягкий (flow_slate.compose_slate, flow_session.select): лишнее
# уходит в хвост, поэтому юзер, которому кроме жанра предложить нечего,
# по-прежнему получает полную порцию жанра.
_GENRE_SHARE = 0.25


def _genre_cap(limit: int) -> int:
    return max(1, round(limit * _GENRE_SHARE))


def _novel_cap(limit: int, ratio: float) -> int:
    """Потолок новых артистов в порции — та же доля, что и цель новизны.

    Прод, 2026-10-14: цель новизны была только полом, и новые добирались ещё и
    общим рейтингом — в порциях по 6 при цели 3 новых выходило 4–5, а
    знакомых и любимых артистов не хватало. Потолок мягкий: нечем заменить —
    новые остаются (compose_slate, flow_session.select).
    """
    if ratio > DEFAULT_DISCOVERY_RATIO:
        return discovery_slots(limit, ratio)
    return max(0, round(limit * ratio))


def _liked_cap(limit: int, ratio: float) -> int:
    """Потолок лайков в выдаче из готового пула — та же квота, что и в
    _compute_flow, но на ``limit`` выдачи, а не на весь пул."""
    discovery_target = (
        discovery_slots(limit, ratio) if ratio > DEFAULT_DISCOVERY_RATIO else 0
    )
    return min(liked_slots(limit, ratio), max(0, limit - discovery_target))
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
# Насколько лучший кандидат источника может отставать по score от лучшего
# вообще, чтобы сэмпл Томпсона мог отдать место этому источнику (см.
# discovery_feedback.thompson_source_order). Радио-хит артиста, который лишь
# мелькнул в коллекции (affinity на полу), отстаёт от любимых на 1.3–1.9.
_SOURCE_SCORE_GAP = 1.0
# Сколько треков одного артиста радио может дать за подгрузку. Радио YT Music
# у нишевого артиста — его же дискография: прод, 2026-10-19, один лайк
# «Качалки» Сереги Пирата → 16 его треков из радио в пуле из 30. Его каталог
# приходит отдельно (origin favorite), радио нужно ради других имён.
_RADIO_PER_ARTIST = 2
# Штраф в ранкере за каждое появление артиста среди последних _ARTIST_HISTORY
# отданных треков. Разнос выше меняет только ПОРЯДОК: отбор решает score, а у
# знакомых артистов близость (до 2.4) даёт ~2.3 против ~0.6 у новых, и в каждую
# подгрузку проходили одни и те же любимые имена (прод, 2026-09-30: Deep Purple
# 46 раз за сутки из ~1000 показов). Потолок держит любимого артиста в ротации,
# а не выкидывает его из волны.
_ARTIST_REPEAT_PENALTY = 0.3
_ARTIST_REPEAT_CAP = 1.2
# Штраф за повтор делится на 1 + sqrt(вес)/_ARTIST_REPEAT_WEIGHT_SCALE: одинаковый
# для всех, он выравнивал показы — Limp Bizkit (вес 269, 744 прослушивания)
# штрафовался за каждое появление так же, как Pixies (вес 0.5), и звучал реже
# (прод, 2026-10-14). С делителем у LB штраф ~0.06 за появление, у Pixies ~0.25.
_ARTIST_REPEAT_WEIGHT_SCALE = 4.0
# Вес сигнала вкуса (лайк/прослушивание/скип) экспоненциально затухает со
# временем вместо жёсткого окна «последние N записей» — иначе у активных
# пользователей (сотни прослушиваний за сессию) более ранний, но всё ещё
# любимый артист резко выпадает из профиля, стоит наиграть чуть больше
# истории поверх него. Полураспад веса — раз в столько дней сигнал слабеет
# вдвое; пределы выборки — просто защита от неограниченного запроса, не
# смысловая отсечка.
_TASTE_HALF_LIFE_DAYS = 14.0
_TASTE_QUERY_LIMIT = 300
# Сколько дней скипнутый трек не возвращается в волну. Окно по ВРЕМЕНИ, а не
# _TASTE_QUERY_LIMIT последних строк: фронт шлёт скип автоматически при <25%
# прослушивания, и активный слушатель набирает 300 скипов за сутки — трек
# выпадал из окна на следующий день и снова приходил в волну (до 30–50% показов
# волны были повторами уже скипнутого за последние трое суток).
_SKIP_EXCLUDE_DAYS = 60
# Сколько дней ПОКАЗАННЫЙ в волне трек не возвращается, чем бы ни кончился
# показ. Скип исключается выше на 60 дней, а прослушанное лишь последней
# сотней прослушиваний (_RECENT_PLAYS_EXCLUDE) — у активного слушателя это
# несколько часов. Прод, 2026-10-14: повторы — 28% видимой волны владельца,
# из 226 за 36 ч у 119 первый показ кончился на 25–55%, у 44 — без событий.
# Лайки сюда не входят: у них свой кулдаун (_LIKED_REPLAY_COOLDOWN_DAYS).
# Второй проход порции (relax) кулдаун не применяет — пустая волна хуже.
_SHOWN_COOLDOWN_DAYS = 3
# Штраф артисту за ЯВНЫЙ дизлайк трека: сильнее лайка (+3.0) и плейлиста
# (+4.0 — курирование всё же перевешивает один дизлайк), без затухания по
# времени. Осознанное «не нравится» должно убирать артиста из волны сразу,
# а не растворяться в весах через две недели.
_DISLIKE_ARTIST_PENALTY = 3.5
# Ниже этого веса скипы не опускают любимого артиста (без дизлайка): он
# остаётся знакомым и не попадает в banned_artists. Сродни весу одного
# импортированного трека недельной давности — в ротации, но не в голове.
_FAVORITE_SKIP_FLOOR = 0.5
# Артист, отвергнутый в волне: от _ARTIST_REJECT_MIN_BAD плохих песен за
# _SKIP_EXCLUDE_DAYS и плохих не меньше чем в _ARTIST_REJECT_BAD_PER_GOOD раз
# больше хороших (песни коллекции считаются хорошими). Штраф в artist_weight
# этого не ловил: он видит только последние _TASTE_QUERY_LIMIT скипов (у
# активного слушателя — сутки) и не видит скипов нематериализованных треков,
# а один лайк (+3.0) перевешивает два свежих скипа. Артист с одним
# понравившимся треком, остальные которого юзер скипает сразу, через день
# снова приходил в волну с каталогом. Мягкий бан: второй проход порции его
# снимает, лайкнутые треки артиста остаются в ротации лайков.
_ARTIST_REJECT_MIN_BAD = 3
_ARTIST_REJECT_BAD_PER_GOOD = 3
# Мягкий бан для второго прохода порции (см. _compute_flow, relax): артист
# остаётся в бане, только если вес ниже этого (скип одного трека даёт около
# -1.04, то есть это примерно три скипнутых трека), дизлайкнут или исключён.
# Прод, 2026-10-13: новому юзеру с узким вкусом каждый быстрый скип банил
# артиста целиком — 139 артистов в бане, порции по 0 треков, музыка вставала;
# без бана за одиночные скипы та же порция собиралась из 15 треков его жанра.
_RELAXED_BAN_WEIGHT = 2.5
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
# Сколько песен доказанного любимого из СВОЕЙ коллекции юзера его каталог
# предлагает ранкеру за подгрузку (см. _favorite_collection_candidates).
_FAVORITE_COLLECTION_PER_ARTIST = 3
# Ротация каталогов любимых артистов (см. _pick_favorite_artists). За подгрузку
# сеть тянет каталоги лишь ~15 имён, а коллекция бывает в сотни артистов.
# Раньше выбор решала позиция в списке коллекции — и волна крутила первые ~25
# имён: прод, 2026-10-01, у владельца 257 артистов, Sabaton (3-й по весу, 59-й
# в списке) из этого пула не пришёл ни разу. Взятое имя остывает по времени с
# таким «полураспадом» в часах; отметки живут в Redis неделю.
_FAVORITE_ROTATION_HOURS = 3.0
_FAVORITE_ROTATION_TTL = 7 * 24 * 60 * 60
# Шанс имени без накопленного сигнала (импорт, явное предпочтение без истории):
# ниже любого проверенного артиста, но не ноль — хвост коллекции тоже звучит.
_FAVORITE_ROTATION_FLOOR = 0.5
# Сколько понравившихся треков доходит до ранкера за подгрузку (см.
# _liked_candidates). Заметно больше квоты liked_slots: у ранкера должен быть
# выбор, какой именно лайк уместен сейчас по жанру, акустике и контексту, —
# иначе квота каждый раз заполнялась бы одними и теми же треками.
_LIKED_WINDOW = 24
# Потолок треков одного артиста в этом окне. Окно идёт от давно не звучавших,
# и у владельца его целиком занимали старые лайки Eminem — квота из трёх мест
# отдавала двух Eminem в каждой порции (прод, 2026-10-10).
_LIKED_WINDOW_PER_ARTIST = 2
# Сколько трек «остывает» после прослушивания или скипа, прежде чем квота
# лайков может отдать его снова. Именно время, а не recent_ids: тот держит
# последние 100 прослушиваний, то есть у юзера с короткой историей — вообще всё
# сыгранное, и ни один лайк сквозь него не проходил бы. 2 дня — выбор
# владельца продукта, 2026-10-10.
_LIKED_REPLAY_COOLDOWN_DAYS = 2
# Маленькой коллекции кулдаун растягивается (см. _liked_cooldown_days): квота
# берёт около лайка на шесть треков, и при 2 днях 4–11 лайков крутились по
# кругу — прод, 2026-10-15: у юзеров с 4 и 11 лайками каждый третий-второй
# показ лайка был повтором, good 0% / bad 90% (у владельца с 379 — 41% / 35%).
# _LIKED_ROTATION_TRACKS / размер коллекции дней, от 2 до 7: 50+ лайков — 2,
# 20 — 5, 14 и меньше — неделя. Недобранную квоту занимают обычные кандидаты.
_LIKED_ROTATION_TRACKS = 100
_LIKED_REPLAY_COOLDOWN_MAX_DAYS = 7
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
# Свежие позитивы — дослушанное до GOOD_COMPLETION или лайкнутое за последние
# _FRESH_SEED_DAYS. Сиды раньше брались только из коллекции с ротацией, и
# похожесть строилась вокруг давно импортированного, а не того, что юзер
# слушает сейчас. Из свежих берётся _FRESH_SEED_SHARE сидов каждого вида
# (Last.fm и radio); остальное по-прежнему ротация по коллекции.
_FRESH_SEED_DAYS = 14
_FRESH_SEED_LIMIT = 12
_FRESH_SEED_SHARE = 2
# Confidence bonus треку, который фоновый воркер выбрал сравнением артистов по
# косинусу (см. app/artist_probe.py). Выше, чем у соседа по графу (0.08), и
# выше точного каталога любимого артиста (0.12): за этим треком стоит
# измеренная близость к вектору вкуса, а не чужое утверждение о похожести. Но
# ниже явного лайка (0.15) — измерение всё-таки не подтверждение от юзера.
# Места в порции бонус не даёт: пик идёт в общий пул и конкурирует ранжированием.
_PROBE_BONUS = 0.14


def _artist_repeat_penalty(count: int, weight: Optional[float]) -> float:
    """Штраф за ``count`` появлений артиста в недавней выдаче: чем больше вес
    вкуса, тем мягче — доля артиста в волне растёт с тем, как его слушают."""
    if not count:
        return 0.0
    scale = 1.0 + math.sqrt(max(weight or 0.0, 0.0)) / _ARTIST_REPEAT_WEIGHT_SCALE
    return _ARTIST_REPEAT_PENALTY * count / scale


def _artist_affinity(artist: str, weights: dict) -> Optional[float]:
    """Вес вкуса строки артиста; None — артист незнакомый.

    Коллаб «A, B» / «A feat. B» знаком, если знаком хоть один участник, и
    берёт вес лучшего из них. Прод, 2026-10-14: по полной строке «Dynoro, Gigi
    D'Agostino» шёл как новый артист — таких 337 «новых» за 14 дней с good 12%
    / bad 47% (лучше знакомых), а цель новизны заполнялась знакомыми именами.
    """
    full = artist_key(artist)
    if full in weights:
        return weights[full]
    best = None
    for key in artist_part_keys(artist):
        if key in weights and (best is None or weights[key] > best):
            best = weights[key]
    return best


def _decay(ts, half_life_days: float = _TASTE_HALF_LIFE_DAYS) -> float:
    """Экспоненциальное затухание веса по возрасту записи (в долях от 1.0)."""
    if ts is None:
        return 1.0
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    age_days = max(0.0, (datetime.now(timezone.utc) - ts).total_seconds() / 86400)
    return 0.5 ** (age_days / half_life_days)


def _as_aware(ts) -> datetime:
    """Метка времени в UTC; None — эпоха (старее любого окна)."""
    if ts is None:
        return datetime(1970, 1, 1, tzinfo=timezone.utc)
    return ts.replace(tzinfo=timezone.utc) if ts.tzinfo is None else ts


def _mix_fresh_seeds(fresh, rest, total: int, context: str, salt: str) -> list:
    """До _FRESH_SEED_SHARE свежих сидов, остальное — ротация по ``rest``.

    Обе части ротируются контекстным хэшем, как и раньше: каждая подгрузка
    ходит к своим сидам, а не к одному самому свежему.
    """
    def rotated(values):
        return sorted(
            values,
            key=lambda value: stable_jitter(context, f"{salt}:{value}"),
            reverse=True,
        )

    picked = rotated(list(dict.fromkeys(fresh)))[: min(_FRESH_SEED_SHARE, total)]
    for value in rotated(list(dict.fromkeys(rest))):
        if len(picked) >= total:
            break
        if value not in picked:
            picked.append(value)
    return picked


@functools.lru_cache(maxsize=32768)
def _norm_text(s: str) -> str:
    # Чистая функция строки: на одном запросе flow _norm_key зовётся ~16 тысяч
    # раз по нескольким тысячам уникальных строк.
    s = clean_title(s or "").lower()
    s = re.sub(r"\bfeat\.?\b.*$", "", s)
    s = re.sub(r"[^\w\s]", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _norm_key(artist: str, title: str) -> tuple:
    """Нормализованный ключ (артист, название) для дедупа между источниками."""
    return (_norm_text(artist), _norm_text(title))


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
        # Исход на юзера, а не «есть ли хоть одно позитивное событие»: listen
        # приходит и после скипа, и прежний подсчёт делал почти каждого
        # скипнувшего ещё и «позитивным» (см. app.feedback_labels).
        trackers: dict[tuple[str, int], OutcomeTracker] = {}
        for source, external_id, user, event_type, value in local_db.execute(
            select(
                recommendation_events.c.source,
                recommendation_events.c.external_id,
                recommendation_events.c.user_id,
                recommendation_events.c.event_type,
                recommendation_events.c.value,
            ).where(
                recommendation_events.c.surface == "flow",
                recommendation_events.c.occurred_at >= since,
                recommendation_events.c.event_type.in_(FEEDBACK_EVENT_TYPES),
                tuple_(
                    recommendation_events.c.source,
                    recommendation_events.c.external_id,
                ).in_(identities),
            ).order_by(recommendation_events.c.occurred_at, recommendation_events.c.id)
        ).all():
            trackers.setdefault(
                (f"{source}:{external_id}", user), OutcomeTracker()
            ).add(event_type, value)
        for (identity, _user), tracker in trackers.items():
            row = stats.get(identity)
            if row is None:
                continue
            if tracker.good:
                row["positive_users"] += 1
            elif tracker.bad:
                row["negative_users"] += 1
        for row in stats.values():
            row["quality"] = population_quality_score(
                row["positive_users"], row["negative_users"]
            )
        return stats
    finally:
        local_db.close()


def _collection_rows(db: Session, user_id: int) -> list:
    """Вся коллекция юзера (лайки и свои плейлисты) строками для ключей песен."""
    return (
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


def collection_song_counts(collection_rows) -> dict[str, int]:
    """{primary_artist_key: разных песен в коллекции}; один трек в двух
    плейлистах — одна песня."""
    songs_by_artist: dict[str, set] = {}
    for _track_id, artist, title, source, _external_id, album in collection_rows:
        effective_artist, effective_title = effective_artist_title(
            title or "",
            artist or "",
            source=source or "",
            album=album or "",
        )
        key = _norm_key(effective_artist, effective_title)
        if all(key):
            songs_by_artist.setdefault(primary_artist_key(effective_artist), set()).add(key)
    return {artist: len(songs) for artist, songs in songs_by_artist.items()}


def deep_catalog_artist_keys(collection_rows, excluded=(), preferred=()) -> List[str]:
    """Любимые артисты: от _DEEP_CATALOG_MIN_TRACKS разных песен в коллекции.

    Им волна и лента отдают глубокий каталог, остальным — только хиты
    (app/mainstream.py). Считаются разные песни, а не строки: один трек в двух
    плейлистах — это один выбор. ``collection_rows`` — из ``_collection_rows``.

    ``preferred`` — имена из User.preferred_artists: явный выбор в настройках
    любимым считается сразу, без порога. Иначе андерграунд-артист, выбранный
    вручную, но не набравший пяти песен и 50k слушателей Last.fm, терял в
    мейнстрим-фильтре ВСЕ свои треки (прод, 2026-10-10: первый по весу артист
    профиля не попал в волну ни разу).
    """
    excluded = set(excluded)
    deep = {
        artist
        for artist, songs in collection_song_counts(collection_rows).items()
        if artist and songs >= _DEEP_CATALOG_MIN_TRACKS
    }
    deep.update(primary_artist_key(name) for name in preferred)
    return sorted(artist for artist in deep if artist and artist not in excluded)


def flow_rejected_artist_keys(event_rows, collection_counts=None) -> set:
    """Артисты, чьи песни в волне юзер раз за разом отвергает.

    ``event_rows`` — (event_type, value, artist, title, source) событий волны
    в порядке времени; исход размечается по песне (app.feedback_labels), так
    что повторные показы одной песни и её локальная/внешняя копии — один
    голос. Коллабы не считаются: по строке «A, B» не понять, кого отвергли.
    ``collection_counts`` — {artist_key: песен в коллекции}, это хорошие.
    """
    by_song: dict[tuple, OutcomeTracker] = {}
    for event_type, value, artist, title, source in event_rows:
        if not artist or not title:
            continue
        effective_artist, effective_title = effective_artist_title(
            title, artist, source=source or ""
        )
        if len(artist_part_keys(effective_artist)) != 1:
            continue
        song = _norm_key(effective_artist, effective_title)
        if not all(song):
            continue
        by_song.setdefault(
            (artist_key(effective_artist), song), OutcomeTracker()
        ).add(event_type, value)
    good: Counter = Counter(collection_counts or {})
    bad: Counter = Counter()
    for (key, _song), state in by_song.items():
        if state.good:
            good[key] += 1
        elif state.bad:
            bad[key] += 1
    return {
        key
        for key, n_bad in bad.items()
        if key
        and n_bad >= _ARTIST_REJECT_MIN_BAD
        and n_bad >= _ARTIST_REJECT_BAD_PER_GOOD * good[key]
    }


def fresh_collection_artist_keys(db: Session, user_id: int, now=None) -> List[str]:
    """Артисты, чья первая песня в коллекции добавлена за _FRESH_CLUSTER_DAYS.

    Пусто, если свежая вся коллекция: у нового юзера нет долгосрочного ядра,
    которое потолок _FRESH_CLUSTER_SHARE должен защищать.
    """
    rows = (
        db.query(
            Track.artist,
            Track.title,
            Track.source,
            Track.album,
            func.min(playlist_tracks.c.added_at).label("added_at"),
        )
        .join(playlist_tracks, playlist_tracks.c.track_id == Track.id)
        .join(Playlist, Playlist.id == playlist_tracks.c.playlist_id)
        .filter(Playlist.owner_id == user_id)
        .group_by(Track.id)
        .all()
    )
    first_added: dict[str, datetime] = {}
    for artist, title, source, album, added_at in rows:
        if added_at is None:
            continue
        if added_at.tzinfo is None:
            added_at = added_at.replace(tzinfo=timezone.utc)
        effective_artist, _effective_title = effective_artist_title(
            title or "",
            artist or "",
            source=source or "",
            album=album or "",
        )
        key = primary_artist_key(effective_artist)
        if key and (key not in first_added or added_at < first_added[key]):
            first_added[key] = added_at
    since = (now or datetime.now(timezone.utc)) - timedelta(days=_FRESH_CLUSTER_DAYS)
    fresh = sorted(key for key, added_at in first_added.items() if added_at >= since)
    if len(fresh) == len(first_added):
        return []
    return fresh


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
    collection_rows = _collection_rows(db, user_id)
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
    fresh_since = datetime.now(timezone.utc) - timedelta(days=_FRESH_SEED_DAYS)
    fresh_played = (
        db.query(Track, func.max(user_play_events.c.played_at).label("played_at"))
        .join(user_play_events, user_play_events.c.track_id == Track.id)
        .filter(
            user_play_events.c.user_id == user_id,
            user_play_events.c.completion >= GOOD_COMPLETION,
            user_play_events.c.played_at >= fresh_since,
        )
        .group_by(Track.id)
        .order_by(desc("played_at"))
        .limit(_FRESH_SEED_LIMIT * 3)
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
    seed_artist: dict = {}  # video_id сида -> ключ артиста, для фильтра banned
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
            seed_artist[track.external_id] = key

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
            seed_artist[track.external_id] = key
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
            seed_artist[track.external_id] = key

    # Штраф за скипы: сам трек исключаем из волны совсем, артисту снижаем вес
    # (задолбавший артист вылетает из топа, а сид от его трека не выбирается).
    skipped_ids: set = set()
    skipped_keys: set = set()
    skipped_video_ids: set = set()
    disliked_artist_keys: set = set()
    for track, skip_count, last_skipped, disliked in skipped:
        effective_artist, effective_title = effective_track_artist_title(track)
        skipped_ids.add(track.id)
        skipped_keys.add(_norm_key(effective_artist, effective_title))
        if track.external_id:
            skipped_video_ids.add(track.external_id)
        key = artist_key(effective_artist)
        if disliked:
            disliked_artist_keys.add(key)
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

    # Окно выше решает только штраф артисту. Сам трек исключаем по всем скипам
    # за _SKIP_EXCLUDE_DAYS: иначе скип, вытесненный из окна свежими, через
    # сутки снова пускал трек в волну. Лёгкие колонки, без ORM-объектов —
    # строк здесь тысячи.
    skip_cutoff = datetime.now(timezone.utc) - timedelta(days=_SKIP_EXCLUDE_DAYS)
    older_skip_rows = (
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
            user_track_skips.c.last_skipped >= skip_cutoff,
        )
        .all()
    )
    for track_id, artist, title, source, external_id, album in older_skip_rows:
        if track_id in skipped_ids:
            continue
        old_artist, old_title = effective_artist_title(
            title or "",
            artist or "",
            source=source or "",
            album=album or "",
        )
        skipped_ids.add(track_id)
        key = _norm_key(old_artist, old_title)
        if all(key):
            skipped_keys.add(key)
        if external_id:
            skipped_video_ids.add(external_id)

    # A fast external skip is recorded before materialisation.  The durable
    # telemetry identity must therefore exclude the provider item directly;
    # otherwise a failed/slow import loses the user's strongest negative signal.
    # Same time window as above, not the last _TASTE_QUERY_LIMIT events.
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
            recommendation_events.c.occurred_at >= skip_cutoff,
        ).distinct()
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

    # Исходы волны за то же окно — для flow_rejected_artist_keys ниже.
    flow_outcome_rows = db.execute(
        select(
            recommendation_events.c.event_type,
            recommendation_events.c.value,
            recommendation_events.c.artist,
            recommendation_events.c.title,
            recommendation_events.c.source,
        ).where(
            recommendation_events.c.user_id == user_id,
            recommendation_events.c.surface == "flow",
            recommendation_events.c.event_type.in_(FEEDBACK_EVENT_TYPES),
            recommendation_events.c.occurred_at >= skip_cutoff,
        ).order_by(recommendation_events.c.occurred_at, recommendation_events.c.id)
    ).all()

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

    # Явные жанры — с частотой под долю EXPLICIT_GENRE_SHARE от набранной
    # истории (вес в genre_counts), плюс отдельно в профиль: ключевые слова
    # подбора берут их сверх тройки частых (см. top_genre_keywords).
    genres.extend(weighted_explicit_genres(pref_genres, len(genres)))

    # Сиды-радио от треков любимых артистов, уже присутствующих в
    # каталоге как ytmusic (усиливает «холодный старт»: радио строится
    # вокруг выбора юзера, а не глобального топа).
    if pref_artists:
        pref_keys = [k for k in (artist_key(n) for n in pref_artists) if k]
        if pref_keys:
            pref_seed_rows = (
                db.query(Track.external_id, Track.artist)
                .filter(
                    Track.source == "ytmusic",
                    Track.external_id.isnot(None),
                    func.lower(Track.artist).in_(pref_keys),
                )
                .order_by(desc(Track.play_count))
                .limit(20)
                .all()
            )
            for vid, seed_artist_name in pref_seed_rows:
                if vid and vid not in seen_seed and vid not in skipped_video_ids:
                    seeds.append(vid)
                    seen_seed.add(vid)
                    seed_artist[vid] = artist_key(seed_artist_name)

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

    # Показанное в волне за _SHOWN_COOLDOWN_DAYS — по id и по песне.
    shown_cutoff = datetime.now(timezone.utc) - timedelta(days=_SHOWN_COOLDOWN_DAYS)
    shown_rows = db.execute(
        select(
            recommendation_impressions.c.track_id,
            recommendation_impressions.c.source,
            recommendation_impressions.c.external_id,
            recommendation_impressions.c.artist,
            recommendation_impressions.c.title,
        )
        .where(
            recommendation_impressions.c.user_id == user_id,
            recommendation_impressions.c.surface == "flow",
            recommendation_impressions.c.visible.is_(True),
            recommendation_impressions.c.shown_at >= shown_cutoff,
        )
        .distinct()
    ).all()
    shown_ids, shown_external_ids, shown_keys = set(), set(), set()
    for track_id, source, external_id, artist, title in shown_rows:
        if track_id:
            shown_ids.add(track_id)
        if source and external_id:
            shown_external_ids.add(f"{source}:{external_id}")
        key = _norm_key(artist or "", title or "")
        if all(key):
            shown_keys.add(key)

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
    # Любимого артиста (см. deep_catalog_artist_keys) скипы не уводят в минус —
    # это делает только явный дизлайк. Вес коллекции затухает как событие
    # (импорт двухмесячной давности — 6% от исходного), а свежий скип штрафует
    # в полную силу: прод, 2026-10-10, два быстрых скипа CUPSIZE посреди серии
    # из ~100 скипов мусорной волны перевесили 9 его треков в плейлисте, и
    # артист ушёл в banned_artists — пропал из волны целиком. Скипы по-прежнему
    # снижают вес (ротация) и исключают сами треки.
    deep_keys = deep_catalog_artist_keys(collection_rows, excluded_artists, pref_artists)
    for key in deep_keys:
        if key not in disliked_artist_keys and artist_weight.get(key, 0.0) < _FAVORITE_SKIP_FLOOR:
            artist_weight[key] = _FAVORITE_SKIP_FLOOR
            artist_display.setdefault(key, key)
    # Любимых (deep catalog и выбранных в настройках) защищает пол выше.
    flow_rejected_artists = flow_rejected_artist_keys(
        flow_outcome_rows, collection_song_counts(collection_rows)
    ) - set(deep_keys)

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
    banned_artists |= excluded_artists | flow_rejected_artists
    hard_banned_artists = {
        a for a, w in artist_weight.items() if w <= -_RELAXED_BAN_WEIGHT
    } | disliked_artist_keys | excluded_artists
    for key in excluded_artists:
        artist_weight.pop(key, None)
        artist_display.pop(key, None)
        curated_artist_keys[:] = [a for a in curated_artist_keys if a != key]
        catalog_artist_keys[:] = [a for a in catalog_artist_keys if a != key]
        playlist_artist_keys[:] = [a for a in playlist_artist_keys if a != key]
    catalog_artist_keys[:] = [a for a in catalog_artist_keys if a not in flow_rejected_artists]
    topartist_keys = [
        key for key in topartist_keys
        if key not in excluded_artists and key not in flow_rejected_artists
    ]
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
    # Радио от трека артиста, ушедшего в banned, — это тот же артист и его
    # окружение, которых юзер отверг. Прод, 2026-10-10: Oxxxymiron стоял в
    # preferred_artists, но был в бане от трёх дизлайков, а его треки всё
    # равно были сидами — радио приносило Шнурова с Кипеловым, Триаду, ГРОТ.
    seeds = [s for s in seeds if seed_artist.get(s) not in banned_artists]
    playlist_seeds = [
        s for s in playlist_seeds if seed_artist.get(s) not in banned_artists
    ]

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

    # Свежие позитивы — только артистов с положительным весом в профиле.
    # Дослушанный трек незнакомого артиста ещё не доказывает вкус, а радио от
    # него — тот самый жанровый дрейф, от которого сиды и держат в профиле
    # (см. выбор сидов в get_flow). Свой проход дедупа: свежий лайк должен
    # остаться и в сидах коллекции, пересечение снимает _mix_fresh_seeds.
    fresh_rows = [
        (track, ts)
        for track, ts in sorted(
            [
                *((t, a) for t, a in liked if _as_aware(a) >= fresh_since),
                *fresh_played,
            ],
            key=lambda row: _as_aware(row[1]),
            reverse=True,
        )
        if artist_weight.get(artist_key(effective_track_artist_title(track)[0]), 0) > 0
    ]
    seen_seed_track.clear()
    fresh_seed_tracks = _seed_pairs(fresh_rows)[:_FRESH_SEED_LIMIT]
    fresh_seeds = list(
        dict.fromkeys(
            track.external_id
            for track, _ts in fresh_rows
            if track.source == "ytmusic"
            and track.external_id
            and track.external_id not in skipped_video_ids
        )
    )[:_FRESH_SEED_LIMIT]

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
        "fresh_seed_tracks": fresh_seed_tracks,
        "fresh_seeds": fresh_seeds,
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
        # Любимые — им можно давать глубокий каталог, остальным только хиты
        # (см. app/mainstream.py). Считаются разные песни, а не строки: один
        # трек в двух плейлистах — это один выбор.
        "deep_catalog_artist_keys": deep_keys,
        "collection_song_counts": collection_song_counts(collection_rows),
        "fresh_cluster_artist_keys": fresh_collection_artist_keys(db, user_id),
        "curated_artist_keys": curated_artist_keys,
        "catalog_artists":[artist_display.get(k, k) for k in catalog_artist_keys],
        "genres": list(dict.fromkeys(genres)),
        "genre_counts": dict(Counter(genres)),
        "explicit_genres": pref_genres,
        "title_tags": list(build_title_tag_profile(weighted_titles).keys()),
        "banned_artists": banned_artists,
        # Бан второго прохода, когда обычный не набрал порцию (_compute_flow).
        "hard_banned_artists": hard_banned_artists,
        # Часть banned_artists, которую ротация лайков не исключает: только
        # отвергнутые в волне, не ушедшие в минус по весу и не исключённые.
        "flow_rejected_artists": flow_rejected_artists - {
            a for a, w in artist_weight.items() if w < 0
        } - excluded_artists - disliked_artist_keys,
        "prefer_cyrillic": dominant_is_cyrillic(lang_texts),
        # (доля кириллицы, сколько текстов) — априор языка в волне
        # (discovery_feedback.language_terms).
        "cyrillic_share": cyrillic_share(lang_texts),
        "recent_ids": recent_ids,
        # Отдельно от recent_ids: тот склеивает скипы с «последними 100
        # прослушиваниями». Квота лайков не применяет ни то, ни другое — скип
        # лайка только сдвигает его кулдаун (см. _liked_candidates).
        "skipped_ids": skipped_ids,
        "recent_keys": recent_keys,
        "recent_video_ids": recent_video_ids,
        "skipped_external_ids": skipped_external_ids,
        "shown_ids": shown_ids,
        "shown_external_ids": shown_external_ids,
        "shown_keys": shown_keys,
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
        kw_conditions = build_keyword_filters(
            Track.title,
            profile.get("genre_counts", {}),
            explicit=profile.get("explicit_genres") or (),
        )
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
        top_genre_keywords(
            profile.get("genre_counts", {}),
            explicit=profile.get("explicit_genres") or (),
        ),
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

    # Акустической ветки здесь больше нет. Она пускала любого артиста общего
    # каталога с близким вектором, а порог 0.55 проходят ~90% треков с
    # признаками — признаки же есть только у закэшированного в хранилище, то
    # есть у того, что слушали ДРУГИЕ юзеры. Прод, 2026-10-10: у юзера с
    # импортом андерграунд-рэпа 2340 из 2473 локальных кандидатов были такими
    # чужими (Metallica, Taylor Swift, ДДТ), и они заняли всю волну; по
    # телеметрии новые артисты этой ветки — good 0.9% / bad 88%. Новые имена —
    # работа разведки (см. модульный docstring), а не локального пула.
    candidates = list(candidates_by_id.values())
    candidates.sort(key=_score)

    return candidates


def _touched_seconds(moment) -> float:
    """Когда трек играли или скипали — числом; никогда — минус бесконечность.

    Числом, а не самим datetime: время приходит из БД то наивным, то с
    таймзоной, и сортировка смешанного списка падала бы на сравнении aware с
    naive. Наивное считаем UTC — та же конвенция, что в _decay.
    """
    if moment is None:
        return float("-inf")
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.timestamp()


def _liked_cooldown_days(liked_count: int) -> float:
    """Сколько дней лайк остывает после прослушивания или скипа при
    коллекции из ``liked_count`` лайков (см. _LIKED_ROTATION_TRACKS)."""
    if liked_count <= 0:
        return _LIKED_REPLAY_COOLDOWN_DAYS
    return min(
        _LIKED_REPLAY_COOLDOWN_MAX_DAYS,
        max(_LIKED_REPLAY_COOLDOWN_DAYS, _LIKED_ROTATION_TRACKS / liked_count),
    )


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
    применимы, — дизлайки, очередь фронта, забаненные артисты и кулдаун
    ``_liked_cooldown_days`` после прослушивания или скипа.

    Скип лайка — «не сейчас», а не «никогда», поэтому ``skipped_ids`` (все
    скипы за ``_SKIP_EXCLUDE_DAYS``) здесь не применяется. Прод, 2026-10-10:
    владелец скипает сотни треков в день, и это исключение отсекало 282 лайка
    из 300 — квота с 8 октября отдавала ноль, хотя лайки лучший источник волны.

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
    exclude_ids = extra_exclude_ids or set()
    wanted = [track_id for track_id in liked_ids if track_id not in exclude_ids]
    if not wanted:
        return []
    rows = (
        db.query(
            Track,
            user_track_plays.c.last_played,
            user_track_skips.c.last_skipped,
            user_track_skips.c.disliked,
        )
        .outerjoin(
            user_track_plays,
            and_(
                user_track_plays.c.track_id == Track.id,
                user_track_plays.c.user_id == profile["user_id"],
            ),
        )
        .outerjoin(
            user_track_skips,
            and_(
                user_track_skips.c.track_id == Track.id,
                user_track_skips.c.user_id == profile["user_id"],
            ),
        )
        .filter(Track.id.in_(wanted))
        .all()
    )

    cooldown_before = (
        datetime.now(timezone.utc)
        - timedelta(days=_liked_cooldown_days(len(liked_ids)))
    ).timestamp()
    # Отвергнутый в волне артист теряет каталог, но не лайкнутые треки.
    banned = set(profile["banned_artists"]) - set(profile.get("flow_rejected_artists") or ())
    ordered: List[tuple] = []
    for track, last_played, last_skipped, disliked in rows:
        if disliked:
            continue
        effective_artist, _effective_title = effective_track_artist_title(track)
        if banned and artist_key(effective_artist) in banned:
            continue
        if not _media_available(track):
            continue
        touched_at = max(_touched_seconds(last_played), _touched_seconds(last_skipped))
        if touched_at > cooldown_before:
            continue
        ordered.append(
            (
                touched_at,
                stable_jitter(profile["user_id"], f"liked:{track.id}"),
                track.id,
                track,
            )
        )
    ordered.sort(key=lambda row: row[:3])
    window = max(limit, _LIKED_WINDOW)
    picked: List[Track] = []
    overflow: List[Track] = []
    per_artist: Counter = Counter()
    for row in ordered:
        track = row[3]
        key = primary_artist_key(effective_track_artist_title(track)[0])
        if per_artist[key] >= _LIKED_WINDOW_PER_ARTIST:
            overflow.append(track)
            continue
        per_artist[key] += 1
        picked.append(track)
        if len(picked) >= window:
            break
    # Лайков мало артистов — окно добирается их же треками: потолок про
    # разнообразие, а не про то, чтобы оставить ранкер без выбора.
    return (picked + overflow)[:window]


def _favorite_collection_candidates(
    db: Session,
    profile: dict,
    favorite_ranks: dict,
    context: str,
    exclude_ids: Optional[set] = None,
) -> List[Track]:
    """Песни доказанных любимых артистов из СВОЕЙ коллекции юзера (блокирующая).

    ``favorite_ranks`` — {артист: нормализованные названия его каталога по
    популярности на площадке} для доказанных любимых, чьи каталоги тянет эта
    подгрузка. Провайдерская выдача коллекцию исключает, и у артиста, собранного
    целиком, выбор любимого оставался пустым (прод, 2026-10-14: все 40 треков
    Limp Bizkit на YT Music лежали в коллекции владельца — из 192 отдач LB за
    4 дня от его каталога ни одной, только radio и local глубиной каталога).
    Здесь — его песни строками коллекции, хиты чаще (место в каталоге площадки,
    _rank_weighted_shuffle), не больше ``_FAVORITE_COLLECTION_PER_ARTIST``.

    Отсекаются дизлайк (любой копии песни) и бан артиста. Повторы держит
    только кулдаун показанного в волне — его и provider id очереди сверяет
    вызывающий. Прослушивание вне волны (поиск, альбом) песню не остужает:
    правило владельца, 2026-10-14 — сам слушал хиты, а волна их неделю прятала.
    """
    names = [artist for artist in favorite_ranks if artist_key(artist)]
    if not names:
        return []
    exclude_ids = exclude_ids or set()
    rows = (
        db.query(Track, user_track_skips.c.disliked)
        .join(playlist_tracks, playlist_tracks.c.track_id == Track.id)
        .join(Playlist, Playlist.id == playlist_tracks.c.playlist_id)
        .outerjoin(
            user_track_skips,
            and_(
                user_track_skips.c.track_id == Track.id,
                user_track_skips.c.user_id == profile["user_id"],
            ),
        )
        .filter(Playlist.owner_id == profile["user_id"])
        # SoundCloud-строки бывают с uploader в Track.artist — их артиста
        # сверяем ниже по эффективному имени.
        .filter(
            or_(
                *(
                    func.lower(Track.artist).contains(name.lower(), autoescape=True)
                    for name in names
                ),
                Track.source == "soundcloud",
            )
        )
        .all()
    )
    # Одна песня бывает несколькими строками (два плейлиста, копии с разных
    # площадок): дизлайк любой копии — на всю песню.
    songs: dict = {}
    for track, disliked in rows:
        effective_artist, effective_title = effective_track_artist_title(track)
        owner = next((name for name in names if names_whole_artist(name, effective_artist)), None)
        if owner is None:
            continue
        song = songs.setdefault(
            (owner, _norm_text(effective_title)),
            {"tracks": {}, "blocked": False},
        )
        song["tracks"][track.id] = track
        song["blocked"] |= bool(disliked) or track.id in exclude_ids or bool(
            profile["banned_artists"]
            and artist_key(effective_artist) in profile["banned_artists"]
        )
    by_artist: dict = {}
    for (owner, title), song in songs.items():
        if song["blocked"]:
            continue
        track = next((t for t in song["tracks"].values() if _media_available(t)), None)
        if track is not None:
            by_artist.setdefault(owner, []).append((title, track))
    picked: List[Track] = []
    for owner, items in by_artist.items():
        ranks = favorite_ranks.get(owner) or []
        place = {title: index for index, title in enumerate(ranks)}
        items.sort(
            key=lambda pair: (
                place.get(pair[0], len(ranks)),
                -_service_play_count(pair[1]),
                pair[1].id,
            )
        )
        picked += _rank_weighted_shuffle(
            [track for _title, track in items],
            context,
            f"favorite-collection:{artist_key(owner)}",
            lambda track: track.id,
        )[:_FAVORITE_COLLECTION_PER_ARTIST]
    return picked


def _familiar_candidates_on_bind(
    bind,
    profile: dict,
    limit: int,
    extra_exclude_ids: Optional[set] = None,
    liked_exclude_ids: Optional[set] = None,
    liked_limit: Optional[int] = None,
    favorite_ranks: Optional[dict] = None,
    context: str = "",
) -> tuple[List[Track], List[Track], List[Track]]:
    """Каталог, понравившееся и песни любимых из коллекции одной короткой
    сессией: (local, liked, favorite).

    Выборки блокирующие и нужны в один момент, поэтому они делят одну
    сессию и один поток — второй Session ради второго запроса брал бы из пула
    лишнее соединение на то же самое время. Песни любимых
    (_favorite_collection_candidates) исключают, как и лайки, только очередь.

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
            _favorite_collection_candidates(
                local_db, profile, favorite_ranks or {}, context, liked_exclude_ids
            ),
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
    # Single-flight, как у остальных пулов: прогрев следующей порции
    # (flow-warmer) и живой запрос часто просят один и тот же сид.
    return await _pool_single_flight(key, lambda: _radio_pool_fetch(seed_video_id))


async def _radio_pool_fetch(seed_video_id: str) -> List[ExternalTrackResponse]:
    """Сетевая часть _radio_pool — без проверки кэша, под single-flight."""
    key = f"flow:radio:{seed_video_id}"
    try:
        raw = await asyncio.to_thread(_fetch_radio, seed_video_id)
    except requests.exceptions.Timeout:
        # Таймаут — это медленный YouTube, а не сид без радио: в негативный
        # кэш не кладём, иначе сид выпал бы из потока на 10 минут.
        logger.warning("flow radio timed out for seed %s", seed_video_id)
        return []
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
        ytdlp.search_ytmusic(request, query, limit=3, schedule_matches=False),
        soundcloud.search_soundcloud(request, query, limit=3),
        return_exceptions=True,
    )
    # Поиск по имени песни охотно ставит ремикс выше оригинала, а _is_same_track
    # его пропускает («Song» входит в «Song (X Remix)»). Производную версию
    # берём, только если Last.fm назвал именно её.
    want_derivative = is_derivative_title(title)
    for results in (yt_results, sc_results):
        if isinstance(results, Exception):
            logger.warning("flow lastfm resolve failed for %s: %s", query, results)
            continue
        for found in results:
            if not want_derivative and is_derivative_title(found.title):
                continue
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
    if task is None and _pool_cache_only.get():
        # Живой запрос под нагрузкой: сеть не трогаем вовсе. Пул прогреет
        # flow-warmer, когда будет считать следующую порцию этого юзера.
        empty = asyncio.get_running_loop().create_future()
        empty.set_result([])
        return empty
    if task is None:
        task = asyncio.ensure_future(factory())
        _inflight_pools[key] = task
        task.add_done_callback(lambda _t, k=key: _inflight_pools.pop(k, None))
    return task


# Общий бюджет сетевой разведки одного запроса /flow. Раньше этапы (каталоги +
# радио + Last.fm → граф артистов → SoundCloud → теги) шли без дедлайна, а у
# ytmusicapi таймаута нет вовсе: один зависший провайдер держал клик по
# «потоку» столько, сколько висел сам. По истечении бюджета ранжируем то, что
# успело прийти; недождавшиеся пулы доделываются в фоне и кладут результат в
# Redis — следующая порция получит их из кэша.
_FLOW_NETWORK_BUDGET = 2.5
# Этап, начатый уже после бюджета, всё равно получает короткое окно: пулы из
# Redis отвечают за миллисекунды, отбрасывать их вместе с холодными незачем.
_FLOW_STAGE_GRACE = 0.3
# Сильные ссылки на недождавшиеся задачи: event loop держит только слабые, и
# без этого фоновый прогрев кэша мог бы собрать GC посреди работы.
_background_pools: set = set()


def _forget_background_pool(task: asyncio.Future) -> None:
    _background_pools.discard(task)
    if not task.cancelled() and task.exception() is not None:
        logger.warning("flow background pool failed: %r", task.exception())


async def _gather_within(aws, deadline: float) -> list:
    """Как asyncio.gather, но не дольше deadline (loop.time()).

    Результаты в порядке aws; не успевший или упавший пул — пустой список.
    Недождавшиеся задачи НЕ отменяются: они дорабатывают в фоне и греют кэш.
    """
    tasks = [asyncio.ensure_future(aw) for aw in aws]
    if not tasks:
        return []
    remaining = max(deadline - asyncio.get_running_loop().time(), _FLOW_STAGE_GRACE)
    await asyncio.wait(tasks, timeout=remaining)
    results = []
    for task in tasks:
        if not task.done():
            _background_pools.add(task)
            task.add_done_callback(_forget_background_pool)
            results.append([])
        elif task.cancelled() or task.exception() is not None:
            if not task.cancelled():
                logger.warning("flow pool failed: %r", task.exception())
            results.append([])
        else:
            results.append(task.result())
    late = sum(1 for task in tasks if not task.done())
    if late:
        logger.info("flow network budget: %d/%d pools left to background", late, len(tasks))
    return results


# Среди скольких первых треков порции ищем тот, что стартует без резолва.
# Небольшое окно: перестановка не должна заметно ломать порядок ранжирования
# и разнос артистов, это только выбор «открывающего» трека.
_INSTANT_START_WINDOW = 5
# Потолок на проверку своих копий: она идёт из Redis (miss — один запрос в
# MinIO), но клик по потоку не должен ждать её дольше этого ни при каком раскладе.
_INSTANT_START_TIMEOUT = 0.3


async def _starts_instantly(item: dict) -> bool:
    """Играется без внешнего резолва: локальный файл или своя копия ytmusic-трека."""
    source = item.get("source")
    if source == "local":
        return True
    external_id = item.get("external_id")
    if source == "ytmusic" and external_id:
        return await ytdlp._has_local_copy(external_id)
    return False


async def _front_instant_start(mix: List[dict]) -> List[dict]:
    """Ставит первым трек, который начнёт играть сразу.

    Холодный ytmusic-трек на старте — это резолв yt-dlp и медленный выход до
    YouTube, то есть секунды тишины после клика по «потоку». Если в начале
    порции есть трек с локальной/архивной копией, открываем им; остальной
    порядок не трогаем.
    """
    if not mix:
        return mix
    window = mix[:_INSTANT_START_WINDOW]
    try:
        flags = await asyncio.wait_for(
            asyncio.gather(*(_starts_instantly(item) for item in window)),
            _INSTANT_START_TIMEOUT,
        )
    except Exception:  # noqa: BLE001 — таймаут/сбой хранилища: порядок как есть
        logger.info("flow instant start check skipped", exc_info=True)
        return mix
    if flags[0] or not any(flags):
        return mix
    index = flags.index(True)
    return [mix[index], *mix[:index], *mix[index + 1:]]


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


async def _similar_hits_pool(request: Request, artist: str) -> List[ExternalTrackResponse]:
    """Хиты известных соседей артиста по Last.fm, уже играбельные, с кэшем."""
    key = f"flow:similar_hits:v1:{artist_key(artist)}"
    cached = await get_cache_async(key)
    if cached is not None:
        return [ExternalTrackResponse(**t) for t in cached]
    return await _pool_single_flight(
        key, lambda: _similar_hits_pool_fetch(request, artist, key)
    )


async def _similar_hits_pool_fetch(
    request: Request, artist: str, key: str
) -> List[ExternalTrackResponse]:
    names = [
        name
        for name in await mainstream.similar_artists(artist)
        if artist_key(name) != artist_key(artist)
    ][:_SIMILAR_HITS_CHECK]
    if not names:
        return []
    # Ждём все ответы: пул сам по себе фоновый (_gather_within его не отменяет),
    # а недождавшийся артист выпал бы из кэша пула на все 6 часов.
    infos = await mainstream.artist_hits(names, timeout=60)
    famous = [
        (name, infos.get(artist_key(name)))
        for name in names
        if mainstream.is_famous(infos.get(artist_key(name)))
    ][:_SIMILAR_HITS_ARTISTS]
    wanted = [
        (name, title)
        for name, info in famous
        for title in (info.get("top") or [])[:_SIMILAR_HITS_PER_ARTIST]
    ]
    resolved = await asyncio.gather(
        *(_resolve_similar(request, name, title) for name, title in wanted)
    )
    # Сначала первый хит каждого артиста, потом вторые: обрезка пула ниже по
    # потоку не должна съедать одного соседа целиком.
    by_rank = sorted(
        (index % _SIMILAR_HITS_PER_ARTIST, index, track)
        for index, track in enumerate(resolved)
        if track is not None
    )
    pool = [track for _rank, _index, track in by_rank]
    await set_cache_async(
        key,
        [t.model_dump() for t in pool],
        expire=_SIMILAR_HITS_TTL if pool else 600,
    )
    return pool


def _genre_artists_fetch(genre: str) -> List[str]:
    """Артисты жанра по Last.fm. БЛОКИРУЮЩАЯ.

    Топ тега Last.fm народный и испорчен шуточными тегами, поэтому каждого
    сверяем с его собственными главными тегами: жанр среди них — первыми,
    Last.fm артиста не знает — следом, остальные — вон.
    """
    # Не глубже, чем _artist_tag_map успевает сверить (_VERIFY_BUDGET): хвост
    # без тегов прошёл бы как «неизвестный» — так в breakcore попадал Skrillex.
    names = lastfm_genres.tag_artists(
        genre, limit=min(_GENRE_ARTISTS, lastfm_genres._VERIFY_BUDGET)
    )
    tags = lastfm_genres._artist_tag_map(names)

    def rank(name: str) -> int:
        # «Рядом» (тот же наш широкий ключ) для жанра мало: dubstep и breakcore
        # оба сводятся к electronic, и в breakcore шёл Skrillex. Нужен сам жанр
        # среди главных тегов артиста; без тегов Last.fm — следом за точными.
        artist_tags = tags.get(name)
        if not artist_tags:
            return 1
        return 2 if lastfm_genres._genre_affinity(genre, artist_tags) == 2 else 0

    scored = sorted((-rank(name), index, name) for index, name in enumerate(names))
    return [name for negative, _index, name in scored if negative < 0][:_GENRE_ARTISTS]


async def _genre_artists(genre: str) -> List[str]:
    key = f"flow:genre_artists:v1:{genre.lower()}"
    cached = await get_cache_async(key)
    if cached is not None:
        return cached
    names = await asyncio.to_thread(_genre_artists_fetch, genre)
    await set_cache_async(key, names, expire=_GENRE_TTL if names else 600)
    return names


def _title_names_genre(track, genre: str) -> bool:
    """В названии трека стоит сам жанр («… but Breakcore», «Nu Metal Mix»)."""
    _artist, title = effective_track_artist_title(track)
    words = re.findall(r"\w+", genre.lower())
    text = " ".join(re.findall(r"\w+", (title or "").lower()))
    return bool(words) and re.search(r"\b" + r"\W+".join(map(re.escape, words)) + r"\b", text) is not None


async def _genre_hits_pool(request: Request, genre: str, part: int) -> List[ExternalTrackResponse]:
    """Хиты среза артистов выбранного жанра, уже играбельные, с кэшем на сутки."""
    key = f"flow:genre_hits:v1:{genre.lower()}:{part}"
    cached = await get_cache_async(key)
    if cached is not None:
        return [ExternalTrackResponse(**t) for t in cached]
    return await _pool_single_flight(
        key, lambda: _genre_hits_pool_fetch(request, genre, part, key)
    )


async def _genre_hits_pool_fetch(
    request: Request, genre: str, part: int, key: str
) -> List[ExternalTrackResponse]:
    artists = await _genre_artists(genre)
    chunk = artists[part * _GENRE_SLICE:(part + 1) * _GENRE_SLICE] or artists[:_GENRE_SLICE]
    if not chunk:
        await set_cache_async(key, [], expire=600)
        return []
    infos = await mainstream.artist_hits(chunk, timeout=60)
    wanted = [
        (name, title)
        for name in chunk
        for title in ((infos.get(artist_key(name)) or {}).get("top") or [])[:_GENRE_HITS_PER_ARTIST]
    ]
    resolved = await asyncio.gather(
        *(_resolve_similar(request, name, title) for name, title in wanted)
    )
    # Первый хит каждого артиста, потом вторые — как в _similar_hits_pool.
    by_rank = sorted(
        (index % _GENRE_HITS_PER_ARTIST, index, track)
        for index, track in enumerate(resolved)
        if track is not None and not _title_names_genre(track, genre)
    )
    pool = [track for _rank, _index, track in by_rank]
    await set_cache_async(
        key, [t.model_dump() for t in pool], expire=_GENRE_TTL if pool else 600
    )
    return pool


# Сборники и перезаливки: «Icona Pop: I Love It», «Eminem Greatest Hits». Песню,
# названную как артист («Iron Maiden» у Iron Maiden) или со словом из имени
# («Killer Queen» у Queen), не трогаем — только имя артиста В НАЧАЛЕ названия
# с разделителем или вместе со словом сборника.
_COMPILATION_RE = re.compile(
    r"\b(?:mix|megamix|best of|greatest hits|full album|playlist|top songs|"
    r"all songs|лучшие|сборник|все песни|полный альбом)\b",
    re.IGNORECASE,
)


def _title_repeats_artist(track) -> bool:
    artist, title = effective_track_artist_title(track)
    name = (artist or "").split(",")[0].strip().lower()
    title = (title or "").strip().lower()
    if len(name) < 3 or not title or name == title:
        return False
    if title.startswith(name) and re.match(r"\s*[:\-–—|/]", title[len(name):]):
        return True
    return name in title and _COMPILATION_RE.search(title) is not None


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
    songs = await ytdlp.ytmusic_artist_songs(browse_id, schedule_matches=False)
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


# Насколько каталог любимого артиста смещён к хитам (_popular_first_shuffle):
# вес места r в его топе — exp(-r / _DEEP_CUT_SCALE). При 6 в первые 10
# предложенных треков ~70% приходят из топ-10 артиста и ~5% — глубже топ-20
# (симуляция на каталоге из 40). Прод, 2026-10-14, 21 день: раньше порядок был
# равномерно случайным, и малопопулярные треки любимых артистов шли почти
# половиной источника при good 3.1% у владельца и 4.3% у остальных против 6.7%
# и 21–23% у популярных.
_DEEP_CUT_SCALE = 6.0


def _popular_first_shuffle(pool, context: str, salt: str, identity_of) -> list:
    """Случайный порядок каталога, взвешенный местом трека в топе артиста.

    Выборка без возвращения (Efraimidis–Spirakis, ключ log(u) / w),
    детерминированная контекстом подгрузки.
    """
    return _rank_weighted_shuffle(_by_service_popularity(pool), context, salt, identity_of)


def _rank_weighted_shuffle(ranked: list, context: str, salt: str, identity_of) -> list:
    """То же для уже упорядоченного по популярности списка: место r весит
    exp(-r / _DEEP_CUT_SCALE)."""

    def key(pair):
        rank, item = pair
        weight = math.exp(-rank / _DEEP_CUT_SCALE)
        u = max(stable_jitter(context, f"{salt}:{identity_of(item)}"), 1e-12)
        return math.log(u) / weight

    return [item for _rank, item in sorted(enumerate(ranked), key=key, reverse=True)]


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


# Доля каталогов на подгрузку у ядра коллекции. Прод, 2026-10-14: у владельца
# 276 артистов в коллекции, веса от 298 (Limp Bizkit) до сотни имён с одним
# импортированным треком; выбор с весом sqrt(вес) по всей коллекции отдавал
# большинство мест хвосту, и в волне было мало тех, кого юзер слушает и выбрал
# любимыми (выбранные в настройках — 15% видимой волны).
_CORE_FAVORITE_SHARE = 0.75
# Сколько самых тяжёлых по весу вкуса артистов входят в ядро помимо любимых.
_CORE_TOP_ARTISTS = 20


def _core_artist_keys(profile: dict) -> set:
    """Ядро коллекции: любимые (deep catalog — 5+ песен или выбраны в
    настройках) и самые слушаемые доказанные по весу вкуса."""
    weights = profile.get("artist_weight") or {}
    # Только «доказанные» (_ARTIST_PROVEN_WEIGHT): у юзера с плоской
    # коллекцией топ по весу — это случайные имена с одним треком.
    top = [
        key
        for key in sorted(weights, key=weights.get, reverse=True)
        if weights[key] >= _ARTIST_PROVEN_WEIGHT
    ][:_CORE_TOP_ARTISTS]
    return set(profile.get("deep_catalog_artist_keys") or []) | {
        primary_artist_key(key) for key in top
    }


def _is_core_artist(name: str, core_keys: set) -> bool:
    return primary_artist_key(name) in core_keys or artist_key(name) in core_keys


def _pick_favorite_artists(
    catalog_artists: List[str],
    artist_weights: dict,
    last_picked: dict,
    recent_artist_counts: Counter,
    *,
    now_ts: float,
    context: str,
    limit: int,
) -> List[str]:
    """Чьи каталоги тянуть в этой подгрузке.

    Взвешенная выборка без возвращения (Efraimidis–Spirakis, ключ u^(1/w)):
    шанс растёт с весом артиста (корень — чтобы один артист с весом 120 не
    забирал всё), только что взятое имя остывает по времени, а имя, уже
    звучавшее в последних отданных треках, — по числу повторов. Случайность
    детерминирована контекстом подгрузки: один запрос — один набор.
    Позиция в списке коллекции на выбор не влияет — иначе волна крутит голову
    списка и не доходит до хвоста.
    """
    candidates = {}
    for artist in catalog_artists:
        key = artist_key(artist)
        if key and key not in candidates:
            candidates[key] = artist

    def _priority(key: str) -> float:
        weight = _FAVORITE_ROTATION_FLOOR + math.sqrt(
            max(float(artist_weights.get(key, 0.0) or 0.0), 0.0)
        )
        picked_at = last_picked.get(key)
        if isinstance(picked_at, (int, float)):
            hours = max(now_ts - picked_at, 0.0) / 3600
            weight *= max(1.0 - math.exp(-hours / _FAVORITE_ROTATION_HOURS), 0.01)
        weight /= 1 + recent_artist_counts.get(primary_artist_key(candidates[key]), 0)
        u = max(stable_jitter(context, f"favorite-pick:{key}"), 1e-12)
        return math.log(u) / weight

    ordered = sorted(candidates, key=_priority, reverse=True)
    return [candidates[key] for key in ordered[:limit]]


async def _favorite_artist_pool(request: Request, artist: str) -> List[ExternalTrackResponse]:
    """Каталог любимого/знакомого артиста — как можно глубже.

    Порядок выдачи здесь НЕ решается: его выбирает вызывающий по тому, доказал
    ли артист «любимость» (см. _ARTIST_PROVEN_WEIGHT), поэтому пул кэшируется
    один на артиста и переиспользуется всеми пользователями.
    """
    key = f"flow:favorite:{artist_key(artist)}"
    cached = await get_cache_async(key)
    if cached is not None:
        # Сверка и на чтении: пул общий и живёт до _SC_EXPLORE_TTL, а собранные
        # прежней, мягкой сверкой записи иначе продолжали бы отдавать чужих.
        return _own_catalog_tracks(
            artist, [ExternalTrackResponse(**t) for t in cached]
        )
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
            request, artist, limit=_FAVORITE_CATALOG_LIMIT, schedule_matches=False
        )
    except Exception:  # noqa: BLE001
        logger.warning("flow favorite artist catalog failed for %s", artist)
        tracks = []
    if not tracks:
        try:
            tracks = await ytdlp.search_ytmusic(
                request, artist, limit=_FAVORITE_ARTIST_LIMIT, schedule_matches=False
            )
        except Exception:  # noqa: BLE001
            logger.warning("flow favorite artist search failed for %s", artist)
            tracks = []
    tracks = _own_catalog_tracks(artist, tracks)
    await set_cache_async(key, [t.model_dump() for t in tracks], expire=_SC_EXPLORE_TTL if tracks else 600)
    return tracks


def _own_catalog_tracks(artist: str, tracks) -> list:
    """Треки, где ``artist`` — исполнитель целиком или участник фичеринга.

    Подстрока по ключу склеивала разных артистов на коротких именах ("sky" —
    "skylar grey"), а сверка «каждое слово запроса есть в имени» оставляла
    достраивание: ник SoundCloud «who» из коллекции открывал каталог The Who
    (прод, 2026-10-10). Имя из коллекции — полное имя, достраивать его нельзя;
    см. names_whole_artist. favorite_explore вкусовую проверку не проходит —
    это по замыслу точный каталог своего артиста, — поэтому сверка тут строгая.
    """
    if not artist_key(artist):
        return []
    return [
        t
        for t in tracks
        if names_whole_artist(artist, effective_track_artist_title(t)[0])
    ]


async def _artist_seed_videos(request: Request, artist: str) -> List[str]:
    """videoId треков артиста в YT Music — сиды радио для юзера, у которого
    своих ytmusic-треков нет. Поиск полнотекстовый, поэтому оставляем только то,
    где артист реально фигурирует в поле artist (как в _soundcloud_pool)."""
    # v2: сверка подстрокой («who» в «the who») заменена на names_whole_artist,
    # старые записи с чужими сидами кэша не переживают.
    key = f"flow:artist_seed:v2:{artist_key(artist)}"
    cached = await get_cache_async(key)
    if cached is not None:
        return cached
    if _pool_cache_only.get():
        return []

    try:
        found = await ytdlp.search_ytmusic(
            request, artist, limit=_ARTIST_SEED_LIMIT * 3, schedule_matches=False
        )
    except Exception:  # noqa: BLE001
        logger.warning("flow artist seed search failed for %s", artist)
        await set_cache_async(key, [], expire=600)
        return []

    videos = [
        t.external_id
        for t in found
        if (
            t.external_id
            and names_whole_artist(artist, effective_track_artist_title(t)[0])
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
    if _pool_cache_only.get():
        return []

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
        ytdlp.search_ytmusic(
            request, tag, limit=_TAG_EXPLORE_LIMIT, schedule_matches=False
        ),
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


def _external_plan(
    profile: dict,
    ranking_context: str,
    *,
    limit: int,
    last_picked: dict,
    recent_artist_counts: Counter,
    now_ts: float,
    favorite_limit: Optional[int] = None,
) -> dict:
    """Что именно спрашивать у внешних провайдеров для одной порции потока.

    Чистая функция профиля и ranking_context (хэш последних 50 id истории):
    сиды радио, артисты графа, любимые артисты, сиды Last.fm, хиты похожих,
    SoundCloud-артисты и теговый запрос. Зависит только от профиля и контекста
    порции, поэтому одинаков в живом запросе и в предрасчёте flow-warmer.
    """
    banned = profile.get("banned_artists") or set()
    # Сиды всегда берём из подтверждённого профиля пользователя. Переходы от
    # рекомендованного трека к его radio создавали жанровый дрейф на каждом
    # следующем hop. Случайная ротация по широкому набору профильных сидов даёт
    # новые пулы без ухода от русского рэпа к поп/техно/ретро.
    # Плейлистные сиды идут первыми, потому что сохраняют явный контекст
    # коллекции; их кандидаты всё равно конкурируют с остальными общим score.
    profile_seeds = list(dict.fromkeys(profile["playlist_seeds"]))
    if not profile_seeds:
        profile_seeds = list(dict.fromkeys(profile["seeds"]))
    seeds = _mix_fresh_seeds(
        profile.get("fresh_seeds") or [],
        profile_seeds,
        _PROFILE_SEEDS,
        ranking_context,
        "profile-seed",
    )

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

    # Каталог запрашиваем для любого артиста из СОБСТВЕННОЙ коллекции юзера —
    # лайки, свои плейлисты, импорт, явные предпочтения. Это не разведка: пул
    # возвращает треки именно запрошенного артиста (_favorite_artist_pool
    # сверяет имя), поэтому «чужого» в поток он привести не может, а вот без
    # него импортированный артист не попадал в выдачу ни одним путём.
    catalog_artists = list(
        dict.fromkeys(
            (profile.get("liked_artists") or [])
            + (profile.get("playlist_artists") or [])
            + list(dict.fromkeys(profile.get("catalog_artists") or []))
        )
    )
    # Здесь ограничивается только стоимость сетевой генерации. Сколько треков
    # выбранного артиста дойдёт до ранкера, решает accept_limit (считая уже
    # прошедшие исключения), а места в ответе по-прежнему не закреплены ни за
    # одним источником: каталог каждого артиста конкурирует со всеми остальными
    # кандидатами в общей модели.
    # Без мейнстрим-фильтра ядро коллекции — выбранные в настройках, любимые
    # (5+ песен) и самые слушаемые — получает большую часть мест, хвост —
    # остальное (см. _CORE_FAVORITE_SHARE).
    weights = profile.get("artist_weight") or {}
    # От размера выдачи, а не пула предрасчёта: с пулом 30 (hybrid-v18) брались
    # 23 артиста ядра из 25 — почти все, и вес на выбор уже не влиял (прод,
    # 2026-10-14: Limp Bizkit, вес 269, показан реже Queen и Pixies с весом 0.5).
    total = max(_FAVORITE_EXPLORE_ARTISTS, min(len(catalog_artists), favorite_limit or limit))
    if mainstream.available():
        # Мейнстрим-фильтр (_compute_flow, mainstream.gate) пропускает артиста
        # не из deep catalog только топ-3 хитами — его каталог качался и
        # выбрасывался целиком: прод, 2026-10-19, у владельца 64 знакомых
        # кандидата до фильтра и 0 после (Drowning Pool, Powerwolf, Любэ), пул
        # 11 вместо 30, лайки сверх квоты — заменить нечем. Места — тем, кого
        # фильтр не режет (тот же ключ, что у гейта); хвост — только остаток.
        deep_keys = set(profile.get("deep_catalog_artist_keys") or [])
        core = [a for a in catalog_artists if primary_artist_key(a) in deep_keys]
        tail = [a for a in catalog_artists if primary_artist_key(a) not in deep_keys]
        core_limit = min(len(core), total)
    else:
        core_keys = _core_artist_keys(profile)
        core = [a for a in catalog_artists if _is_core_artist(a, core_keys)]
        tail = [a for a in catalog_artists if not _is_core_artist(a, core_keys)]
        core_limit = min(len(core), math.ceil(total * _CORE_FAVORITE_SHARE))
    pick = functools.partial(
        _pick_favorite_artists,
        artist_weights=weights,
        last_picked=last_picked,
        recent_artist_counts=recent_artist_counts,
        now_ts=now_ts,
        context=ranking_context,
    )
    favorite_artists = pick(core, limit=core_limit)
    # Артист хвоста с одной песней в коллекции и без доказанного веса — чаще
    # всего один лайк, а не любимый: его каталог уходит в скипы (прод: good
    # 2.7% / bad 65%; 2026-10-14 — Аукцыон, 10 показов за 2 дня от лайка одной
    # песни, 8 скипов). Такие идут, только если остальным хвостом мест не
    # заполнить: у коллекции из одних одиночных треков волна не должна пустеть.
    song_counts = profile.get("collection_song_counts") or {}

    def _single_unproven(artist: str) -> bool:
        return (
            song_counts.get(primary_artist_key(artist), 0) <= 1
            and weights.get(artist_key(artist), 0.0) < _ARTIST_PROVEN_WEIGHT
        )

    tail_main = [a for a in tail if not _single_unproven(a)]
    tail_single = [a for a in tail if _single_unproven(a)]
    favorite_artists += pick(tail_main, limit=total - len(favorite_artists))
    favorite_artists += pick(tail_single, limit=total - len(favorite_artists))

    # Похожие по ТРЕКУ (Last.fm) держим отдельным списком только до общей
    # фильтрации и статистики качества. Сиды перемешиваем, чтобы каждая
    # подгрузка не ходила к одному и тому же самому свежему лайку.
    seed_tracks = _mix_fresh_seeds(
        [tuple(pair) for pair in profile.get("fresh_seed_tracks") or []],
        [tuple(pair) for pair in profile.get("seed_tracks") or []],
        _LASTFM_SEED_TRACKS,
        ranking_context,
        "lastfm-seed",
    )

    # Сиды хитов похожих: один артист из свежих позитивов и остальные из
    # любимых (у кого нет любимых — из доверенных артистов вкуса), с ротацией.
    hits_seed_artists: List[str] = []
    if mainstream.available():
        def _rotated(values, salt):
            return sorted(
                dict.fromkeys(v for v in values if v),
                key=lambda value: stable_jitter(ranking_context, f"{salt}:{value}"),
                reverse=True,
            )

        fresh_artists = _rotated(
            (primary_artist_key(pair[0]) for pair in profile.get("fresh_seed_tracks") or []),
            "hits-fresh",
        )
        anchor_artists = _rotated(
            profile.get("deep_catalog_artist_keys")
            or profile.get("trusted_artist_keys")
            or [],
            "hits-anchor",
        )
        for artist in [*fresh_artists[:1], *anchor_artists]:
            if len(hits_seed_artists) >= _SIMILAR_HITS_SEEDS:
                break
            if artist not in hits_seed_artists and artist not in banned:
                hits_seed_artists.append(artist)

    # SoundCloud-разведка: ищем по нескольким любимым артистам. Плейлистные
    # артисты идут первыми среди SC-запросов, но полученные треки затем
    # ранжируются вместе со всеми остальными источниками.
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

    # Разведка по тегам вкуса: реально новые треки (в т.ч. от незнакомых
    # авторов). НЕ ищем по одиночному неоднозначному слову ("гей") — провайдеры
    # отдают серьёзные/иностранные треки на тему. Ищем комбинацию top-тегов
    # ("сво гей", "гей порно") — это специфичный русский мем, а не firehose.
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

    tag_query = " ".join(tag_words[:2]) if tag_words else ""
    # Выбранный в настройках жанр — пул хитов его артистов (_genre_hits_pool),
    # по одному жанру и срезу артистов за подгрузку. Поиск по словам при нём
    # не нужен: по слову жанра он и приносил мусор, а слова из названий у таких
    # юзеров — имена их же песен.
    explicit = [
        genre.strip()
        for genre in (profile.get("explicit_genres") or [])
        if isinstance(genre, str) and genre.strip()
    ]
    genre = (
        max(explicit, key=lambda name: stable_jitter(ranking_context, f"explicit-genre:{name}"))
        if explicit
        else ""
    )
    if genre:
        tag_query = ""

    return {
        "seeds": seeds,
        "similar_artists": similar_artists,
        "favorite_artists": favorite_artists,
        "seed_tracks": seed_tracks,
        "hits_seed_artists": hits_seed_artists,
        "sc_artists": sc_artists,
        "tag_query": tag_query,
        "genre": genre,
        "genre_part": int(stable_jitter(ranking_context, f"genre-part:{genre}") * _GENRE_PARTS),
    }


# Готовые порции. Веер провайдеров и ранжирование стоят секунды CPU на порцию:
# замер 2026-10-13 — 100 одновременных холодных /flow на 4 воркерах дали 80
# обрывов и WORKER TIMEOUT. Поэтому следующую порцию заранее считает отдельный
# процесс flow-warmer (app/flow_warmer.py) тем же конвейером _compute_flow —
# сразу после выдачи и периодически для активных юзеров — и кладёт её в
# flow:ready:{user} вместе с ranking_context, для которого она посчитана.
# Запрос с совпавшим контекстом лишь отфильтровывает очередь клиента и свежие
# скипы/дизлайки и пишет историю с телеметрией: десятки миллисекунд вместо
# секунд. Иначе — живой расчёт, под нагрузкой без сети (_pool_cache_only).
_FLOW_PRECOMPUTE = os.getenv("FLOW_PRECOMPUTE", "1").lower() not in ("0", "false", "no")
# Предрасчёт никто не ждёт — провайдерам можно дать больше, чем живому клику.
_FLOW_PRECOMPUTE_BUDGET = 8.0
# Живых расчётов с походом в сеть на воркер одновременно; сверх — только кэш.
# Веер одного холодного юзера стоит секунды CPU, и под пиком он отнимал их у
# всех остальных запросов воркера (GIL), вплоть до WORKER TIMEOUT.
_FLOW_LIVE_NETWORK_SLOTS = int(os.getenv("FLOW_LIVE_NETWORK_SLOTS", "2"))
_READY_TTL = 2 * 60 * 60
# Старше — считаем заново: вкус и час суток успели уехать.
_READY_MAX_AGE = 90 * 60
# Сколько от готовой порции должно остаться после фильтра (очередь клиента,
# свежие скипы и дизлайки), чтобы отдать её. Оставшиеся треки не хуже — их
# просто меньше, и фронт попросит следующую порцию раньше; а живой пересчёт
# стоит ~1 CPU-с и под пиком дороже сотни готовых выдач.
_READY_MIN_SHARE = 0.5
_PC_QUEUE = "flow:pc:queue"
_PC_QUEUED = "flow:pc:queued"
# Последний публичный адрес, с которого приходили за потоком: flow-warmer
# собирает по нему stream_url, когда у юзера нет своей меты (вернулся после
# перерыва, Redis пересоздан).
_PC_BASE_URL = "flow:pc:base_url"
_PC_META_TTL = 24 * 60 * 60
# Живых расчётов порции на воркер одновременно. Расчёт — около секунды CPU и
# соединение БД на всё время сборки профиля; без потолка 100 одновременных
# холодных /flow (замер 2026-10-13: Redis без готовых порций) забирали весь пул
# (QueuePool timeout) и CPU, event loop голодал до WORKER TIMEOUT. Лишние ждут
# очереди, не занимая ни того, ни другого, а готовые порции идут мимо неё.
_FLOW_LIVE_CONCURRENCY = int(os.getenv("FLOW_LIVE_CONCURRENCY", "2"))
# Только кэш: пулы не запускают сетевых задач (см. _pool_single_flight).
_pool_cache_only: ContextVar[bool] = ContextVar("flow_pool_cache_only", default=False)
_live_network_inflight = 0
_live_waiting = 0
_live_semaphores: dict = {}


def _live_semaphore() -> asyncio.Semaphore:
    # По loop: тесты гоняют каждый TestClient в своём (как mainstream._semaphores).
    loop_id = id(asyncio.get_running_loop())
    semaphore = _live_semaphores.get(loop_id)
    if semaphore is None:
        semaphore = _live_semaphores[loop_id] = asyncio.Semaphore(_FLOW_LIVE_CONCURRENCY)
    return semaphore


def _history_key(user_id: int) -> str:
    return f"flow:history:v2:{user_id}"


def _ready_key(user_id: int) -> str:
    return flow_ready_key(user_id)


def _pc_meta_key(user_id: int) -> str:
    return flow_pc_meta_key(user_id)


def _ranking_context(user_id: int, history: dict) -> str:
    return f"flow:{user_id}:" + "|".join(
        str(value) for value in list(history.get("ids") or [])[-50:]
    )


async def _load_flow_history(db: Session, user_id: int) -> dict:
    history = await get_cache_async(_history_key(user_id)) or {}
    if not any(history.get(name) for name in ("ids", "keys", "artists")):
        history = await asyncio.to_thread(_persisted_history_released, db, user_id)
    return history


def _persisted_history_released(db: Session, user_id: int) -> dict:
    try:
        return _persisted_flow_history(db, user_id, _FLOW_HISTORY_LIMIT)
    finally:
        # Читающая транзакция закончена — соединение обратно в пул (см. get_flow).
        db.rollback()


# Фронт присылает в exclude последние 100 треков очереди (playerStore.js).
_CLIENT_QUEUE_LIMIT = 100


def _exclude_from_history(history: dict, limit: int = _CLIENT_QUEUE_LIMIT) -> str:
    """exclude, каким его прислал бы фронт: очередь — это отданные порции.

    Фронт шлёт item.id: число у трека из локального каталога (даже если у него
    есть provider id), source:external_id у внешнего. История ids хранит
    provider id, и по ней лайк из каталога не узнавался как стоящий в очереди —
    предрасчёт выбирал его снова, а выдача отбрасывала (2026-10-13: до трети
    готовых порций уходили в живой расчёт). Поэтому очередь пишется отдельно.
    """
    queue = history.get("queue")
    if isinstance(queue, list) and queue:
        return ",".join(str(item_id) for item_id in queue[-limit:])
    parts = []
    for item_id in list(history.get("ids") or [])[-limit:]:
        item_id = str(item_id)
        parts.append(item_id.split(":", 1)[1] if item_id.startswith("local:") else item_id)
    return ",".join(parts)


def _precompute_exclude(db: Session, history: dict) -> str:
    """exclude для предрасчёта: очередь клиента плюс числовые id каталога.

    Трек из локального каталога фронт присылает числом, а в истории (особенно
    восстановленной из БД или записанной до появления history["queue"]) он
    лежит provider id — переводим одним SELECT, иначе предрасчёт возьмёт уже
    стоящий в очереди лайк и выдача отбросит порцию.
    """
    parts = [p for p in _exclude_from_history(history).split(",") if p]
    pairs = {
        tuple(str(item_id).split(":", 1))
        for item_id in list(history.get("ids") or [])[-_CLIENT_QUEUE_LIMIT:]
        if ":" in str(item_id) and not str(item_id).startswith("local:")
    }
    if pairs:
        try:
            rows = db.execute(
                select(Track.id).where(tuple_(Track.source, Track.external_id).in_(pairs))
            ).scalars().all()
        finally:
            db.rollback()
        parts.extend(str(track_id) for track_id in rows)
    return ",".join(dict.fromkeys(parts))


def _enqueue_precompute_blocking(user_id: int, meta: dict) -> None:
    pipe = redis_client.pipeline()
    pipe.sadd(_PC_QUEUED, user_id)
    pipe.set(_pc_meta_key(user_id), json.dumps(meta), ex=_PC_META_TTL)
    if meta.get("base_url"):
        pipe.set(_PC_BASE_URL, json.dumps(meta["base_url"]), ex=_PC_META_TTL * 7)
    added = pipe.execute()[0]
    # Юзер уже в очереди — второй раз не ставим: воркер посчитает порцию по
    # той истории, что будет на момент расчёта, то есть самой свежей.
    if added:
        redis_client.rpush(_PC_QUEUE, user_id)


async def _enqueue_precompute(user_id: int, meta: dict) -> None:
    if not _FLOW_PRECOMPUTE:
        return
    try:
        await asyncio.to_thread(_enqueue_precompute_blocking, user_id, meta)
    except Exception:  # noqa: BLE001 — без предрасчёта поток работает живым путём
        logger.warning("flow precompute enqueue failed user=%s", user_id, exc_info=True)


def _fresh_negatives(db: Session, user_id: int, since: datetime) -> tuple[set, set]:
    """Скипы и дизлайки после since: (идентичности треков, ключи артистов).

    Готовая порция посчитана до них — то, что юзер успел отвергнуть, пока
    слушал прошлую, отфильтровываем при выдаче. Артист отпадает целиком и за
    скип, не только за дизлайк: живой расчёт сразу штрафует артиста скипнутого
    трека, а сравнение 2026-10-13 показало, что без этого готовые порции чаще
    возвращали только что скипнутых артистов (3.3% треков против 0.8%).
    """
    try:
        return _fresh_negatives_query(db, user_id, since)
    finally:
        db.rollback()


def _fresh_negatives_query(db: Session, user_id: int, since: datetime) -> tuple[set, set]:
    identities: set = set()
    artists: set = set()
    rows = db.execute(
        select(
            Track.id,
            Track.source,
            Track.external_id,
            Track.artist,
            user_track_skips.c.disliked,
        )
        .join(user_track_skips, user_track_skips.c.track_id == Track.id)
        .where(
            user_track_skips.c.user_id == user_id,
            user_track_skips.c.last_skipped > since,
        )
    ).all()
    for track_id, source, external_id, artist, _disliked in rows:
        identities.add(f"local:{track_id}")
        if source and external_id:
            identities.add(f"{source}:{external_id}")
        if artist:
            artists.update(artist_key(a) for a in artist.split(","))
    events = db.execute(
        select(
            recommendation_events.c.track_id,
            recommendation_events.c.source,
            recommendation_events.c.external_id,
            recommendation_events.c.artist,
            recommendation_events.c.event_type,
        ).where(
            recommendation_events.c.user_id == user_id,
            recommendation_events.c.occurred_at > since,
            recommendation_events.c.event_type.in_(("skip", "dislike")),
        )
    ).all()
    for track_id, source, external_id, artist, event_type in events:
        if track_id:
            identities.add(f"local:{track_id}")
        if source and external_id:
            identities.add(f"{source}:{external_id}")
        if artist:
            artists.update(artist_key(a) for a in artist.split(","))
    artists.discard("")
    return identities, artists


async def _take_ready_portion(
    db: Session,
    user_id: int,
    excluded_artists: list,
    history: dict,
    limit: int,
    exclude: str,
    base_url: str = "",
) -> tuple[Optional[tuple[list, dict, dict, bool]], str]:
    """Готовый пул для этого запроса: ((items, scores, features, matched,
    payload), "hit") или (None, причина промаха) — причина уходит в
    Server-Timing. matched — матчи источников аудио уже поставлены при
    предрасчёте. Пул больше ``limit``: выдачу из него выбирает _session_select,
    остаток возвращается готовой порцией (_store_leftover)."""
    key = _ready_key(user_id)
    # Одним пакетом (get_cache_async склеивает одновременные чтения в MGET).
    payload, negative_at = await asyncio.gather(
        get_cache_async(key), get_cache_async(negative_signal_key(user_id))
    )
    if not isinstance(payload, dict):
        return None, "none"
    # Одноразовая: и отданная, и отвергнутая ниже порция больше не нужна.
    await asyncio.to_thread(delete_cache, key)
    if payload.get("context") != _ranking_context(user_id, history):
        return None, "context"
    created = float(payload.get("created") or 0)
    if time.time() - created > _READY_MAX_AGE:
        return None, "stale"

    excl_numeric, _videos, excl_external = _parse_exclude(exclude)
    queued = {f"local:{item_id}" for item_id in excl_numeric} | excl_external
    # Метку ставят скип/дизлайк после коммита (recommendation_cache.
    # mark_negative_signal). Нет её или она старше порции — в БД идти незачем.
    if isinstance(negative_at, (int, float)) and negative_at >= created:
        negatives, bad_artists = await asyncio.to_thread(
            _fresh_negatives, db, user_id, datetime.fromtimestamp(created, timezone.utc)
        )
    else:
        negatives, bad_artists = set(), set()
    bad_artists |= {artist_key(a) for a in excluded_artists if a}
    # stream_url собраны под адрес, с которым считалась порция; отдаём под тот,
    # с которого пришёл этот запрос (другой домен, туннель, нет меты у воркера).
    built_for = str(payload.get("base_url") or "")
    rebase = bool(base_url and built_for and built_for != base_url)
    kept = []
    for item in payload.get("items") or []:
        if not isinstance(item, dict):
            continue
        if rebase:
            item = dict(item)
            for field in ("stream_url", "download_url"):
                value = item.get(field)
                if isinstance(value, str) and value.startswith(built_for):
                    item[field] = base_url + value[len(built_for):]
        identities = {_flow_item_identity(item)}
        if isinstance(item.get("id"), int):
            identities.add(f"local:{item['id']}")
        if identities & queued or identities & negatives:
            continue
        artist, _title = _flow_item_artist_title(item)
        if bad_artists and any(artist_key(a) in bad_artists for a in artist.split(",")):
            continue
        kept.append(dict(item))
    if len(kept) < max(1, math.ceil(limit * _READY_MIN_SHARE)):
        return None, "drops"
    return (
        kept,
        payload.get("scores") or {},
        payload.get("features") or {},
        bool(payload.get("matched", True)),
        payload,
    ), "hit"


def _record_flow_delivery(
    telemetry_bind, user_id: int, mix: list, request_id: str, scores: dict, features: dict
) -> None:
    # Своя короткая сессия: запрос не держит соединение из пула, пока ждёт
    # провайдеров, а телеметрии нужна одна транзакция.
    telemetry_db = Session(bind=telemetry_bind)
    try:
        record_delivery(
            telemetry_db,
            user_id=user_id,
            items=mix,
            surface="flow",
            request_id=request_id,
            scores=scores,
            features=features,
            algorithm_version=ALGORITHM_VERSION,
        )
        telemetry_db.commit()
    except Exception:
        telemetry_db.rollback()
        logger.exception("flow delivery telemetry failed user=%s", user_id)
    finally:
        telemetry_db.close()


async def _deliver_portion(
    *,
    request: Request,
    user_id: int,
    limit: int,
    hour: Optional[int],
    exclude: str,
    mix: list,
    scores: dict,
    features: dict,
    history: dict,
    telemetry_bind,
    request_id: str,
    timings: Optional[list] = None,
    schedule_matches: bool = True,
    after_history=None,
) -> list:
    """Выдача посчитанной порции: конверт атрибуции, история, телеметрия и
    постановка следующей порции в предрасчёт. Общая для живого и готового пути.

    after_history(mix) — корутина сразу после записи истории и ДО постановки
    в предрасчёт: остаток пула должен лечь раньше, чем flow-warmer проверит,
    есть ли готовое (иначе он пересчитывал пул после каждой выдачи)."""
    # Первая порция (очередь пуста, exclude не пришёл) — это клик по «потоку»:
    # открываем её треком, который заиграет без резолва. Подгрузки не трогаем —
    # их треки прогреваются задолго до того, как до них дойдёт очередь.
    if not exclude:
        mix = await _front_instant_start(mix)
    # Не больше двух треков одного артиста подряд — и внутри порции, и на стыке
    # с прошлой (её хвост в history["artists"]). Первая порция стыка не имеет:
    # трек мгновенного старта остаётся первым.
    mix = flow_session.limit_artist_runs(
        mix,
        lambda item: primary_artist_key(_flow_item_artist_title(item)[0]),
        (history.get("artists") or []) if exclude else (),
    )

    # Attach one stable attribution envelope to every delivered item. It is
    # written before the response so the client can confirm a real impression
    # and later feedback without materialising provider tracks first.
    delivery_scores = {}
    delivery_features = {}
    for position, item in enumerate(mix):
        identity = _flow_item_identity(item)
        score = scores.get(identity, 0.0)
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
        if identity in features:
            delivery_features[item.get("id")] = features[identity]

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
        returned_keys.append(list(_norm_key(*_flow_item_artist_title(item))))

    stage = time.perf_counter()
    old_ids = list(history.get("ids") or [])
    old_keys = list(history.get("keys") or [])
    await set_cache_async(
        _history_key(user_id),
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
                + [primary_artist_key(_flow_item_artist_title(item)[0]) for item in mix]
            )[-_ARTIST_HISTORY:],
            # Что было отдано под каким id клиента: по нему разбираются
            # сигналы сессии (параметр sess, app/flow_session.py).
            "meta": flow_session.clamp_meta(
                {
                    **(history.get("meta") if isinstance(history.get("meta"), dict) else {}),
                    **{
                        str(item.get("id")): flow_session.history_meta(
                            str(item.get("id")),
                            _flow_item_artist_title(item)[0],
                            features.get(_flow_item_identity(item)) or {},
                        )
                        for item in mix
                        if item.get("id") is not None
                    },
                }
            ),
            # Очередь в формате клиентского exclude — для предрасчёта.
            "queue": (
                [str(q) for q in (history.get("queue") or [])]
                + [str(item.get("id")) for item in mix if item.get("id") is not None]
            )[-_CLIENT_QUEUE_LIMIT:],
        },
        expire=_FLOW_HISTORY_TTL,
    )
    # Показы пишутся ДО ответа: клиент ссылается на них в обратной связи. Но в
    # треде — синхронный INSERT с коммитом прямо в event loop выстраивал все
    # одновременные /flow воркера в очередь за коммитами друг друга (замер
    # 2026-10-13: 100 одновременных готовых порций — 4 с при простаивающем CPU).
    if after_history is not None:
        await after_history(mix)
    if timings is not None:
        timings.append(("history", time.perf_counter() - stage))
    stage = time.perf_counter()
    await asyncio.to_thread(
        _record_flow_delivery,
        telemetry_bind,
        user_id,
        mix,
        request_id,
        delivery_scores,
        delivery_features,
    )
    if timings is not None:
        timings.append(("telemetry", time.perf_counter() - stage))
    # ytmusic в потоке — только метаданные: фоновой ищем soundcloud-эквиваленты
    # треков отданной порции, чтобы /api/ytdlp/stream/{id} успевал уйти на
    # SoundCloud, а не качать аудио с YouTube. Мисс — фолбэк на YouTube.
    # У готовой порции, посчитанной по выдаче, матчи уже поставил flow-warmer
    # при предрасчёте, а здесь это до 45 задач с чтением кэша на каждую выдачу.
    if schedule_matches:
        ytdlp._schedule_audio_matches(mix)
    # Следующую порцию — в предрасчёт. Час клиента храним сдвигом от UTC:
    # воркер считает порцию позже и должен знать, который час будет у юзера.
    hour_offset = (
        (hour - datetime.now(timezone.utc).hour) % 24 if hour is not None else None
    )
    await _enqueue_precompute(
        user_id,
        {
            "base_url": str(request.base_url).rstrip("/"),
            "limit": limit,
            "hour_offset": hour_offset,
            # Когда была выдача: flow-warmer по ней отличает порцию для
            # слушающего сейчас от периодического пересчёта.
            "at": time.time(),
        },
    )
    return mix


def _flow_item_artist_title(item) -> tuple[str, str]:
    if isinstance(item, dict):
        return effective_artist_title(
            item.get("title", ""),
            item.get("artist", ""),
            source=item.get("source", ""),
            album=item.get("album", ""),
        )
    return effective_track_artist_title(item)


def _flow_item_identity(item) -> str:
    """Стабильный id кандидата: source:external_id, local:id или artist:title."""
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
    artist, title = _flow_item_artist_title(item)
    return ":".join(_norm_key(artist, title))


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


async def _compute_flow(
    request: Request,
    response: Response,
    limit: int,
    exclude: str,
    hour: Optional[int],
    current_user: User,
    db: Session,
    *,
    mode: str = "live",
    history: Optional[dict] = None,
    schedule_matches: bool = True,
    relax: bool = False,
    prior: Optional[tuple] = None,
    pool_limit: Optional[int] = None,
    session: str = "",
):
    """Расчёт порции потока.

    mode="live" — ответ пользователю (история, телеметрия, следующая порция в
    предрасчёт). mode="precompute" — тот же конвейер без побочных эффектов для
    flow-warmer: возвращает payload для flow:ready. Ротация любимых пишется в
    обоих режимах — она описывает ту порцию, что уйдёт следующей.
    relax/prior — второй проход, когда обычный набрал меньше limit: бан артистов
    за одиночные скипы снят (profile["hard_banned_artists"]), недостающие места
    добираются к уже отобранному prior = (mix, scores, features).
    schedule_matches=False в предрасчёте — матчи источников аудио поставит
    выдача (payload["matched"]): порцию для того, кто сейчас не слушает, могут
    так и не забрать, а матч Soulseek качает файл на диск.
    pool_limit — сколько кандидатов отобрать в предрасчёте: пул на несколько выдач,
    из которого каждая берёт ``limit`` под сигналы сессии (app/flow_session.py).
    session — сигналы сессии от клиента (параметр sess) для живой выдачи.
    """
    precompute = mode == "precompute"
    request_limit = limit
    if pool_limit:
        limit = max(limit, int(pool_limit))
    cache_only = _pool_cache_only.get()
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
    if history is None:
        history = await _load_flow_history(db, user_id)
    history_ids = set(history.get("ids") or [])
    history_keys = {
        tuple(key) for key in (history.get("keys") or [])
        if isinstance(key, list) and len(key) == 2
    }
    recent_artist_counts = Counter(
        a for a in (history.get("artists") or []) if isinstance(a, str)
    )
    ranking_context = _ranking_context(user_id, history)

    requested_ratio = discovery_ratio(current_user)
    profile = await asyncio.to_thread(_taste_profile, db, user_id)
    if relax:
        profile = {**profile, "banned_artists": set(profile.get("hard_banned_artists") or ())}
    # Ползунок отдаётся как есть. Раньше его часть выше дефолта сжималась
    # фактором приёма новых артистов (discovery_feedback.acceptance_factor), и
    # на проде 2026-10-18 у владельца 0.85 становилось 0.56: ползунок почти не
    # менял волну. Явно попрошенная новизна — просьба, а не prior.
    explore_ratio = requested_ratio
    # Исходы юзера и всех юзеров по источнику и письменности (часовой кэш).
    outcomes = await asyncio.to_thread(cached_outcome_stats, db, user_id)
    population_outcomes = await asyncio.to_thread(
        cached_population_stats, db, precompute or not _FLOW_PRECOMPUTE
    )
    user_origin_outcomes = outcomes.get("origin") or {}
    # Поправка скора на источник кандидата по тому, как юзер принимал его
    # отдачу (см. discovery_feedback.origin_terms).
    origin_term_by_name = origin_terms(
        {origin: stats[:2] for origin, stats in user_origin_outcomes.items()},
        f"origin:{ranking_context}",
    )
    # Места порции — источникам по их приёму (thompson_source_order ниже).
    source_posterior = source_posteriors(
        user_origin_outcomes, population_outcomes.get("origin") or {}
    )
    # Понижающая поправка за письменность, которую юзер не принимает: априор
    # из коллекции, апостериор из исходов (discovery_feedback.language_terms).
    cyr_share, lang_texts_count = profile.get("cyrillic_share") or (0.0, 0)
    language_term_by_script = language_terms(
        outcomes.get("script") or {},
        population_outcomes.get("script") or {},
        cyr_share,
        lang_texts_count,
    )
    # Ядро коллекции поправку за письменность не получает: доля письменности
    # считается по всей коллекции, и у юзера с 569 артистами, где русских
    # меньшинство, штраф бил по его же топу (прод, 2026-10-19: «Дайте танк (!)»,
    # 56 треков и вес 63 — language −0.26, в видимую волну не попал).
    core_artist_keys = _core_artist_keys(profile)
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
    score_inputs_by_item: dict[str, tuple] = {}
    selected_scores: dict[str, float] = {}
    content_bonus_by_identity: dict[str, float] = {}
    external_population: dict[str, dict] = {}

    _item_artist_title = _flow_item_artist_title
    _item_identity = _flow_item_identity

    def _flow_score(item, *, content_bonus: Optional[float] = None) -> float:
        identity = _item_identity(item)
        if content_bonus is None:
            content_bonus = content_bonus_by_identity.get(identity, 0.0)
        origin_term = origin_term_by_name.get(
            origin_by_identity.get(identity, "unknown"), 0.0
        )
        score_key = f"{identity}:{content_bonus:.3f}:{origin_term:.4f}"
        if score_key in score_by_item:
            return score_by_item[score_key]
        artist, title = _item_artist_title(item)
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
        service_popularity = 0.0
        if is_external:
            service_popularity = popularity_score(
                item_play_count, reference=SERVICE_POPULARITY_REFERENCE
            )
            if not item_play_count:
                # Счётчика нет, но есть место в топе артиста (страница артиста
                # YT Music): без него хит и глубокий трек шли на равных.
                service_popularity = rank_popularity(
                    item.get("provider_rank")
                    if isinstance(item, dict)
                    else getattr(item, "provider_rank", None)
                )
        score_inputs = dict(
            user_id=user_id,
            artist_affinity=_artist_affinity(artist, profile.get("artist_weight") or {}) or 0.0,
            genres=profile.get("genres") or (),
            novelty=_artist_affinity(artist, profile.get("artist_weight") or {}) is None,
            source=item.get("source") if isinstance(item, dict) else getattr(item, "source", None),
            popularity=max(local_popularity, service_popularity),
            content_bonus=content_bonus,
            acoustic_profile=profile.get("acoustic_profile"),
            context_bonus=context_bonus(item, contextual_profile),
            population_quality=population.get("quality", 0.0),
            now=ranking_now,
        )
        score = score_track(item, **score_inputs)
        is_novel_artist = _artist_affinity(artist, profile.get("artist_weight") or {}) is None
        # Keep the score itself continuous. A higher discovery target is
        # enforced after ranking, so relevance still decides which new tracks
        # fill the requested new-artist portion.
        discovery_term = (explore_ratio - 0.2) * (1.8 if is_novel_artist else -0.2)
        repeat_term = -min(
            _ARTIST_REPEAT_CAP,
            _artist_repeat_penalty(
                recent_artist_counts[primary_artist_key(artist)],
                _artist_affinity(artist, profile.get("artist_weight") or {}),
            ),
        )
        language_term = (
            0.0
            if _is_core_artist(artist, core_artist_keys)
            else language_term_by_script.get(script_of(artist, title), 0.0)
        )
        score +=discovery_term + repeat_term + origin_term + language_term
        score_by_item[score_key] = score
        # Компоненты считаются только для отданных позиций (см. телеметрию
        # ниже) — входы запоминаем, а не пересчитываем весь пул.
        score_inputs_by_item[score_key] = (
            item, score_inputs, discovery_term, repeat_term, origin_term, language_term
        )
        return score

    def _score_features(item) -> dict:
        identity = _item_identity(item)
        content_bonus = content_bonus_by_identity.get(identity, 0.0)
        origin = origin_by_identity.get(identity, "unknown")
        origin_term = origin_term_by_name.get(origin, 0.0)
        cached = score_inputs_by_item.get(
            f"{identity}:{content_bonus:.3f}:{origin_term:.4f}"
        )
        artist, _title = _item_artist_title(item)
        features = {
            "origin": origin,
            **(
                {"hit": hit_by_identity[identity]}
                if identity in hit_by_identity
                else {}
            ),
            "novel": _artist_affinity(artist, profile.get("artist_weight") or {}) is None,
            **({"in_collection": True} if identity in liked_identities else {}),
            **(
                {"fresh_cluster": True}
                if primary_artist_key(artist)
                in (profile.get("fresh_cluster_artist_keys") or ())
                else {}
            ),
            "discovery_requested": round(requested_ratio, 3),
            "discovery_effective": round(explore_ratio, 3),
        }
        script = script_of(artist, _title)
        if script:
            features["script"] = script
        proximity = proximity_by_artist.get(primary_artist_key(artist))
        if proximity:
            features["proximity"] = round(proximity, 3)
        if cached is not None:
            (
                source_item, inputs, discovery_term, repeat_term, origin_term, language_term
            ) = cached
            components = score_components(source_item, **inputs)
            components["discovery"] = discovery_term
            components["repeat"] = repeat_term
            components["origin"] = origin_term
            components["language"] = language_term
            features["components"] = {
                name: round(value, 4) for name, value in components.items()
            }
        return features

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
    # (_LIKED_REPLAY_COOLDOWN_DAYS) от прослушивания или скипа, дизлайк
    # исключает навсегда — см. _liked_candidates.
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
    # Кулдаун показанного (_SHOWN_COOLDOWN_DAYS). Квота лайков его не видит:
    # она сверяется с queued_ids, снятым выше, и не проверяет seen_keys.
    if not relax:
        excl_ids |= set(profile.get("shown_ids") or ())
        external_exclude |= set(profile.get("shown_external_ids") or ())
        seen_keys.update(profile.get("shown_keys") or ())

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
    liked_target = _liked_cap(limit, explore_ratio)

    # Откуда пришёл кандидат — пишется в телеметрию отдачи, чтобы по данным
    # было видно, какой генератор новинок работает, а какой отдаёт скипы.
    origin_by_identity: dict[str, str] = {}
    # Песни из коллекции юзера: лайки и песни любимых артистов из своих
    # плейлистов (favorite_collection). Все под одной квотой лайков — см. отбор.
    liked_identities: set[str] = set()
    # primary_artist_key -> близость к любимым артистам (см. _artist_proximity).
    proximity_by_artist: dict[str, float] = {}
    # Прошёл ли кандидат мейнстрим-фильтр (только для проверенных) — в телеметрию.
    hit_by_identity: dict[str, bool] = {}
    # Хиты артистов выбранного жанра: это и есть мейнстрим жанра, фильтр их не
    # режет (у андерграундного жанра почти нет артистов с 50k слушателей).
    genre_identities: set[str] = set()

    def _add_explore(
        tracks,
        target: Optional[List[ExternalTrackResponse]] = None,
        *,
        accept_limit: Optional[int] = None,
        origin: str,
        per_artist_limit: Optional[int] = None,
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
        per_artist: Counter = Counter()
        for t in tracks:
            if accept_limit is not None and accepted >= accept_limit:
                break
            effective_artist, effective_title = effective_track_artist_title(t)
            if (
                per_artist_limit is not None
                and per_artist[primary_artist_key(effective_artist)] >= per_artist_limit
            ):
                continue
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
            if _title_repeats_artist(t):
                continue
            # Оригиналы в приоритете: ремиксы, ускорения и каверы из внешних
            # пулов идут только во второй проход, когда оригиналов на порцию
            # не хватило (см. relax в конце функции).
            if not relax and is_derivative_title(effective_title):
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
            origin_by_identity.setdefault(_item_identity(t), origin)
            accepted += 1
            per_artist[primary_artist_key(effective_artist)] += 1

    # Пик фонового сравнения — первым, до сетевых источников: он уже посчитан,
    # и при совпадении с тем же треком от радио/графа в пул должна попасть
    # именно эта копия, со своим bonus. Синхронно сравнение НЕ запускаем —
    # каталоги кандидатов стоят до шести сетевых вызовов, а это прямая задержка
    # запроса; нет посчитанного пика — поток работает ровно как раньше.
    loop = asyncio.get_running_loop()
    network_started = loop.time()
    # Предрасчёт никто не ждёт; под нагрузкой (cache_only) сеть не ждём вовсе —
    # _gather_within всё равно даёт этапу _FLOW_STAGE_GRACE на чтения из Redis.
    if precompute:
        network_budget = _FLOW_PRECOMPUTE_BUDGET
    elif cache_only:
        network_budget = 0.0
    else:
        network_budget = _FLOW_NETWORK_BUDGET
    network_deadline = network_started + network_budget
    # Длительность этапов разведки уходит в Server-Timing: видно в DevTools,
    # какой провайдер съел время клика.
    stage_timings: list = []

    def _mark_stage(name: str, started: float) -> None:
        stage_timings.append((name, (loop.time() - started) * 1000))

    probe_pick = await artist_probe.cached_pick(user_id)
    if probe_pick is not None:
        _add_explore([probe_pick], probe_explore, origin="probe")

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
            top_genre_keywords(
                profile.get("genre_counts", {}),
                explicit=profile.get("explicit_genres") or (),
            )
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

    # Что спрашивать у провайдеров — план порции (см. _external_plan).
    rotation_key = f"flow:favorite-rotation:{user_id}"
    last_picked = await get_cache_async(rotation_key) or {}
    if not isinstance(last_picked, dict):
        last_picked = {}
    now_ts = ranking_now.timestamp()
    plan = _external_plan(
        profile,
        ranking_context,
        limit=limit,
        last_picked=last_picked,
        recent_artist_counts=recent_artist_counts,
        now_ts=now_ts,
        favorite_limit=request_limit,
    )
    seeds = plan["seeds"]
    similar_artists = plan["similar_artists"]

    # Своих ytmusic-сидов может не быть вовсе — вся коллекция в SoundCloud.
    # Резолвим сид по ИМЕНИ курированного артиста: глобально популярное здесь
    # брать нельзя, это чужая библиотека (см. _taste_profile).
    if not seeds and similar_artists:
        stage_started = loop.time()
        resolved = await _gather_within(
            [_artist_seed_videos(request, a) for a in similar_artists],
            network_deadline,
        )
        _mark_stage("seeds", stage_started)
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
    artist_weights = profile.get("artist_weight") or {}
    favorite_artists = plan["favorite_artists"]
    if favorite_artists:
        last_picked.update({artist_key(a): now_ts for a in favorite_artists})
        await set_cache_async(
            rotation_key,
            {
                k: ts for k, ts in last_picked.items()
                if isinstance(ts, (int, float))
                and now_ts - ts < _FAVORITE_ROTATION_TTL
            },
            expire=_FAVORITE_ROTATION_TTL,
        )
    favorite_jobs = [_favorite_artist_pool(request, a) for a in favorite_artists]
    favorite_window = max(limit, _FAVORITE_ARTIST_WINDOW)

    def _favorite_order(artist: str, pool) -> List[ExternalTrackResponse]:
        """В каком порядке любимый артист предлагает свой каталог ранкеру.

        Доказавший «любимость» артист отдаёт ЛЮБОЙ свой трек, но хиты чаще
        (_popular_first_shuffle): от запроса к запросу всплывают и вещи из
        глубины каталога, а внутри одного ответа выдача детерминирована.
        Непроверенный артист предлагает сначала популярное на своей площадке —
        его ещё представляют слушателю.

        Здесь только ПОРЯДОК: сколько треков артиста дойдёт до ранкера, решает
        accept_limit в _add_explore, уже после исключений.
        """
        if artist_weights.get(artist_key(artist), 0.0) < _ARTIST_PROVEN_WEIGHT:
            return _by_service_popularity(pool)
        return _popular_first_shuffle(
            pool, ranking_context, f"favorite-any:{artist}", _item_identity
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

        familiar_artists = profile.get("artist_weight") or {}
        novel_tracks = []
        novel_artists = set()
        for candidate in (*similar_explore, *probe_explore, *explore):
            name = effective_track_artist_title(candidate)[0]
            key = artist_key(name)
            if _artist_affinity(name, familiar_artists) is not None:
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
    seed_tracks = plan["seed_tracks"]
    lastfm_jobs = [_lastfm_pool(request, pair[0], pair[1]) for pair in seed_tracks]

    # Все ограниченные radio-запросы запускаем одновременно. Раньше они шли
    # волнами по два: при большом exclude каждая пустая волна добавляла полный
    # сетевой таймаут, поэтому быстрый пользователь успевал исчерпать очередь.
    discovery = [_radio_pool(seed) for seed in seeds]

    hits_seed_artists = plan["hits_seed_artists"]
    hits_jobs = [_similar_hits_pool(request, artist) for artist in hits_seed_artists]

    # Доказанные любимые этой подгрузки -> названия их каталога по популярности:
    # по нему песни из своей коллекции идут хитами вперёд
    # (_favorite_collection_candidates).
    favorite_ranks: dict = {}
    if favorite_jobs or lastfm_jobs or hits_jobs or discovery:
        stage_started = loop.time()
        pools = await _gather_within(
            [*favorite_jobs, *lastfm_jobs, *hits_jobs, *discovery], network_deadline
        )
        _mark_stage("pools", stage_started)
        favorite_count = len(favorite_jobs)
        lastfm_count = len(lastfm_jobs)
        hits_count = len(hits_jobs)
        # По артисту отдельным вызовом: бюджет favorite_window должен считаться
        # на каждого, иначе первый же артист с глубоким каталогом съедает его
        # целиком и остальные знакомые имена до ранкера не доходят.
        for artist, pool in zip(favorite_artists, pools[:favorite_count]):
            _add_explore(
                _favorite_order(artist, pool),
                favorite_explore,
                accept_limit=favorite_window,
                origin="favorite",
            )
            if artist_weights.get(artist_key(artist), 0.0) >= _ARTIST_PROVEN_WEIGHT:
                favorite_ranks[artist] = [
                    _norm_text(effective_track_artist_title(t)[1])
                    for t in _by_service_popularity(pool)
                ]
        _add_explore(
            (
                t for t in _interleave(
                    pools[favorite_count : favorite_count + lastfm_count]
                )
                if _matches_related(t)
            ),
            similar_explore,
            origin="lastfm_similar",
        )
        hits_start = favorite_count + lastfm_count
        _add_explore(
            (
                t for t in _interleave(pools[hits_start : hits_start + hits_count])
                if _matches_related(t)
            ),
            similar_explore,
            origin="similar_hits",
        )
        _add_explore(
            (
                t
                for pool in pools[hits_start + hits_count :]
                for t in pool
                if _matches_related(t)
            ),
            origin="radio",
            # Во втором проходе потолок снят: неполная порция хуже повтора.
            per_artist_limit=None if relax else _RADIO_PER_ARTIST,
        )

    # Граф артистов YT Music — дополнительный генератор кандидатов. Его можно
    # пропустить, когда основной внешний пул уже достаточно широк и цель
    # разведки выполнена; при повышенном ползунке он остаётся нужен, пока цель
    # новых имён не закрыта.
    if similar_artists and _needs_more_pools():
        stage_started = loop.time()
        graph_pools = await _gather_within(
            [_similar_pool(a) for a in similar_artists], network_deadline
        )
        _mark_stage("graph", stage_started)
        _add_explore(
            (t for pool in graph_pools for t in pool if _matches_related(t)),
            origin="artist_graph",
        )

    # SoundCloud-разведка: ищем по нескольким любимым артистам. Источник радио
    # у SC нет, поэтому это поиск — зато волна перестаёт быть моно-ytmusic.
    # Уже целевой источник (сам артист — часть вкуса), доп. фильтр по теме не
    # нужен — иначе выкинули бы легитимные треки любимого артиста без тега в
    # заголовке.
    # Плейлистные артисты идут первыми среди SC-запросов, но полученные треки
    # затем ранжируются вместе со всеми остальными источниками.
    sc_artists = plan["sc_artists"]
    # SoundCloud — резервный источник. Не ждём его сетевые поиски, если YT уже
    # дал достаточно широкий свежий пул.
    if sc_artists and _needs_more_pools():
        stage_started = loop.time()
        sc_pools = await _gather_within(
            [_soundcloud_pool(request, a) for a in sc_artists], network_deadline
        )
        _mark_stage("soundcloud", stage_started)
        _add_explore(
            (t for pool in sc_pools for t in pool if _matches_related(t)),
            origin="soundcloud",
        )

    genre = plan.get("genre") or ""
    if genre:
        stage_started = loop.time()
        (genre_pool,) = await _gather_within(
            [_genre_hits_pool(request, genre, plan.get("genre_part") or 0)],
            network_deadline,
        )
        _mark_stage("genre", stage_started)
        genre_identities.update(_item_identity(t) for t in genre_pool)
        _add_explore(genre_pool, origin="genre")

    # Теговый поиск также остаётся fallback: последовательное ожидание трёх
    # провайдеров было основной причиной долгой подгрузки следующих 15 треков.
    query = plan["tag_query"]
    if query and _needs_more_pools():
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
        stage_started = loop.time()
        (tag_pool,) = await _gather_within(
            [_tag_pool(request, query)], network_deadline
        )
        _mark_stage("tags", stage_started)
        _add_explore((t for t in tag_pool if tag_check(t)), origin="tag")

    _mark_stage("network", network_started)
    response.headers["Server-Timing"] = ", ".join(
        f"{name};dur={duration:.0f}" for name, duration in stage_timings
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
    local, liked_pool, favorite_pool = await asyncio.to_thread(
        _familiar_candidates_on_bind,
        telemetry_bind,
        profile,
        limit,
        set(excl_ids),
        queued_ids,
        liked_target,
        favorite_ranks,
        ranking_context,
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
    liked_banned = set(profile["banned_artists"]) - set(
        profile.get("flow_rejected_artists") or ()
    )
    for t in liked_pool:
        effective_artist, _effective_title = effective_track_artist_title(t)
        if t.id in queued_ids:
            continue
        if t.external_id and t.external_id in liked_excl_videos:
            continue
        if liked_banned and artist_key(effective_artist) in liked_banned:
            continue
        excl_ids.add(t.id)
        liked_candidates.append(t)
        liked_identities.add(_item_identity(t))
        origin_by_identity.setdefault(_item_identity(t), "liked")
    # Песни доказанных любимых из своей коллекции — каталог любимого артиста,
    # как и провайдерский (origin favorite). Повторы держит кулдаун показанного
    # в волне и уже отданное, а не прослушанное вне её (recent_video_ids):
    # сам слушал хиты через поиск — волна их от этого не прячет.
    favorite_excl_videos = (
        liked_excl_videos - set(profile.get("recent_video_ids") or [])
    ) | set(client_yt_videos)
    taken_keys = {_norm_key(*effective_track_artist_title(t)) for t in liked_candidates}
    shown_ids = set() if relax else set(profile.get("shown_ids") or ())
    shown_external_ids = set() if relax else set(profile.get("shown_external_ids") or ())
    shown_keys = set() if relax else set(profile.get("shown_keys") or ())
    favorite_collection: List[Track] = []
    for t in favorite_pool:
        key = _norm_key(*effective_track_artist_title(t))
        if t.id in queued_ids or t.id in shown_ids or key in shown_keys or key in taken_keys:
            continue
        if t.external_id and (
            t.external_id in favorite_excl_videos
            or f"{t.source}:{t.external_id}" in shown_external_ids
        ):
            continue
        taken_keys.add(key)
        excl_ids.add(t.id)
        favorite_collection.append(t)
        # Это уже лайк по сути — песня лежит в коллекции юзера. Без своей квоты
        # такие песни шли мимо потолка лайков общим рейтингом: прод, 2026-10-18,
        # у владельца при ползунке 0.85 — 37 из 105 видимых треков волны
        # (origin favorite) сверх 18 лайков, итого 53% волны из коллекции.
        liked_identities.add(_item_identity(t))
        origin_by_identity.setdefault(_item_identity(t), "favorite")
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
        origin_by_identity.setdefault(_item_identity(t), "local")

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
    # (не «Понравившиеся») плейлистов сюда идут только как песни доказанных
    # любимых (favorite_collection, со своими кулдаунами): остальные влияют на
    # вкус, но не повторяются в потоке.
    unified_candidates = []
    unified_identities = set()
    unified_keys = set()
    for candidate in (
        *liked_candidates,
        *favorite_collection,
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

    # Мейнстрим-фильтр: у артиста не из любимых (deep_catalog_artist_keys) в
    # волну идут только его хиты, топ-3 по Last.fm — см. app/mainstream.py.
    # Свои лайки юзера фильтр не трогает. Если доказанных хитов меньше порции, добираем самыми
    # популярными из отсеянных: пустая волна хуже нарушения правила. Добор —
    # до ПОРЦИИ (request_limit), а не до пула: с v18 limit здесь — размер пула
    # (30+), и добор до него пускал в каждую порцию не-хиты нишевых артистов
    # (жалоба владельца 2026-10-15). Недобранный пул warmer пересчитает раньше.
    if mainstream.available():
        stage_started = loop.time()
        deep_ok = set(profile.get("deep_catalog_artist_keys") or [])
        liked_identity_set = {_item_identity(t) for t in liked_candidates}

        def _gate_artist(item) -> str:
            return primary_artist_key(_item_artist_title(item)[0])

        gated = [
            c
            for c in unified_candidates
            if _item_identity(c) not in liked_identity_set
            and _item_identity(c) not in genre_identities
            and _gate_artist(c) not in deep_ok
        ]
        hits = await mainstream.artist_hits(
            {_gate_artist(c) for c in gated},
            timeout=_MAINSTREAM_WAIT,
            fetch_missing=not cache_only,
        )
        gated_ids = {_item_identity(c) for c in gated}
        before = len(unified_candidates)
        kept, hit_by_item = mainstream.gate(
            unified_candidates,
            infos=hits,
            exempt=lambda item: _item_identity(item) not in gated_ids,
            artist_of=_gate_artist,
            title_of=lambda item: _norm_key(*_item_artist_title(item))[1],
            norm_title=lambda name: _norm_key("", name)[1],
            limit=request_limit,
            popularity=lambda item: (
                item.get("play_count", 0)
                if isinstance(item, dict)
                else getattr(item, "play_count", 0)
            ),
        )
        for candidate in unified_candidates:
            if id(candidate) in hit_by_item:
                hit_by_identity[_item_identity(candidate)] = hit_by_item[id(candidate)]
        hits_count = sum(hit_by_item.values())
        logger.debug(
            "flow mainstream user=%s gated=%d hits=%d reserve_used=%d",
            user_id,
            len(gated),
            hits_count,
            len(kept) - (before - len(gated)) - hits_count,
        )
        unified_candidates = kept
        _mark_stage("mainstream", stage_started)
        response.headers["Server-Timing"] = ", ".join(
            f"{name};dur={duration:.0f}" for name, duration in stage_timings
        )
    # Близость артиста кандидата к любимым по графу Last.fm similar — признак
    # для обучаемого ранкера (app/learned_ranker.py): у нового артиста
    # affinity = 0, и без него новые кандидаты неразличимы ни для какой модели.
    stage_started = loop.time()
    proximity_by_artist.update(
        await _artist_proximity(
            profile.get("deep_catalog_artist_keys")
            or profile.get("trusted_artist_keys")
            or [],
            fetch=not cache_only,
            timeout=_PROXIMITY_WAIT if precompute else 0.3,
        )
    )
    _mark_stage("proximity", stage_started)
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
    for candidate in (*favorite_collection, *favorite_explore):
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
    familiar_artists = profile.get("artist_weight") or {}

    def _is_novel(candidate) -> bool:
        artist, _title = _item_artist_title(candidate)
        return _artist_affinity(artist, familiar_artists) is None

    # Какому источнику достаётся место — решает его приём у юзера (сэмпл
    # Томпсона, discovery_feedback.thompson_source_order), а не общий рейтинг:
    # поправка origin в score почти не меняла состав порции. Новые и знакомые
    # артисты переставляются порознь, каждые на своих местах рейтинга, — иначе
    # источники разведки вытеснили бы знакомое из добора и новизна ушла бы
    # выше ползунка. Лайки (своя квота) остаются на месте.
    if source_posterior:
        novelty = [
            None if _item_identity(c) in liked_identities else _is_novel(c)
            for c in ranked_candidates
        ]
        reordered = {
            flag: iter(
                thompson_source_order(
                    [c for c, f in zip(ranked_candidates, novelty) if f is flag],
                    lambda c: origin_by_identity.get(_item_identity(c), "unknown"),
                    source_posterior,
                    seed=f"source:{flag}:{ranking_context}",
                    window=limit,
                    score_of=_flow_score,
                    max_gap=_SOURCE_SCORE_GAP,
                )
            )
            for flag in (True, False)
        }
        ranked_candidates = [
            c if flag is None else next(reordered[flag])
            for c, flag in zip(ranked_candidates, novelty)
        ]

    # Квоты новизны, лайков и свежего кластера — одной функцией (app/flow_slate.py).
    fresh_cluster = set(profile.get("fresh_cluster_artist_keys") or [])
    probe_identities = {_item_identity(t) for t in probe_explore}
    selected_candidates, liked_selection = compose_slate(
        ranked_candidates,
        SlateRules(
            limit=limit,
            discovery_target=discovery_target,
            liked_target=liked_target,
            fresh_cap=max(1, math.floor(limit * _FRESH_CLUSTER_SHARE)),
            capped_max=_genre_cap(limit),
            novel_max=_novel_cap(limit, explore_ratio),
        ),
        is_novel=_is_novel,
        is_liked=lambda candidate: _item_identity(candidate) in liked_identities,
        artist_of=lambda candidate: primary_artist_key(_item_artist_title(candidate)[0]),
        novel_artist_of=lambda candidate: artist_key(_item_artist_title(candidate)[0]),
        recently_played_artist=lambda key: bool(recent_artist_counts[key]),
        in_fresh_cluster=lambda candidate: (
            primary_artist_key(_item_artist_title(candidate)[0]) in fresh_cluster
        ),
        capped=lambda candidate: _item_identity(candidate) in genre_identities,
        is_probe=(
            (lambda candidate: _item_identity(candidate) in probe_identities)
            if probe_identities
            else None
        ),
    )

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
        if _artist_affinity(_item_artist_title(item)[0], profile.get("artist_weight") or {})
        is None
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

    scores_by_identity: dict = {}
    features_by_identity: dict = {}
    for item in mix:
        identity = _item_identity(item)
        scores_by_identity[identity] = selected_scores.get(identity, _flow_score(item))
        try:
            features_by_identity[identity] = _score_features(item)
        except Exception:  # noqa: BLE001 — телеметрия не должна ронять выдачу
            logger.exception("flow score features failed user=%s", user_id)
    probe_identities_delivered = {_item_identity(t) for t in probe_explore}
    logger.debug(
        "flow result user=%s mode=%s explore=%d exploit=%d liked=%d/%d probe=%d returned=%d",
        user_id,
        mode,
        n_explore,
        n_exploit,
        len(liked_selection),
        liked_target,
        sum(1 for item in mix if _item_identity(item) in probe_identities_delivered),
        len(mix),
    )
    # Пустая или неполная порция хуже порции с артистом, которого юзер однажды
    # скипнул: на пустом ответе у фронта кончается очередь и музыка встаёт.
    # Второй проход со снятым мягким баном добирает недостающие места.
    if not relax and len(mix) < request_limit:
        return await _compute_flow(
            request, response, request_limit, exclude, hour, current_user, db,
            mode=mode, history=history, schedule_matches=schedule_matches,
            relax=True, prior=(mix, scores_by_identity, features_by_identity),
            pool_limit=pool_limit, session=session,
        )
    if prior is not None:
        prior_mix, prior_scores, prior_features = prior
        taken = {_item_identity(item) for item in prior_mix}
        taken_keys = {_norm_key(*_item_artist_title(item)) for item in prior_mix}
        extra = []
        for item in mix:
            identity = _item_identity(item)
            key = _norm_key(*_item_artist_title(item))
            if identity in taken or key in taken_keys:
                continue
            taken.add(identity)
            taken_keys.add(key)
            extra.append(item)
            if len(prior_mix) + len(extra) >= limit:
                break
        logger.info(
            "flow relaxed bans user=%s strict=%d added=%d", user_id, len(prior_mix), len(extra)
        )
        extra_ids = {_item_identity(item) for item in extra}
        for identity in extra_ids:
            if identity in features_by_identity:
                features_by_identity[identity]["relaxed"] = True
        mix = list(prior_mix) + extra
        scores_by_identity = {
            **{k: v for k, v in scores_by_identity.items() if k in extra_ids},
            **prior_scores,
        }
        features_by_identity = {
            **{k: v for k, v in features_by_identity.items() if k in extra_ids},
            **prior_features,
        }
    if precompute:
        # Юзер слушает (порцию заказала его выдача) — матчи источников аудио
        # ставим уже сейчас, к выдаче они будут готовы. Иначе их поставит выдача.
        # Только голове пула: остальное, может, так и не отдадут, а матч
        # Soulseek качает файл. Хвосту матчи поставит выдача (matched_ids).
        matched_items = mix[:request_limit] if schedule_matches else []
        if matched_items:
            ytdlp._schedule_audio_matches(matched_items)
        return {
            "context": ranking_context,
            "limit": request_limit,
            "created": time.time(),
            "matched": schedule_matches,
            "matched_ids": [_item_identity(item) for item in matched_items],
            "base_url": base_url,
            "items": jsonable_encoder(mix),
            "scores": scores_by_identity,
            "features": jsonable_encoder(features_by_identity),
        }
    mix, features_by_identity = await _session_select(
        mix,
        features_by_identity,
        limit=request_limit,
        user_id=user_id,
        history=history,
        session=session,
    )
    return await _deliver_portion(
        request=request,
        user_id=user_id,
        limit=request_limit,
        hour=hour,
        exclude=exclude,
        mix=mix,
        scores=scores_by_identity,
        features=features_by_identity,
        history=history,
        telemetry_bind=telemetry_bind,
        request_id=request_id,
    )


# Сколько кандидатов отбирает предрасчёт на одну выдачу ``limit``: пул на
# несколько выдач, каждая берёт свои ``limit`` под сигналы сессии. Меньше
# _POOL_MIN пул не держим — иначе переставлять почти нечего.
_POOL_FACTOR = 3
_POOL_MIN = 30
# Сколько соседей позитивного артиста сессии поднимаются (Last.fm, из кэша).
_SESSION_NEIGHBOUR_SEEDS = 3
_SESSION_NEIGHBOURS = 20


def pool_size(limit: int) -> int:
    return max(_POOL_MIN, int(limit) * _POOL_FACTOR)


async def _session_select(
    pool: list,
    features: dict,
    *,
    limit: int,
    user_id: int,
    history: dict,
    session: str,
    arm: Optional[str] = None,
) -> tuple[list, dict]:
    """Выдача ``limit`` из пула по варианту A/B и сигналам сессии.

    Возвращает (items, features) — к признакам отданных добавлены arm,
    поправки сессии, логит ранкера и пометка разведки (для телеметрии).
    """
    arm = arm or flow_session.pick_arm()
    meta = history.get("meta") if isinstance(history.get("meta"), dict) else {}
    state = flow_session.SessionState(
        flow_session.parse_session(session), lambda item_id: meta.get(str(item_id))
    )
    neighbours: set = set()
    learned = None
    if arm == "session":
        if state.positive_artists:
            lists = await asyncio.gather(
                *(
                    mainstream.cached_similar_artists(artist)
                    for artist in state.positive_artists[:_SESSION_NEIGHBOUR_SEEDS]
                ),
                return_exceptions=True,
            )
            neighbours = {
                primary_artist_key(name)
                for names in lists
                if isinstance(names, list)
                for name in names[:_SESSION_NEIGHBOURS]
            }
        model = await asyncio.to_thread(learned_ranker.load, user_id)
        learned = learned_ranker.scorer(model)
    ratio = _pool_discovery_ratio(pool, features)
    chosen, extra = flow_session.select(
        pool,
        limit=limit,
        arm=arm,
        identity_of=_flow_item_identity,
        artist_of=lambda item: _flow_item_artist_title(item)[0],
        features=features,
        session=state,
        learned=learned,
        neighbours=neighbours,
        previous_artists=history.get("artists") or [],
        capped=lambda item: (features.get(_flow_item_identity(item)) or {}).get("origin") == "genre",
        capped_max=_genre_cap(limit),
        novel_max=_novel_cap(limit, ratio),
        liked_max=_liked_cap(limit, ratio),
    )
    merged = dict(features)
    for identity, row in extra.items():
        merged[identity] = {**(features.get(identity) or {}), **row}
    return chosen, merged


def _pool_discovery_ratio(pool: list, features: dict) -> float:
    """Доля новизны, под которую считался пул (features.discovery_effective)."""
    for item in pool:
        value = (features.get(_flow_item_identity(item)) or {}).get("discovery_effective")
        if isinstance(value, (int, float)):
            return float(value)
    return DEFAULT_DISCOVERY_RATIO


def _history_ids_after(history: dict, mix: list) -> list:
    """history["ids"], какой её запишет _deliver_portion после выдачи mix."""
    returned = []
    for item in mix:
        source = item.get("source")
        external_id = item.get("external_id")
        if source and external_id:
            returned.append(f"{source}:{external_id}")
        elif item.get("id") is not None:
            returned.append(f"local:{item['id']}")
    return list(dict.fromkeys(list(history.get("ids") or []) + returned))[-_FLOW_HISTORY_LIMIT:]


async def _store_leftover(
    user_id: int, history: dict, delivered: list, leftover: list, ready: dict, limit: int
) -> None:
    """Невыданный остаток пула — готовой порцией под историю после выдачи.

    Следующая выдача возьмёт из него без расчёта, с новыми сигналами сессии.
    Мелкий остаток не храним: flow-warmer как раз считает свежий пул.
    """
    if len(leftover) < limit:
        return
    context = _ranking_context(user_id, {"ids": _history_ids_after(history, delivered)})
    await set_cache_async(
        _ready_key(user_id),
        {
            **ready,
            "context": context,
            "items": leftover,
        },
        expire=_READY_TTL,
    )


# Близость к любимым артистам: соседи из Last.fm artist.getSimilar (кэш 7 дней
# в mainstream). Якорей не больше _PROXIMITY_ANCHORS, соседей на якорь —
# _PROXIMITY_NEIGHBOURS; место соседа в списке даёт 1 / (1 + rank / 10).
_PROXIMITY_ANCHORS = 12
_PROXIMITY_NEIGHBOURS = 30
_PROXIMITY_WAIT = 2.0


async def _artist_proximity(anchors, *, fetch: bool, timeout: float) -> dict:
    """{primary_artist_key: близость в (0, 1]}; сам якорь — 1.0.

    fetch=False — только кэш (живая выдача под нагрузкой). Не успевшие за
    timeout запросы дочитываются в фоне и попадут в следующий расчёт.
    """
    anchors = list(dict.fromkeys(a for a in anchors if a))[:_PROXIMITY_ANCHORS]
    if not anchors:
        return {}
    getter = mainstream.similar_artists if fetch and mainstream.available() else (
        mainstream.cached_similar_artists
    )
    tasks = [asyncio.ensure_future(getter(anchor)) for anchor in anchors]
    done, _pending = await asyncio.wait(tasks, timeout=timeout)
    proximity: dict = {}
    for anchor, task in zip(anchors, tasks):
        proximity[primary_artist_key(anchor)] = 1.0
        if task not in done or task.cancelled() or task.exception() is not None:
            continue
        for rank, name in enumerate((task.result() or [])[:_PROXIMITY_NEIGHBOURS]):
            key = primary_artist_key(name)
            value = 1.0 / (1.0 + rank / 10.0)
            if key and value > proximity.get(key, 0.0):
                proximity[key] = value
    return proximity


def _release_request_session(db: Session, user: User) -> None:
    """Отпустить соединение сессии запроса, сохранив юзера пригодным к чтению.

    Поля дочитываем здесь (после коммита last_seen они могли истечь), затем
    отсоединяем юзера: rollback иначе снова пометил бы их истёкшими, и первое
    же чтение в async-коде сходило бы в БД синхронно, из event loop. rollback,
    а не close: сессия остаётся рабочей для живого пути.
    """
    for name in ("id", "username", "is_active", "excluded_artists", "discovery_ratio"):
        getattr(user, name, None)
    if user in db:
        db.expunge(user)
    db.rollback()


async def _flow_response(mix: list, response: Response, *, encoded: bool) -> Response:
    """JSON-ответ потока с названиями оригиналов (censorship.apply_overrides).

    Ответ собирается здесь, а не сериализацией FastAPI: jsonable_encoder
    обходил каждое поле каждого трека и был самой дорогой частью выдачи
    готовой порции (~14 из ~50 мс CPU, замер 2026-10-13). Готовая порция уже
    чистый JSON (пришла из Redis) — её сразу в json.dumps; живую сначала через
    jsonable_encoder, как раньше.
    """
    try:
        mix = await censorship.apply_overrides(mix)
    except Exception:  # noqa: BLE001 — выдача важнее подмены названий
        logger.exception("censor overrides in get_flow failed")
    content = mix if encoded else jsonable_encoder(mix)
    headers = {
        name: value
        for name, value in response.headers.items()
        if name in ("cache-control", "server-timing")
    }
    return Response(
        content=json.dumps(content, ensure_ascii=False, separators=(",", ":")),
        media_type="application/json",
        headers=headers,
    )


# Server-Timing видит только клиент; доля готовых выдач на проде — по этой
# строке. Бэкенд logging не настраивает (в gunicorn до stderr доходят только
# WARNING+ через lastResort), поэтому у логгера свой обработчик.
_served_logger = logging.getLogger("flow.served")
if not _served_logger.handlers:
    _served_handler = logging.StreamHandler()
    _served_handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    )
    _served_logger.addHandler(_served_handler)
    _served_logger.setLevel(logging.INFO)
    _served_logger.propagate = False


def _log_served(user_id: int, path: str, ready_state: str, mix: list, started: float) -> None:
    _served_logger.info(
        "flow served user=%s path=%s ready=%s items=%d %.0fms",
        user_id, path, ready_state, len(mix), (time.perf_counter() - started) * 1000,
    )


@router.get("/flow")
async def get_flow(
    request: Request,
    response: Response,
    limit: int = Query(8, ge=5, le=50),
    exclude: str = Query("", max_length=4000),
    hour: Optional[int] = Query(None, ge=0, le=23),
    sess: str = Query("", max_length=4000),
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db),
):
    """Порция персонального потока. exclude — id уже находящихся в очереди,
    sess — что юзер сделал с последними треками волны (app/flow_session.py)."""
    global _live_network_inflight, _live_waiting
    # Ответ уникален для каждого запроса — кэшировать нельзя ни на секунду
    # (подробно — в _compute_flow).
    response.headers["Cache-Control"] = "no-store"
    # Соединение, взятое авторизацией (SELECT юзера), отпускаем сразу: дальше
    # каждое обращение к БД берёт своё в треде и тут же возвращает. Иначе под
    # пиком запрос держал одно соединение и ждал второе (телеметрия), и при
    # 25 одновременных /flow на воркер пул (15+15) вставал до таймаута 30 с.
    started = time.perf_counter()
    await asyncio.to_thread(_release_request_session, db, current_user)
    user_id = current_user.id
    excluded_artists = list(current_user.excluded_artists or [])
    history = None
    if _FLOW_PRECOMPUTE:
        timings: list = []
        stage = time.perf_counter()
        history = await _load_flow_history(db, user_id)
        timings.append(("load", time.perf_counter() - stage))
        stage = time.perf_counter()
        ready, ready_state = await _take_ready_portion(
            db,
            user_id,
            excluded_artists,
            history,
            limit,
            exclude,
            base_url=str(request.base_url).rstrip("/"),
        )
        timings.append(("take", time.perf_counter() - stage))
        if ready is not None:
            pool, scores, features, matched, ready_payload = ready
            stage = time.perf_counter()
            items, features = await _session_select(
                pool,
                features,
                limit=limit,
                user_id=user_id,
                history=history,
                session=sess,
            )
            timings.append(("select", time.perf_counter() - stage))
            chosen = {_flow_item_identity(item) for item in items}
            leftover = [item for item in pool if _flow_item_identity(item) not in chosen]
            telemetry_bind = db.get_bind()
            db.close()
            mix = await _deliver_portion(
                request=request,
                user_id=user_id,
                limit=limit,
                hour=hour,
                exclude=exclude,
                mix=items,
                scores=scores,
                features=features,
                history=history,
                telemetry_bind=telemetry_bind,
                request_id=new_request_id(),
                timings=timings,
                schedule_matches=False,
                # Порядок mix — уже окончательный (мгновенный старт сделан
                # до записи истории), под него и считается контекст остатка.
                after_history=lambda delivered: _store_leftover(
                    user_id, history, delivered, leftover, ready_payload, limit
                ),
            )
            # Предрасчёт поставил матчи только голове пула (matched_ids).
            already = set(ready_payload.get("matched_ids") or []) if matched else set()
            unmatched = [item for item in mix if _flow_item_identity(item) not in already]
            if unmatched:
                ytdlp._schedule_audio_matches(unmatched)
            response.headers["Server-Timing"] = ", ".join(
                [f"{name};dur={seconds * 1000:.0f}" for name, seconds in timings]
                + ["flow;desc=ready"]
            )
            _log_served(user_id, "ready", "hit", mix, started)
            return await _flow_response(mix, response, encoded=True)
    else:
        ready_state = "off"
    # Живой расчёт — в очередь _live_semaphore. Сеть — только когда очереди
    # нет и сетевых расчётов меньше _FLOW_LIVE_NETWORK_SLOTS: под пиком веер
    # провайдеров одного юзера отнимал бы секунды CPU у всех остальных.
    # Порцию из одного кэша потом всё равно улучшит предрасчёт.
    _live_waiting += 1
    try:
        await _live_semaphore().acquire()
    finally:
        _live_waiting -= 1
    cache_only = _live_waiting > 0 or _live_network_inflight >= _FLOW_LIVE_NETWORK_SLOTS
    token = _pool_cache_only.set(cache_only)
    if not cache_only:
        _live_network_inflight += 1
    try:
        mix = await _compute_flow(
            request, response, limit, exclude, hour, current_user, db,
            mode="live", history=history, session=sess,
        )
    finally:
        _pool_cache_only.reset(token)
        if not cache_only:
            _live_network_inflight -= 1
        _live_semaphore().release()
    timing = response.headers.get("Server-Timing")
    response.headers["Server-Timing"] = ", ".join(
        part
        for part in (
            timing,
            f"flow;desc={'cache' if cache_only else 'live'}",
            f"ready;desc={ready_state}",
        )
        if part
    )
    _log_served(user_id, "cache" if cache_only else "live", ready_state, mix, started)
    return await _flow_response(mix, response, encoded=False)
