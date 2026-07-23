import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Plus, Download, Trash2, Upload, Check, X } from 'lucide-react'
import api from '../services/api'
import { toast } from '../store/toastStore'
import Spinner from '../components/Spinner'
import defaultCover from '../assets/default-cover.png'
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

  // Cookies для Yandex Music
  const [showCookiesForm, setShowCookiesForm] = useState(false)
  const [cookiesFile, setCookiesFile] = useState(null)
  const [cookiesExists, setCookiesExists] = useState(false)
  const [uploadingCookies, setUploadingCookies] = useState(false)

  useEffect(() => {
    fetchPlaylists()
    checkCookiesExists()
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

  const handleDeletePlaylist = async (e, playlist) => {
    e.preventDefault()
    e.stopPropagation()
    if (!window.confirm(`Удалить плейлист «${playlist.name}»?`)) return
    try {
      await api.delete(`/playlists/${playlist.id}`)
      setPlaylists((prev) => prev.filter((p) => p.id !== playlist.id))
      toast.success('Плейлист удалён')
    } catch (error) {
      const detail = error.response?.data?.detail || 'Не удалось удалить плейлист'
      toast.error(detail)
    }
  }

  const resetImport = () => {
    setShowImportForm(false)
    setImportUrl('')
    setPreview(null)
  }

  // Функции для работы с cookies
  const checkCookiesExists = async () => {
    try {
      const { data } = await api.get('/import/cookies')
      setCookiesExists(data.exists)
    } catch (error) {
      console.error('Error checking cookies:', error)
    }
  }

  const handleUploadCookies = async () => {
    if (!cookiesFile || uploadingCookies) return

    setUploadingCookies(true)
    try {
      const formData = new FormData()
      formData.append('file', cookiesFile)

      await api.post('/import/cookies', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })

      toast.success('Cookies загружены. Теперь вы можете импортировать из Yandex Music.')
      setCookiesFile(null)
      setCookiesExists(true)
      setShowCookiesForm(false)
    } catch (error) {
      const detail = error.response?.data?.detail || 'Не удалось загрузить cookies'
      toast.error(detail)
    } finally {
      setUploadingCookies(false)
    }
  }

  const handleDeleteCookies = async () => {
    try {
      await api.delete('/import/cookies')
      setCookiesExists(false)
      toast.success('Cookies удалены')
    } catch (error) {
      console.error('Error deleting cookies:', error)
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
            Вставьте ссылку на плейлист, альбом, профиль или избранное SoundCloud либо Yandex Music.
            Треки Yandex подбираются из YouTube Music.
          </p>
          <div className="import-examples">
            <div className="import-example">
              <span className="import-example-label">Yandex Music:</span>
              <span className="import-example-url">music.yandex.ru/album/123456</span>
              <span className="import-example-url">music.yandex.ru/users/123456/likes/tracks</span>
              <span className="import-example-url">music.yandex.ru/artist/123456</span>
            </div>
            <div className="import-example">
              <span className="import-example-label">SoundCloud:</span>
              <span className="import-example-url">soundcloud.com/user/sets/playlist</span>
              <span className="import-example-url">soundcloud.com/user/track</span>
            </div>
          </div>

          {/* Cookies для Yandex Music */}
          {importUrl.includes('yandex') && (
            <div className="cookies-section">
              <div className="cookies-status">
                {cookiesExists ? (
                  <span className="cookies-badge cookies-ok">
                    <Check size={14} />
                    Cookies загружены
                  </span>
                ) : (
                  <span className="cookies-badge cookies-missing">
                    <X size={14} />
                    Cookies не загружены
                  </span>
                )}
              </div>

              {!cookiesExists && (
                <div className="cookies-upload">
                  <p className="cookies-hint">
                    Для обхода CAPTCHA на Yandex Music загрузите cookies из браузера.
                    <br />
                    <a href="https://github.com/nicxlau/cookies-txt" target="_blank" rel="noreferrer">
                      Chrome: Get cookies.txt LOCALLY
                    </a>
                    {' · '}
                    <a href="https://addons.mozilla.org/en-US/firefox/addon/cookies-txt/" target="_blank" rel="noreferrer">
                      Firefox: cookies.txt
                    </a>
                  </p>
                  <div className="cookies-upload-row">
                    <input
                      type="file"
                      accept=".txt"
                      onChange={(e) => setCookiesFile(e.target.files?.[0] || null)}
                      className="cookies-file-input"
                    />
                    <button
                      type="button"
                      className="submit-btn small"
                      onClick={handleUploadCookies}
                      disabled={!cookiesFile || uploadingCookies}
                    >
                      {uploadingCookies ? 'Загрузка...' : 'Загрузить cookies'}
                    </button>
                  </div>
                </div>
              )}

              {cookiesExists && (
                <button
                  type="button"
                  className="cookies-delete-btn"
                  onClick={handleDeleteCookies}
                >
                  Удалить cookies
                </button>
              )}
            </div>
          )}

          <div className="import-input-row">
            <input
              type="url"
              placeholder="https://music.yandex.ru/... или https://soundcloud.com/..."
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
            <div key={playlist.id} className="playlist-card">
              <button
                className="playlist-delete-btn"
                title="Удалить плейлист"
                onClick={(e) => handleDeletePlaylist(e, playlist)}
              >
                <Trash2 size={18} />
              </button>
              <Link to={`/playlists/${playlist.id}`} className="playlist-card-link">
                <img
                  src={resolveCoverUrl(playlist.cover_url) || defaultCover}
                  alt={playlist.name}
                  className="playlist-cover"
                  loading="lazy"
                  decoding="async"
                  onError={handleCoverError}
                />
                <div className="playlist-info">
                  <div className="playlist-name">{playlist.name}</div>
                  {playlist.description && (
                    <div className="playlist-description">{playlist.description}</div>
                  )}
                  <div className="playlist-tracks-count">
                    {playlist.track_count ?? playlist.tracks?.length ?? 0} треков
                  </div>
                </div>
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default Playlists
