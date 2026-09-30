import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePlayerStore } from '../store/playerStore'
import { Play, Shuffle } from 'lucide-react'
import api from '../services/api'
import { peekCache, writeCache, PLAYLIST_PAGE_SIZE } from '../services/pageCache'
import Spinner from '../components/Spinner'
import TrackTableRow from '../components/TrackTableRow'
import { useInfiniteScroll } from '../hooks/useInfiniteScroll'
import { toast } from '../store/toastStore'
import defaultCover from '../assets/default-cover.webp'
import { resolveCoverUrl, handleCoverError } from '../utils/media'
import './PlaylistDetail.css'

const TRACKS_PAGE_SIZE = PLAYLIST_PAGE_SIZE
const LIKED_CACHE_KEY = 'playlist:liked'

// «Понравившиеся» — это обычный плейлист (is_liked=true на бэке), поэтому
// интерфейс страницы полностью повторяет PlaylistDetail.
function LikedSongs() {
  const navigate = useNavigate()
  // Первая страница из прошлого захода рисуется сразу, свежая — фоном.
  const [playlist, setPlaylist] = useState(() => peekCache(LIKED_CACHE_KEY)?.playlist ?? null)
  const [loading, setLoading] = useState(() => !peekCache(LIKED_CACHE_KEY))
  const [totalTracks, setTotalTracks] = useState(() => peekCache(LIKED_CACHE_KEY)?.total ?? 0)
  const [loadingMore, setLoadingMore] = useState(false)
  // Упавший запрос гасит автоподгрузку и возвращает кнопку: иначе наблюдатель
  // пересоберётся, снова упрётся в видимый маячок и страница уйдёт в цикл
  // падающих запросов.
  const [loadError, setLoadError] = useState(false)
  // Взведён, пока «Перемешать» добирает окно треков перед стартом (см.
  // shufflePlaylist в store) — иначе нажатие ничем не отвечает.
  const [shuffling, setShuffling] = useState(false)
  // Атомарные селекторы вместо подписки на весь store: страница со списком
  // треков больше не перерисовывается на каждом тике currentTime (~4/сек).
  const playPlaylist = usePlayerStore((s) => s.playPlaylist)
  const shufflePlaylist = usePlayerStore((s) => s.shufflePlaylist)
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const likedTrackIds = usePlayerStore((s) => s.likedTrackIds)
  const toggleTrackLike = usePlayerStore((s) => s.toggleTrackLike)
  const fetchLikedTracks = usePlayerStore((s) => s.fetchLikedTracks)

  useEffect(() => {
    fetchPlaylist()
    fetchLikedTracks()
  }, [])

  // Кэш следует за списком (в том числе за снятыми здесь лайками), но хранит
  // только первую страницу — остальное догружается прокруткой.
  useEffect(() => {
    if (loading || !playlist) return
    writeCache(LIKED_CACHE_KEY, {
      playlist: { ...playlist, tracks: playlist.tracks.slice(0, TRACKS_PAGE_SIZE) },
      total: totalTracks,
    })
  }, [playlist, totalTracks, loading])

  const fetchPlaylist = async () => {
    try {
      const response = await api.get('/playlists/me/liked', {
        params: { skip: 0, limit: TRACKS_PAGE_SIZE },
      })
      const fresh = response.data
      // Фоновое обновление не схлопывает уже догруженные страницы.
      setPlaylist((prev) =>
        prev && prev.tracks.length > fresh.tracks.length
          ? { ...fresh, tracks: [...fresh.tracks, ...prev.tracks.slice(fresh.tracks.length)] }
          : fresh
      )
      setTotalTracks(Number(response.headers['x-total-count']) || fresh.tracks.length)
    } catch (error) {
      console.error('Error fetching liked playlist:', error)
      if (!peekCache(LIKED_CACHE_KEY)) navigate('/playlists')
    } finally {
      setLoading(false)
    }
  }

  const handleLoadMore = async () => {
    if (loadingMore) return
    setLoadingMore(true)
    setLoadError(false)
    try {
      const response = await api.get('/playlists/me/liked', {
        params: { skip: playlist.tracks.length, limit: TRACKS_PAGE_SIZE },
      })
      setPlaylist((prev) => ({ ...prev, tracks: [...prev.tracks, ...response.data.tracks] }))
      setTotalTracks(Number(response.headers['x-total-count']) || totalTracks)
    } catch (error) {
      console.error('Error loading more tracks:', error)
      setLoadError(true)
      toast.error('Не удалось загрузить ещё треки')
    } finally {
      setLoadingMore(false)
    }
  }

  const hasMoreTracks = !!playlist && playlist.tracks.length < totalTracks
  // Следующая страница тянется сама, когда пользователь доскроллил до низа
  // списка. Кнопка остаётся только как способ повторить упавший запрос.
  const loadMoreRef = useInfiniteScroll(handleLoadMore, {
    enabled: hasMoreTracks && !loadingMore && !loadError,
  })

  // Очередь плеера — это то, что успела загрузить страница, а грузит она
  // постранично. Без пейджера воспроизведение вставало на последнем
  // загруженном треке: для плеера это выглядело как конец списка. Пейджер
  // говорит плееру, откуда дотянуть хвост самому, не дожидаясь прокрутки.
  const queuePager = () => ({ url: '/playlists/me/liked', total: totalTracks })

  const handlePlay = () => {
    if (playlist.tracks && playlist.tracks.length > 0) {
      playPlaylist(playlist.tracks, 0, null, queuePager())
    }
  }

  const handleShuffle = async () => {
    if (shuffling || !playlist.tracks || playlist.tracks.length === 0) return
    setShuffling(true)
    try {
      await shufflePlaylist(playlist.tracks, null, queuePager())
    } finally {
      setShuffling(false)
    }
  }

  const handlePlayTrack = (track, index) => {
    playPlaylist(playlist.tracks, index, null, queuePager())
  }

  const handleToggleLike = async (track, e) => {
    e.stopPropagation()
    try {
      await toggleTrackLike(track.id)
      setPlaylist((prev) => ({
        ...prev,
        tracks: prev.tracks.filter((t) => t.id !== track.id),
      }))
      setTotalTracks((prev) => Math.max(0, prev - 1))
    } catch (error) {
      console.error('Error toggling like:', error)
      toast.error('Не удалось обновить понравившиеся')
    }
  }

  // Свежие обработчики для мемоизированных строк (см. TrackTableRow):
  // ref стабилен, поэтому пересоздание функций на рендере строки не задевает.
  const rowActions = useRef(null)
  rowActions.current = {
    play: handlePlayTrack,
    toggleLike: handleToggleLike,
  }
  const likedSet = useMemo(() => new Set(likedTrackIds), [likedTrackIds])

  if (loading) {
    return (
      <div className="page-container">
        <Spinner />
      </div>
    )
  }

  if (!playlist) {
    return null
  }

  return (
    <div className="page-container">
      <div className="playlist-header">
        <img
          src={resolveCoverUrl(playlist.cover_url) || defaultCover}
          alt={playlist.name}
          className="playlist-header-cover"
          onError={handleCoverError}
        />
        <div className="playlist-header-info">
          <div className="playlist-type">Плейлист</div>
          <h1 className="playlist-title">{playlist.name}</h1>
          {playlist.description && (
            <p className="playlist-description">{playlist.description}</p>
          )}
          <div className="playlist-meta">
            {totalTracks > 0 && (
              <span>{totalTracks} треков</span>
            )}
          </div>
          <div className="playlist-actions shuffle-actions">
            <button className="play-button-large" onClick={handlePlay}>
              <Play size={24} fill="currentColor" />
              Воспроизвести
            </button>
            <button
              className="play-button-large secondary"
              onClick={handleShuffle}
              disabled={shuffling}
              title="Перемешать и воспроизвести"
            >
              <Shuffle size={20} />
              {shuffling ? 'Загрузка…' : 'Перемешать'}
            </button>
          </div>
        </div>
      </div>

      <div className="playlist-tracks">
        {playlist.tracks && playlist.tracks.length > 0 ? (
          <table className="tracks-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Название</th>
                <th>Альбом</th>
                <th>Длительность</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {playlist.tracks.map((track, index) => {
                const isCurrent = currentTrack?.id === track.id
                const isLiked = likedSet.has(track.id)
                return (
                  <TrackTableRow
                    key={track.id}
                    track={track}
                    index={index}
                    isCurrent={isCurrent}
                    isPlaying={isCurrent && isPlaying}
                    isLiked={isLiked}
                    actionsRef={rowActions}
                  />
                )
              })}
            </tbody>
          </table>
        ) : (
          <div className="empty-playlist">
            <p>В этом плейлисте пока нет треков</p>
          </div>
        )}
        {hasMoreTracks && (
          <div className="load-more-wrapper" ref={loadMoreRef}>
            {loadError ? (
              <button
                type="button"
                className="load-more-btn"
                onClick={handleLoadMore}
                disabled={loadingMore}
              >
                {loadingMore ? 'Загрузка…' : 'Показать ещё'}
              </button>
            ) : (
              <Spinner label="Загрузка треков…" />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default LikedSongs
