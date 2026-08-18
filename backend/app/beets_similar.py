"""Похожие треки по НАЗВАНИЮ другого трека — Last.fm через клиент beets.

Единственная похожесть на уровне ТРЕКА, которая была в потоке, — радио YT Music
(flow._radio_pool). Оно строится от videoId, поэтому у пользователя, чья
библиотека целиком в SoundCloud, недоступно в принципе: сеять радио нечем, и
разведка сваливается в дискографию тех артистов, которых юзер и так выбрал сам
(см. модульный docstring flow.py). Last.fm ищет похожие треки по ПАРЕ
артист+название, то есть по строкам, — и работает одинаково для любого
провайдера.

Транспорт — pylast, зависимость beets: тот же клиент, которым ходит плагин
lastgenre (``beetsplug.lastgenre.client.LASTFM``). Оттуда же берётся и
встроенный ключ ``beets.plugins.LASTFM_KEY``, но рассчитывать на него нельзя:
на момент интеграции Last.fm отвечает на него "Access Denied - You cannot
access this service" даже на собственных жанровых запросах beets. Поэтому свой
ключ в ``LASTFM_API_KEY`` (бесплатный, https://www.last.fm/api/account/create),
а встроенный остаётся фолбэком — если beets свой когда-нибудь починит,
источник заработает сам.

Ключа нет или Last.fm отказал — модуль возвращает пустой список, и поток
работает ровно как до интеграции: источник резервный, а не обязательный.
"""

import asyncio
import logging
import os
from typing import List, Tuple

logger = logging.getLogger(__name__)

# Отсечка по match (0..1) из ответа Last.fm. Хвост выдачи — уже почти
# случайные треки: на них похожесть держится на единичных совместных
# прослушиваниях, и в поток они несут шум, а не новое.
_MIN_MATCH = 0.1

_network = None
_init_failed = False


def _get_network():
    """pylast-сеть с нашим ключом (или встроенным ключом beets). Один раз."""
    global _network, _init_failed
    if _network is not None or _init_failed:
        return _network

    try:
        import pylast

        key = os.getenv("LASTFM_API_KEY") or ""
        if not key:
            # Ключ beets — именно фолбэк: см. модульный docstring, сейчас он
            # отвечает Access Denied, так что без своего ключа источник
            # фактически выключен. Это осознанно: молча тащить чужой мёртвый
            # ключ в лог на каждый запрос хуже, чем один раз сказать почему.
            from beets import plugins

            key = getattr(plugins, "LASTFM_KEY", "") or ""
            logger.info(
                "LASTFM_API_KEY not set, falling back to the beets built-in key "
                "(known to be rejected by Last.fm — similar tracks will be empty)"
            )
        if not key:
            _init_failed = True
            return None
        _network = pylast.LastFMNetwork(api_key=key)
    except Exception:  # noqa: BLE001
        # Образ без pylast/beets — не повод ронять поток.
        _init_failed = True
        logger.warning("last.fm similar tracks unavailable (pylast/beets missing)")
    return _network


def available() -> bool:
    """Клиент собран и по нему можно спрашивать похожие треки?"""
    return _get_network() is not None


def reset_cache() -> None:
    """Сбрасывает собранный клиент — нужен тестам, подменяющим сеть."""
    global _network, _init_failed
    _network = None
    _init_failed = False


def _artist_name(track) -> str:
    """Имя артиста из pylast.Track.

    ``get_similar`` собирает Track из уже извлечённых строк, поэтому обращение
    к артисту сетевого запроса не делает. Тип при этом зависит от версии
    pylast (строка либо Artist), а ``get_name(properly_capitalized=True)`` —
    это уже отдельный запрос на каждый трек, чего нам категорически не надо.
    """
    try:
        artist = track.get_artist()
    except Exception:  # noqa: BLE001
        return ""
    if artist is None:
        return ""
    if isinstance(artist, str):
        return artist
    try:
        return artist.get_name() or ""
    except Exception:  # noqa: BLE001
        return ""


def similar_tracks(artist: str, title: str, limit: int = 20) -> List[Tuple[str, str]]:
    """Похожие треки на (artist, title): [(артист, название), ...], БЛОКИРУЮЩАЯ.

    Порядок — как отдал Last.fm, то есть по убыванию похожести. Названия сырые:
    играбельными их делает уже вызывающий, разрешая их у провайдеров
    (flow._lastfm_pool). Любая ошибка сети/ключа — пустой список, без
    исключений наружу: источник резервный.
    """
    net = _get_network()
    if net is None or not artist or not title:
        return []

    try:
        found = net.get_track(artist, title).get_similar(limit=limit)
    except Exception as exc:  # noqa: BLE001
        # pylast.WSError («нет такого трека», «Access Denied»), таймауты сети,
        # сломанный XML — всё это штатный отказ резервного источника.
        logger.warning("last.fm similar failed for %s - %s: %s", artist, title, exc)
        return []

    pairs: List[Tuple[str, str]] = []
    seen = set()
    for item in found:
        try:
            match = float(item.match or 0)
        except (TypeError, ValueError):
            match = 0.0
        if match < _MIN_MATCH:
            continue
        track = item.item
        name = ""
        try:
            name = track.get_title() or ""
        except Exception:  # noqa: BLE001
            continue
        who = _artist_name(track)
        if not name or not who:
            continue
        key = (who.strip().lower(), name.strip().lower())
        if key in seen:
            continue
        seen.add(key)
        pairs.append((who, name))
    return pairs


async def similar_tracks_async(
    artist: str, title: str, limit: int = 20
) -> List[Tuple[str, str]]:
    """То же, но не блокируя event loop: pylast синхронный."""
    return await asyncio.to_thread(similar_tracks, artist, title, limit)
