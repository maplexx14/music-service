import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { usePlayerStore } from '../store/playerStore'
import { Play, Plus } from 'lucide-react'
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
  const { playPlaylist } = usePlayerStore()

  useEffect(() => {
    fetchPlaylist()
  }, [id])

  const fetchPlaylist = async () => {
    setLoading(true)
    try {
      const response = await api.get(`/soundcloud/playlists/${id}`)
      setPlaylist(response.data.playlist)
      setTracks(response.data.tracks)
      // Прогреваем резолв первых треков — старт воспроизведения без паузы.
      usePlayerStore.getState().prefetchTracks(response.data.tracks, 4)
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
                      src={track.cover_url || defaultCover}
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

export default ExternalPlaylist
