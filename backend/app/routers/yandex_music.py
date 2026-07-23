"""Нативная интеграция с Yandex Music через API.

Использует пакет yandex-music для прямого доступа к API Yandex Music.
Обходит CAPTCHA путём использования OAuth-токена вместо yt-dlp.

Требования:
- Установить пакет: pip install yandex-music
- Получить OAuth-токен: https://github.com/MarshalX/yandex-music/blob/main/docs/authentication.md
"""

import asyncio
import logging
import os
from typing import List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel

from app.dependencies import get_current_active_user

logger = logging.getLogger(__name__)

router = APIRouter()

# Конфигурация Yandex Music
YANDEX_MUSIC_TOKEN = os.getenv("YANDEX_MUSIC_TOKEN", "")

# Глобальный клиент (ленивая инициализация)
_client = None


class YandexMusicTrack(BaseModel):
    """Модель трека из Yandex Music."""
    id: str
    title: str
    artist: str
    album: Optional[str] = None
    duration: int = 0
    cover_url: Optional[str] = None
    stream_url: Optional[str] = None


def _get_client():
    """Получает или создаёт клиент Yandex Music."""
    global _client

    if _client is not None:
        return _client

    if not YANDEX_MUSIC_TOKEN:
        logger.warning("YANDEX_MUSIC_TOKEN не задан — интеграция с Yandex Music отключена")
        return None

    try:
        from yandex_music import Client

        _client = Client(token=YANDEX_MUSIC_TOKEN)
        _client.init()
        logger.info("Yandex Music клиент инициализирован")
        return _client
    except Exception as e:
        logger.error("Ошибка инициализации Yandex Music клиента: %s", e)
        _client = None
        return None


async def _get_client_async():
    """Асинхронное получение клиента (через to_thread)."""
    return await asyncio.to_thread(_get_client)


def _extract_track_info(track) -> Optional[YandexMusicTrack]:
    """Извлекает информацию о треке из объекта Yandex Music."""
    try:
        # Получаем артистов
        artists = []
        if hasattr(track, 'artists') and track.artists:
            artists = [a.name for a in track.artists if hasattr(a, 'name')]
        artist_str = ", ".join(artists) if artists else "Unknown Artist"

        # Получаем альбом
        album = None
        if hasattr(track, 'albums') and track.albums:
            album = track.albums[0].title if hasattr(track.albums[0], 'title') else None

        # Получаем обложку
        cover_url = None
        if hasattr(track, 'cover_uri') and track.cover_uri:
            cover_url = f"https://{track.cover_uri}".replace("{size}", "600x600")

        # Получаем длительность (в миллисекундах)
        duration = 0
        if hasattr(track, 'duration_ms') and track.duration_ms:
            duration = track.duration_ms // 1000

        return YandexMusicTrack(
            id=str(track.id),
            title=track.title or "Unknown",
            artist=artist_str,
            album=album,
            duration=duration,
            cover_url=cover_url,
        )
    except Exception as e:
        logger.error("Ошибка извлечения информации о треке: %s", e)
        return None


async def search_yandex_music(
    request: Request,
    query: str,
    limit: int = 20,
) -> List[YandexMusicTrack]:
    """Поиск треков в Yandex Music."""
    client = await _get_client_async()
    if client is None:
        return []

    try:
        # Выполняем поиск в отдельном потоке
        result = await asyncio.to_thread(
            client.search,
            query,
            page=0,
            nococrrect=False,
        )

        if not result or not hasattr(result, 'tracks') or not result.tracks:
            return []

        tracks = []
        for track in result.tracks.results[:limit]:
            track_info = _extract_track_info(track)
            if track_info:
                tracks.append(track_info)

        return tracks
    except Exception as e:
        logger.error("Ошибка поиска в Yandex Music: %s", e)
        return []


async def get_album_tracks(
    request: Request,
    album_id: str,
) -> Tuple[Optional[str], Optional[str], List[YandexMusicTrack]]:
    """Получает треки альбома из Yandex Music."""
    client = await _get_client_async()
    if client is None:
        raise HTTPException(
            status_code=503,
            detail="Yandex Music API недоступен. Задайте YANDEX_MUSIC_TOKEN."
        )

    try:
        # Получаем альбом
        album = await asyncio.to_thread(client.albums, album_id)
        if not album:
            raise HTTPException(status_code=404, detail="Альбом не найден")

        # Получаем треки альбома
        tracks = []
        if hasattr(album, 'volumes') and album.volumes:
            for volume in album.volumes:
                for track in volume:
                    track_info = _extract_track_info(track)
                    if track_info:
                        tracks.append(track_info)

        # Обложка альбома
        cover_url = None
        if hasattr(album, 'cover_uri') and album.cover_uri:
            cover_url = f"https://{album.cover_uri}".replace("{size}", "600x600")

        return album.title, cover_url, tracks
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Ошибка получения альбома %s: %s", album_id, e)
        raise HTTPException(status_code=500, detail="Ошибка получения данных из Yandex Music")


