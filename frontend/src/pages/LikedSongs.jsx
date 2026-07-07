import { useEffect, useState } from 'react'
import { usePlayerStore } from '../store/playerStore'
import { Play, Heart } from 'lucide-react'
import api from '../services/api'
import Spinner from '../components/Spinner'
import { toast } from '../store/toastStore'
import defaultCover from '../assets/default-cover.svg'
import { resolveCoverUrl, handleCoverError } from '../utils/media'
import './LikedSongs.css'

function LikedSongs() {
  const [tracks, setTracks] = useState([])
  const [loading, setLoading] = useState(true)
  const [removingIds, setRemovingIds] = useState([])
  const { playPlaylist, removeLike } = usePlayerStore()

  useEffect(() => {
    fetchLikedTracks()
  }, [])

  const fetchLikedTracks = async () => {
    try {
      const response = await api.get('/tracks/me/liked')
      setTracks(response.data)
    } catch (error) {
      console.error('Error fetching liked tracks:', error)
    } finally {
      setLoading(false)
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
    try {
      await removeLike(track.id)
    } catch (error) {
      console.error('Error removing liked track:', error)
      setTracks(previous)
      toast.error('Не удалось убрать трек из понравившихся')
    } finally {
      setRemovingIds((prev) => prev.filter((id) => id !== track.id))
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
            <span>{tracks.length} треков</span>
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
              {tracks.map((track, index) => (
                <tr
                  key={track.id}
                  className="track-row"
                  onClick={() => handlePlayTrack(track, index)}
                >
                  <td className="track-number">{index + 1}</td>
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
