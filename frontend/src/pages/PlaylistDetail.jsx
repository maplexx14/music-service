import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { usePlayerStore, trackIntentHandlers } from '../store/playerStore'
import { Play, Heart, MoreVertical, Plus } from 'lucide-react'
import api from '../services/api'
import Spinner from '../components/Spinner'
import ArtistLink from '../components/ArtistLink'
import { useInfiniteScroll } from '../hooks/useInfiniteScroll'
import { toast } from '../store/toastStore'
import defaultCover from '../assets/default-cover.png'
import { resolveCoverUrl, handleCoverError } from '../utils/media'
import './PlaylistDetail.css'

const TRACKS_PAGE_SIZE = 20

function PlaylistDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [playlist, setPlaylist] = useState(null)
  const [loading, setLoading] = useState(true)
  const [totalTracks, setTotalTracks] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  // Упавший запрос гасит автоподгрузку и возвращает кнопку: иначе наблюдатель
  // пересоберётся, снова упрётся в видимый маячок и страница уйдёт в цикл
  // падающих запросов.
  const [loadError, setLoadError] = useState(false)
  const [myPlaylists, setMyPlaylists] = useState([])
  const [menuTrackId, setMenuTrackId] = useState(null)
  // Атомарные селекторы вместо подписки на весь store: страница со списком
  // треков больше не перерисовывается на каждом тике currentTime (~4/сек).
  const playPlaylist = usePlayerStore((s) => s.playPlaylist)
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const likedTrackIds = usePlayerStore((s) => s.likedTrackIds)
  const toggleTrackLike = usePlayerStore((s) => s.toggleTrackLike)
  const fetchLikedTracks = usePlayerStore((s) => s.fetchLikedTracks)

  useEffect(() => {
    fetchPlaylist()
    fetchLikedTracks()
  }, [id])

  useEffect(() => {
    // Закрываем меню «добавить в плейлист» по клику в любом другом месте.
    if (menuTrackId === null) return
    const close = () => setMenuTrackId(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [menuTrackId])

  const fetchPlaylist = async () => {
    try {
      const response = await api.get(`/playlists/${id}`, {
        params: { skip: 0, limit: TRACKS_PAGE_SIZE },
      })
      setPlaylist(response.data)
      setTotalTracks(Number(response.headers['x-total-count']) || response.data.tracks.length)
    } catch (error) {
      console.error('Error fetching playlist:', error)
      navigate('/playlists')
    } finally {
      setLoading(false)
    }
  }

  const handleLoadMore = async () => {
    if (loadingMore) return
    setLoadingMore(true)
    setLoadError(false)
    try {
      const response = await api.get(`/playlists/${id}`, {
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

  const handlePlay = () => {
    if (playlist.tracks && playlist.tracks.length > 0) {
      playPlaylist(playlist.tracks, 0)
    }
  }

  const handlePlayTrack = (track, index) => {
    playPlaylist(playlist.tracks, index)
  }

  const handleToggleLike = async (track, e) => {
    e.stopPropagation()
    try {
      await toggleTrackLike(track.id)
    } catch (error) {
      console.error('Error toggling like:', error)
      toast.error('Не удалось обновить понравившиеся')
    }
  }

  const handleOpenMenu = async (track, e) => {
    e.stopPropagation()
    if (menuTrackId === track.id) {
      setMenuTrackId(null)
      return
    }
    setMenuTrackId(track.id)
    if (myPlaylists.length === 0) {
      try {
        const { data } = await api.get('/playlists/me')
        setMyPlaylists(data)
      } catch (error) {
        console.error('Error fetching my playlists:', error)
      }
    }
  }

  const handleAddToPlaylist = async (track, target, e) => {
    e.stopPropagation()
    setMenuTrackId(null)
    try {
      await api.post(`/playlists/${target.id}/tracks/${track.id}`, null, {
        skipErrorToast: true,
      })
      toast.success(`Добавлено в «${target.name}»`)
    } catch (error) {
      if (error.response?.status === 400) {
        toast.error('Трек уже есть в этом плейлисте')
      } else {
        console.error('Error adding track to playlist:', error)
        toast.error('Не удалось добавить трек')
      }
    }
  }

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
            <span>{playlist.owner?.username || 'Пользователь'}</span>
            {totalTracks > 0 && (
              <>
                <span>•</span>
                <span>{totalTracks} треков</span>
              </>
            )}
          </div>
          <div className="playlist-actions">
            <button className="play-button-large" onClick={handlePlay}>
              <Play size={24} fill="currentColor" />
              Воспроизвести
            </button>
            <button className="action-button">
              <Heart size={20} />
            </button>
            <button className="action-button">
              <MoreVertical size={20} />
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
                const isLiked = likedTrackIds.includes(track.id)
                return (
                <tr
                  key={track.id}
                  className={`track-row${isCurrent ? ' playing' : ''}`}
                  onClick={() => handlePlayTrack(track, index)}
                  {...trackIntentHandlers(track)}
                >
                  <td className="track-number">
                    {isCurrent ? (
                      <span className={`now-playing-bars${isPlaying ? '' : ' paused'}`}>
                        <span /><span /><span />
                      </span>
                    ) : (
                      index + 1
                    )}
                  </td>
                  <td className="track-name-cell">
                    <img
                      src={resolveCoverUrl(track.cover_url) || defaultCover}
                      alt={track.title}
                      className="track-table-cover"
                      loading="lazy"
                      decoding="async"
                      onError={handleCoverError}
                    />
                    <div>
                      <div className="track-name">{track.title}</div>
                      <ArtistLink artist={track.artist} className="track-artist" />
                    </div>
                  </td>
                  <td className="track-album">{track.album || '-'}</td>
                  <td className="track-duration">
                    {Math.floor(track.duration / 60)}:{(track.duration % 60).toString().padStart(2, '0')}
                  </td>
                  <td className="track-actions-cell">
                    <button
                      type="button"
                      className={`track-action-btn${isLiked ? ' liked' : ''}`}
                      onClick={(e) => handleToggleLike(track, e)}
                      title={isLiked ? 'Убрать из понравившихся' : 'В понравившиеся'}
                      aria-label={isLiked ? 'Убрать из понравившихся' : 'В понравившиеся'}
                    >
                      <Heart size={18} fill={isLiked ? 'currentColor' : 'none'} />
                    </button>
                    <div className="add-to-playlist">
                      <button
                        type="button"
                        className="track-action-btn"
                        onClick={(e) => handleOpenMenu(track, e)}
                        title="Добавить в плейлист"
                        aria-label="Добавить в плейлист"
                      >
                        <Plus size={18} />
                      </button>
                      {menuTrackId === track.id && (
                        <div className="add-to-playlist-menu" onClick={(e) => e.stopPropagation()}>
                          {myPlaylists.filter((p) => String(p.id) !== String(id)).length > 0 ? (
                            myPlaylists
                              .filter((p) => String(p.id) !== String(id))
                              .map((p) => (
                                <button
                                  key={p.id}
                                  type="button"
                                  className="add-to-playlist-option"
                                  onClick={(e) => handleAddToPlaylist(track, p, e)}
                                >
                                  {p.name}
                                </button>
                              ))
                          ) : (
                            <div className="add-to-playlist-empty">Нет других плейлистов</div>
                          )}
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
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

export default PlaylistDetail