async def get_artist_tracks(
    request: Request,
    artist_id: str,
) -> Tuple[Optional[str], Optional[str], List[YandexMusicTrack]]:
    """Получает треки артиста из Yandex Music."""
    client = await _get_client_async()
    if client is None:
        raise HTTPException(
            status_code=503,
            detail="Yandex Music API недоступен. Задайте YANDEX_MUSIC_TOKEN."
        )

    try:
        # Получаем информацию об артисте
        artist = await asyncio.to_thread(client.artists, artist_id)
        if not artist:
            raise HTTPException(status_code=404, detail="Артист не найден")

        # Получаем треки артиста
        artist_tracks = await asyncio.to_thread(client.artists_tracks, artist_id)
        tracks = []
        if artist_tracks and hasattr(artist_tracks, 'tracks'):
            for track in artist_tracks.tracks[:100]:  # Ограничиваем 100 треками
                track_info = _extract_track_info(track)
                if track_info:
                    tracks.append(track_info)

        return artist.name, None, tracks
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Ошибка получения треков артиста %s: %s", artist_id, e)
        raise HTTPException(status_code=500, detail="Ошибка получения данных из Yandex Music")


async def get_playlist_tracks(
    request: Request,
    user_id: str,
    playlist_id: str,
) -> Tuple[Optional[str], Optional[str], List[YandexMusicTrack]]:
    """Получает треки плейлиста из Yandex Music."""
    client = await _get_client_async()
    if client is None:
        raise HTTPException(
            status_code=503,
            detail="Yandex Music API недоступен. Задайте YANDEX_MUSIC_TOKEN."
        )

    try:
        # Получаем плейлист
        playlist = await asyncio.to_thread(
            client.users_playlists,
            playlist_id,
            user_id
        )
        if not playlist:
            raise HTTPException(status_code=404, detail="Плейлист не найден")

        # Получаем треки плейлиста
        playlist_tracks_result = await asyncio.to_thread(
            client.users_playlists_tracks,
            playlist_id,
            user_id
        )

        tracks = []
        if playlist_tracks_result:
            for track in playlist_tracks_result[:1000]:  # Ограничиваем
                track_info = _extract_track_info(track)
                if track_info:
                    tracks.append(track_info)

        # Обложка плейлиста
        cover_url = None
        if hasattr(playlist, 'cover') and playlist.cover:
            if hasattr(playlist.cover, 'uri') and playlist.cover.uri:
                cover_url = f"https://{playlist.cover.uri}".replace("{size}", "600x600")

        return playlist.title, cover_url, tracks
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Ошибка получения плейлиста %s/%s: %s", user_id, playlist_id, e)
        raise HTTPException(status_code=500, detail="Ошибка получения данных из Yandex Music")


async def get_user_likes(
    request: Request,
    user_id: str,
) -> Tuple[Optional[str], Optional[str], List[YandexMusicTrack]]:
    """Получает избранное/лайки пользователя из Yandex Music."""
    client = await _get_client_async()
    if client is None:
        raise HTTPException(
            status_code=503,
            detail="Yandex Music API недоступен. Задайте YANDEX_MUSIC_TOKEN."
        )

    try:
        # Получаем лайки пользователя
        likes = await asyncio.to_thread(client.users_likes_tracks)
        if not likes or not hasattr(likes, 'library') or not likes.library:
            return "Избранное (Yandex Music)", None, []

        tracks = []
        # Получаем информацию о каждом треке
        track_ids = likes.library[:500]  # Ограничиваем

        if track_ids:
            # Получаем треки по ID
            full_tracks = await asyncio.to_thread(
                client.tracks,
                [str(t.track_id) for t in track_ids if hasattr(t, 'track_id')]
            )
            if full_tracks:
                for track in full_tracks:
                    track_info = _extract_track_info(track)
                    if track_info:
                        tracks.append(track_info)

        return "Избранное (Yandex Music)", None, tracks
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Ошибка получения лайков пользователя %s: %s", user_id, e)
        raise HTTPException(status_code=500, detail="Ошибка получения данных из Yandex Music")


@router.get("/search", response_model=List[YandexMusicTrack])
async def search_endpoint(
    request: Request,
    q: str = Query(..., min_length=1),
    limit: int = Query(20, ge=1, le=50),
):
    """Поиск треков в Yandex Music."""
    return await search_yandex_music(request, q, limit)


@router.get("/album/{album_id}")
async def get_album(
    request: Request,
    album_id: str,
):
    """Получает информацию об альбоме и его треках."""
    title, cover, tracks = await get_album_tracks(request, album_id)
    return {
        "title": title,
        "cover_url": cover,
        "tracks": tracks,
        "track_count": len(tracks),
    }


@router.get("/artist/{artist_id}")
async def get_artist(
    request: Request,
    artist_id: str,
):
    """Получает информацию об артисте и его треках."""
    name, cover, tracks = await get_artist_tracks(request, artist_id)
    return {
        "title": name,
        "cover_url": cover,
        "tracks": tracks,
        "track_count": len(tracks),
    }


@router.get("/playlist/{user_id}/{playlist_id}")
async def get_playlist(
    request: Request,
    user_id: str,
    playlist_id: str,
):
    """Получает информацию о плейлисте и его треках."""
    title, cover, tracks = await get_playlist_tracks(request, user_id, playlist_id)
    return {
        "title": title,
        "cover_url": cover,
        "tracks": tracks,
        "track_count": len(tracks),
    }


@router.get("/likes/{user_id}")
async def get_likes(
    request: Request,
    user_id: str,
):
    """Получает избранное/лайки пользователя."""
    title, cover, tracks = await get_user_likes(request, user_id)
    return {
        "title": title,
        "cover_url": cover,
        "tracks": tracks,
        "track_count": len(tracks),
    }


@router.get("/status")
async def check_status():
    """Проверяет статус интеграции с Yandex Music."""
    client = await _get_client_async()
    return {
        "configured": bool(YANDEX_MUSIC_TOKEN),
        "connected": client is not None,
        "token_set": bool(YANDEX_MUSIC_TOKEN),
    }
