import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { usePlayerStore, trackIntentHandlers } from '../store/playerStore'
import { Play, Plus, Heart } from 'lucide-react'
import api from '../services/api'
import Spinner from '../components/Spinner'
import { toast } from '../store/toastStore'
import defaultCover from '../assets/default-cover.png'
import { handleCoverError } from '../utils/media'
import './PlaylistDetail.css'

// Просмотр внешнего (SoundCloud) плейлиста: слушать можно сразу, в библиотеку
// добавляется только по явному нажатию «Добавить в медиатеку».
function ExternalPlaylist() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [playlist, setPlaylist] = useState(null)
  const [tracks, setTracks] = useState([])
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
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
  const materializeTrack = usePlayerStore((s) => s.materializeTrack)

  useEffect(() => {
    fetchPlaylist()
    fetchLikedTracks()
  }, [id])

  useEffect(() => {
    if (menuTrackId === null) return
    const close = () => setMenuTrackId(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [menuTrackId])

  const fetchPlaylist = async () => {
    setLoading(true)
    try {
      const response = await api.get(`/soundcloud/playlists/${id}`)
      setPlaylist(response.data.playlist)
      setTracks(response.data.tracks)
      // Прогреваем резолв первых треков — старт воспроизведения без паузы.
      usePlayerStore.getState().prefetchTracks(response.data.tracks, 8)
    } catch (error) {
      console.error('Error fetching external playlist:', error)
      toast.error('Не удалось загрузить плейлист')
      navigate('/search')
    } finally {
      setLoading(false)
    }
  }

  const handlePlay = () => {
    if (tracks.length > 0) {
      playPlaylist(tracks, 0, 'external')
    }
  }

  const handlePlayTrack = (track, index) => {
    playPlaylist(tracks, index, 'external')
  }

  const handleImport = async () => {
    if (importing || !playlist) return
    setImporting(true)
    try {
      const { data } = await api.post('/import', { url: playlist.permalink_url })
      toast.success(`Плейлист «${data.playlist.name}» добавлен в медиатеку`)
      navigate(`/playlists/${data.playlist.id}`)
    } catch (error) {
      console.error('Playlist import error:', error)
      toast.error('Не удалось добавить плейлист в медиатеку')
    } finally {
      setImporting(false)
    }
  }

  // Материализует внешний трек в БД и запоминает db_id в списке, чтобы
  // индикация лайка работала после действия.
  const ensureDbId = async (track) => {
    if (typeof track.db_id === 'number') return track.db_id
    const dbId = await materializeTrack(track)
    setTracks((prev) => prev.map((t) => (t.id === track.id ? { ...t, db_id: dbId } : t)))
    return dbId
  }

  const handleToggleLike = async (track, e) => {
    e.stopPropagation()
    try {
      const dbId = await ensureDbId(track)
      await toggleTrackLike(dbId)
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
      const dbId = await ensureDbId(track)
      await api.post(`/playlists/${target.id}/tracks/${dbId}`, null, {
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
          src={playlist.cover_url || defaultCover}
          alt={playlist.title}
          className="playlist-header-cover"
          onError={handleCoverError}
        />
        <div className="playlist-header-info">
          <div className="playlist-type">Плейлист · SoundCloud</div>
          <h1 className="playlist-title">{playlist.title}</h1>
          <div className="playlist-meta">
            <span>{playlist.owner || 'SoundCloud'}</span>
            {tracks.length > 0 && (
              <>
                <span>•</span>
                <span>{tracks.length} треков</span>
              </>
            )}
          </div>
          <div className="playlist-actions">
            <button className="play-button-large" onClick={handlePlay}>
              <Play size={24} fill="currentColor" />
              Воспроизвести
            </button>
            <button
              className="play-button-large secondary"
              onClick={handleImport}
              disabled={importing}
            >
              <Plus size={20} />
              {importing ? 'Добавление...' : 'Добавить в медиатеку'}
            </button>
          </div>
        </div>
      </div>

      <div className="playlist-tracks">
        {tracks.length > 0 ? (
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
                const dbId = typeof track.db_id === 'number' ? track.db_id : null
                const isLiked = dbId ? likedTrackIds.includes(dbId) : false
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
                      src={track.cover_url || defaultCover}
                      alt={track.title}
                      className="track-table-cover"
                      loading="lazy"
                      decoding="async"
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
        ) : (
          <div className="empty-playlist">
            <p>В этом плейлисте пока нет треков</p>
          </div>
        )}
      </div>
    </div>
  )
}

export default ExternalPlaylist
