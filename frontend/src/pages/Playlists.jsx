import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus } from 'lucide-react'
import api from '../services/api'
import defaultCover from '../assets/default-cover.svg'
import { resolveCoverUrl } from '../utils/media'
import './Playlists.css'

function Playlists() {
  const [playlists, setPlaylists] = useState([])
  const [loading, setLoading] = useState(true)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [newPlaylistName, setNewPlaylistName] = useState('')
  const [coverFile, setCoverFile] = useState(null)

  useEffect(() => {
    fetchPlaylists()
  }, [])

  const fetchPlaylists = async () => {
    try {
      const response = await api.get('/playlists/me')
      setPlaylists(response.data)
    } catch (error) {
      console.error('Error fetching playlists:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleCreatePlaylist = async (e) => {
    e.preventDefault()
    if (!newPlaylistName.trim()) return

    try {
      const response = await api.post('/playlists', {
        name: newPlaylistName,
        is_public: true,
      })
      let createdPlaylist = response.data
      if (coverFile) {
        const coverForm = new FormData()
        coverForm.append('cover', coverFile)
        const coverResponse = await api.post(`/playlists/${response.data.id}/cover`, coverForm, {
          headers: { 'Content-Type': 'multipart/form-data' },
        })
        createdPlaylist = coverResponse.data
      }
      setPlaylists([...playlists, createdPlaylist])
      setNewPlaylistName('')
      setCoverFile(null)
      setShowCreateForm(false)
    } catch (error) {
      console.error('Error creating playlist:', error)
    }
  }

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading">Загрузка...</div>
      </div>
    )
  }

  return (
    <div className="page-container">
      <div className="playlists-header">
        <h1>Моя музыка</h1>
        <button
          className="create-playlist-btn"
          onClick={() => setShowCreateForm(!showCreateForm)}
        >
          <Plus size={20} />
          Создать плейлист
        </button>
      </div>

      {showCreateForm && (
        <form onSubmit={handleCreatePlaylist} className="create-playlist-form">
          <input
            type="text"
            placeholder="Название плейлиста"
            value={newPlaylistName}
            onChange={(e) => setNewPlaylistName(e.target.value)}
            autoFocus
          />
          <input
            type="file"
            accept="image/*"
            onChange={(e) => setCoverFile(e.target.files?.[0] || null)}
          />
          <div className="form-actions">
            <button type="submit" className="submit-btn">Создать</button>
            <button
              type="button"
              className="cancel-btn"
              onClick={() => {
                setShowCreateForm(false)
                setNewPlaylistName('')
              }}
            >
              Отмена
            </button>
          </div>
        </form>
      )}

      {playlists.length === 0 ? (
        <div className="empty-state">
          <p>У вас пока нет плейлистов</p>
          <p className="empty-state-subtitle">Создайте свой первый плейлист</p>
        </div>
      ) : (
        <div className="playlists-grid">
          {playlists.map((playlist) => (
            <Link key={playlist.id} to={`/playlists/${playlist.id}`} className="playlist-card">
              <img
                src={resolveCoverUrl(playlist.cover_url) || defaultCover}
                alt={playlist.name}
                className="playlist-cover"
              />
              <div className="playlist-info">
                <div className="playlist-name">{playlist.name}</div>
                {playlist.description && (
                  <div className="playlist-description">{playlist.description}</div>
                )}
                <div className="playlist-tracks-count">
                  {playlist.tracks?.length || 0} треков
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

export default Playlists
