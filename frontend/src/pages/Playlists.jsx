import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Plus, Download } from 'lucide-react'
import api from '../services/api'
import { toast } from '../store/toastStore'
import Spinner from '../components/Spinner'
import defaultCover from '../assets/default-cover.svg'
import { resolveCoverUrl, handleCoverError } from '../utils/media'
import './Playlists.css'

function Playlists() {
  const navigate = useNavigate()
  const [playlists, setPlaylists] = useState([])
  const [loading, setLoading] = useState(true)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [newPlaylistName, setNewPlaylistName] = useState('')
  const [coverFile, setCoverFile] = useState(null)
  const [creating, setCreating] = useState(false)

  // Импорт из внешних сервисов (SoundCloud / Yandex Music).
  const [showImportForm, setShowImportForm] = useState(false)
  const [importUrl, setImportUrl] = useState('')
  const [preview, setPreview] = useState(null)
  const [previewing, setPreviewing] = useState(false)
  const [importing, setImporting] = useState(false)

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
    if (!newPlaylistName.trim() || creating) return

    setCreating(true)
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
      toast.success('Плейлист создан')
    } catch (error) {
      console.error('Error creating playlist:', error)
    } finally {
      setCreating(false)
    }
  }

  const handlePreview = async () => {
    if (!importUrl.trim() || previewing) return
    setPreviewing(true)
    setPreview(null)
    try {
      const { data } = await api.post('/import/preview', { url: importUrl.trim() })
      setPreview(data)
    } catch (error) {
      const detail = error.response?.data?.detail || 'Не удалось прочитать ссылку'
      toast.error(detail)
    } finally {
      setPreviewing(false)
    }
  }

  const handleImport = async () => {
    if (!importUrl.trim() || importing) return
    setImporting(true)
    try {
      const { data } = await api.post('/import', { url: importUrl.trim() })
      const parts = [`Импортировано треков: ${data.imported}`]
      if (data.matched) parts.push(`подобрано: ${data.matched}`)
      if (data.skipped) parts.push(`пропущено: ${data.skipped}`)
      toast.success(parts.join(', '))
      resetImport()
      await fetchPlaylists()
      if (data.playlist?.id) navigate(`/playlists/${data.playlist.id}`)
    } catch (error) {
      const detail = error.response?.data?.detail || 'Не удалось импортировать'
      toast.error(detail)
    } finally {
      setImporting(false)
    }
  }

  const resetImport = () => {
    setShowImportForm(false)
    setImportUrl('')
    setPreview(null)
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
      <div className="playlists-header">
        <h1>Моя музыка</h1>
        <div className="playlists-header-actions">
          <button
            className="import-playlist-btn"
            onClick={() => { setShowImportForm(!showImportForm); setShowCreateForm(false) }}
          >
            <Download size={20} />
            Импорт по ссылке
          </button>
          <button
            className="create-playlist-btn"
            onClick={() => { setShowCreateForm(!showCreateForm); setShowImportForm(false) }}
          >
            <Plus size={20} />
            Создать плейглист
          </button>
        </div>
      </div>

      {showImportForm && (
        <div className="import-playlist-form">
          <p className="import-hint">
            Вставьте ссылку на плейлист, альбом или профиль SoundCloud либо Yandex Music.
            Треки Yandex подбираются из YouTube Music.
          </p>
          <div className="import-input-row">
            <input
              type="url"
              placeholder="https://soundcloud.com/... или https://music.yandex.ru/..."
              value={importUrl}
              onChange={(e) => { setImportUrl(e.target.value); setPreview(null) }}
              autoFocus
            />
            <button
              type="button"
              className="submit-btn"
              onClick={handlePreview}
              disabled={previewing || importing || !importUrl.trim()}
            >
              {previewing ? 'Проверка...' : 'Проверить'}
            </button>
          </div>

          {preview && (
            <div className="import-preview">
              <div className="import-preview-title">
                {preview.title || 'Коллекция'} · {preview.track_count} треков · {preview.source}
              </div>
              <ul className="import-preview-list">
                {preview.tracks.slice(0, 5).map((t, i) => (
                  <li key={i}>
                    <span className="import-preview-track">{t.title}</span>
                    <span className="import-preview-artist">{t.artist}</span>
                  </li>
                ))}
                {preview.track_count > 5 && <li>…и ещё {preview.track_count - 5}</li>}
              </ul>
            </div>
          )}

          <div className="form-actions">
            <button
              type="button"
              className="submit-btn"
              onClick={handleImport}
              disabled={importing || !importUrl.trim()}
            >
              {importing ? 'Импорт...' : 'Импортировать'}
            </button>
            <button type="button" className="cancel-btn" onClick={resetImport}>
              Отмена
            </button>
          </div>
        </div>
      )}

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
            className="create-playlist-form-input-btn"
            type="file"
            accept="image/*"
            onChange={(e) => setCoverFile(e.target.files?.[0] || null)}
          />
          <div className="form-actions">
            <button type="submit" className="submit-btn" disabled={creating}>
              {creating ? 'Создание...' : 'Создать'}
            </button>
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
                onError={handleCoverError}
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
