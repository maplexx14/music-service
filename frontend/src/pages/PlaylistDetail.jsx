import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { usePlayerStore } from '../store/playerStore'
import { Play, Heart, MoreVertical } from 'lucide-react'
import api from '../services/api'
import defaultCover from '../assets/default-cover.svg'
import { resolveCoverUrl } from '../utils/media'
import './PlaylistDetail.css'

function PlaylistDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [playlist, setPlaylist] = useState(null)
  const [loading, setLoading] = useState(true)
  const { playPlaylist } = usePlayerStore()

  useEffect(() => {
    fetchPlaylist()
  }, [id])

  const fetchPlaylist = async () => {
    try {
      const response = await api.get(`/playlists/${id}`)
      setPlaylist(response.data)
    } catch (error) {
      console.error('Error fetching playlist:', error)
      navigate('/playlists')
    } finally {
      setLoading(false)
    }
  }

  const handlePlay = () => {
    if (playlist.tracks && playlist.tracks.length > 0) {
      playPlaylist(playlist.tracks, 0)
    }
  }

  const handlePlayTrack = (track, index) => {
    playPlaylist(playlist.tracks, index)
  }

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading">Загрузка...</div>
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
        />
        <div className="playlist-header-info">
          <div className="playlist-type">Плейлист</div>
          <h1 className="playlist-title">{playlist.name}</h1>
          {playlist.description && (
            <p className="playlist-description">{playlist.description}</p>
          )}
          <div className="playlist-meta">
            <span>{playlist.owner?.username || 'Пользователь'}</span>
            {playlist.tracks && playlist.tracks.length > 0 && (
              <>
                <span>•</span>
                <span>{playlist.tracks.length} треков</span>
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
              </tr>
            </thead>
            <tbody>
              {playlist.tracks.map((track, index) => (
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
                </tr>
              ))}
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

export default PlaylistDetail
