import { useEffect, useState } from 'react'
import { usePlayerStore } from '../store/playerStore'
import { Play, Heart, Plus } from 'lucide-react'
import api from '../services/api'
import Spinner from '../components/Spinner'
import { toast } from '../store/toastStore'
import defaultCover from '../assets/default-cover.png'
import { resolveCoverUrl, handleCoverError } from '../utils/media'
import './LikedSongs.css'
import './PlaylistDetail.css'

const PAGE_SIZE = 20

function LikedSongs() {
  const [tracks, setTracks] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [removingIds, setRemovingIds] = useState([])
  const [myPlaylists, setMyPlaylists] = useState([])
  const [menuTrackId, setMenuTrackId] = useState(null)
  const { playPlaylist, removeLike, currentTrack, isPlaying } = usePlayerStore()

  useEffect(() => {
    if (menuTrackId === null) return
    const close = () => setMenuTrackId(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [menuTrackId])

  useEffect(() => {
    fetchLikedTracks()
  }, [])

  const fetchLikedTracks = async () => {
    try {
      const response = await api.get('/tracks/me/liked', {
        params: { skip: 0, limit: PAGE_SIZE },
      })
      setTracks(response.data)
      setTotal(Number(response.headers['x-total-count']) || response.data.length)
    } catch (error) {
      console.error('Error fetching liked tracks:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleLoadMore = async () => {
    if (loadingMore) return
    setLoadingMore(true)
    try {
      const response = await api.get('/tracks/me/liked', {
        params: { skip: tracks.length, limit: PAGE_SIZE },
      })
      setTotal(Number(response.headers['x-total-count']) || total)
      setTracks((prev) => {
        // Защита от дублей, если список изменился между запросами.
        const known = new Set(prev.map((t) => t.id))
        return [...prev, ...response.data.filter((t) => !known.has(t.id))]
      })
    } catch (error) {
      console.error('Error loading more liked tracks:', error)
      toast.error('Не удалось загрузить треки')
    } finally {
      setLoadingMore(false)
    }
  }

  const handlePlay = () => {
    if (tracks.length > 0) {
      playPlaylist(tracks, 0)
    }
  }

  const handlePlayTrack = (track, index) => {
    playPlaylist(tracks, index)
  }

  const handleRemove = async (track, e) => {
    e.stopPropagation()
    if (removingIds.includes(track.id)) return

    setRemovingIds((prev) => [...prev, track.id])
    const previous = tracks
    // Оптимистично убираем из списка; при ошибке возвращаем.
    setTracks((prev) => prev.filter((t) => t.id !== track.id))
    setTotal((prev) => Math.max(0, prev - 1))
    try {
      await removeLike(track.id)
    } catch (error) {
      console.error('Error removing liked track:', error)
      setTracks(previous)
      setTotal((prev) => prev + 1)
      toast.error('Не удалось убрать трек из понравившихся')
    } finally {
      setRemovingIds((prev) => prev.filter((id) => id !== track.id))
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

  return (
    <div className="page-container">
      <div className="liked-header">
        <div className="liked-cover">
          <Heart size={64} fill="currentColor" />
        </div>
        <div className="liked-info">
          <div className="liked-type">Плейлист</div>
          <h1 className="liked-title">Понравившиеся</h1>
          <div className="liked-meta">
            <span>{total} треков</span>
          </div>
          <div className="liked-actions">
            <button className="play-button-large" onClick={handlePlay}>
              <Play size={24} fill="currentColor" />
              Воспроизвести
            </button>
          </div>
        </div>
      </div>

      <div className="liked-tracks">
        {tracks.length > 0 ? (
          <>
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
              {tracks.map((track, index) => {
                const isCurrent = currentTrack?.id === track.id
                return (
                <tr
                  key={track.id}
                  className={`track-row${isCurrent ? ' playing' : ''}`}
                  onClick={() => handlePlayTrack(track, index)}
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
                      onError={handleCoverError}
                    />
                    <div>
                      <div className="track-name">{track.title}</div>
                      <div className="track-artist">{track.artist}</div>
                    </div>
                  </td>
                  <td className="track-album">{track.album || '-'}</td>
                  <td className="track-duration">
                    {Math.floor(track.duration / 60)}:{(track.duration % 60).toString().padStart(2, '0')}
                  </td>
                  <td className="track-remove-cell">
                    <button
                      type="button"
                      className="track-remove-btn"
                      onClick={(e) => handleRemove(track, e)}
                      disabled={removingIds.includes(track.id)}
                      title="Убрать из понравившихся"
                      aria-label="Убрать из понравившихся"
                    >
                      <Heart size={18} fill="currentColor" />
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
                          {myPlaylists.length > 0 ? (
                            myPlaylists.map((p) => (
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
                            <div className="add-to-playlist-empty">Нет плейлистов</div>
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
            {tracks.length < total && (
              <div className="load-more-wrapper">
                <button
                  type="button"
                  className="load-more-btn"
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                >
                  {loadingMore ? 'Загрузка...' : 'Показать ещё'}
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="empty-liked">
            <p>У вас пока нет понравившихся треков</p>
            <p className="empty-liked-subtitle">Нажмите на сердечко, чтобы добавить трек</p>
          </div>
        )}
      </div>
    </div>
  )
}

export default LikedSongs
