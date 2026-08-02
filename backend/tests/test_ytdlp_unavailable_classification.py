"""404 vs 503 при резолве YouTube Music.

Ложный 404 необратим: фронт по нему делает чистый скип (см. Player.jsx,
giveUp(true)), поэтому пометить живой трек мёртвым хуже, чем лишний ретрай.
Проверено на живых данных: генуинно недоступный ролик (удалённый,
несуществующий, приватный) ВСЕГДА приходит с маркером «Video unavailable» в
логгере yt-dlp. Значит «форматов нет и причина не названа» — это наш сбой
(PO-token/смена плеера/обрыв), и он обязан давать transient → 503.
"""

import asyncio

import pytest

from app.routers import ytdlp


def _resolve(monkeypatch, extract):
    """Прогоняет _resolve_via_ytdlp с подменённым _extract_with_clients.

    asyncio.run, а не get_event_loop().run_until_complete: другие тесты набора
    оставляют петлю закрытой, и переиспользование глобальной падало бы на
    «Event loop is closed» в зависимости от порядка запуска.
    """
    monkeypatch.setattr(ytdlp, "_extract_with_clients", extract)
    return asyncio.run(ytdlp._resolve_via_ytdlp("VIDEOID"))


def _no_formats(**extra):
    return {"id": "VIDEOID", "formats": [], **extra}


def test_no_reason_reported_is_transient(monkeypatch):
    """Форматов нет, но ни один клиент не назвал причину → 503, не 404."""
    with pytest.raises(ytdlp.TransientResolveError):
        _resolve(monkeypatch, lambda vid, clients: (_no_formats(), True, False))


def test_confirmed_marker_wins_over_other_clients_failure(monkeypatch):
    """Один клиент подтвердил недоступность, другой просто сбойнул → 404.

    Без отдельного флага saw_unavailable сбой второго клиента (transient=True)
    затирал бы подтверждённый ответ YouTube, и мёртвый ролик висел бы в вечном
    503 с бесконечными ретраями на фронте.
    """
    primary = ytdlp._CLIENT_CANDIDATES[0]

    def extract(vid, clients):
        if clients == primary:
            return _no_formats(), False, False  # маркер найден
        return _no_formats(), True, False  # чужой сбой

    with pytest.raises(ytdlp.TrackUnavailable):
        _resolve(monkeypatch, extract)


def test_needs_auth_is_unavailable(monkeypatch):
    """Age-gate/login-only — перманентно даже без маркера: ретрай бесполезен."""
    with pytest.raises(ytdlp.TrackUnavailable):
        _resolve(
            monkeypatch,
            lambda vid, clients: (_no_formats(availability="needs_auth"), True, False),
        )


def test_bot_check_beats_unavailable(monkeypatch):
    """Bot-check — rate-limit по IP, а не свойство ролика: длинный бэкофф."""
    with pytest.raises(ytdlp.BotCheckError):
        _resolve(monkeypatch, lambda vid, clients: (_no_formats(), True, True))


def test_unavailable_markers_classify_real_reasons():
    """Тексты, которые yt-dlp реально пишет для мёртвых роликов."""
    reason = "[youtube] Video unavailable | No video formats found!"
    assert ytdlp.is_track_unavailable_error(Exception(reason))
    assert not ytdlp.is_track_unavailable_error(Exception("HTTP Error 429: Too Many"))
    assert not ytdlp.is_track_unavailable_error(Exception("read timed out"))


def test_bot_check_not_treated_as_unavailable():
    """У bot-check в тексте есть "sign in", но ролик при этом жив."""
    msg = "Sign in to confirm you’re not a bot"
    assert ytdlp.is_bot_check_error(msg)
    assert not ytdlp.is_track_unavailable_error(Exception(msg))
