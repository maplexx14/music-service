import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Plus, Download, Trash2, Upload } from 'lucide-react'
import api from '../services/api'
import {
  peekCache,
  writeCache,
  intentPrefetchHandlers,
  prefetchPlaylist,
  LIBRARY_CACHE_KEY,
} from '../services/pageCache'
import { toast } from '../store/toastStore'
import Spinner from '../components/Spinner'
import ImportCollectionPicker, {
  allCollectionKeys,
  selectedTrackCount,
} from '../components/ImportCollectionPicker'
import ImportProgressModal, { newImportId } from '../components/ImportProgressModal'
import { useLazyBatch } from '../hooks/useLazyBatch'
import defaultCover from '../assets/default-cover.webp'
import { resolveCoverUrl, handleCoverError } from '../utils/media'
import './Playlists.css'

function Playlists() {
  const navigate = useNavigate()
  // Список из прошлого захода рисуется сразу, свежий приезжает фоном: вкладка
  // «Медиатека» открывается без спиннера.
  const [playlists, setPlaylists] = useState(() => peekCache(LIBRARY_CACHE_KEY) ?? [])
  const [loading, setLoading] = useState(() => !peekCache(LIBRARY_CACHE_KEY))
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [newPlaylistName, setNewPlaylistName] = useState('')
  const [coverFile, setCoverFile] = useState(null)
  const [creating, setCreating] = useState(false)

  // Импорт из внешних сервисов (SoundCloud / Yandex Music / Spotify).
  const [showImportForm, setShowImportForm] = useState(false)
  const [importUrl, setImportUrl] = useState('')
  const [preview, setPreview] = useState(null)
  const [previewing, setPreviewing] = useState(false)
  const [importing, setImporting] = useState(false)
  // Профиль Yandex Music: какие коллекции импортировать (ключи из превью).
  const [selectedCollections, setSelectedCollections] = useState(new Set())
  // Окно прогресса: { id, title } идущего импорта или null.
  const [importProgress, setImportProgress] = useState(null)


  // Медиатека растёт без потолка, а обложка у каждого плейлиста своя — рисуем
  // карточки партиями по мере прокрутки. resetKey константный: медиатека здесь
  // одна, а создание и удаление правят список на месте — схлопывать из-за них
  // уже отрисованное не нужно.
  const { visibleItems: visiblePlaylists, sentinelRef: playlistsSentinelRef } =
    useLazyBatch(playlists, { resetKey: 'library' })

  useEffect(() => {
    fetchPlaylists()
  }, [])

  // Создание и удаление правят список на месте — кэш следует за ним, иначе
  // возврат на вкладку на миг показал бы прошлую версию.
  useEffect(() => {
    if (!loading) writeCache(LIBRARY_CACHE_KEY, playlists)
  }, [playlists, loading])

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
      setSelectedCollections(allCollectionKeys(data))
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
      const body = { url: importUrl.trim() }
      const importId = newImportId()
      body.import_id = importId
      setImportProgress({ id: importId, title: preview?.title })
      if (isProfilePreview) body.collections = [...selectedCollections]
      // Без таймаута: большой плейлист (сотни треков) импортируется дольше
      // глобальных 60 с axios — браузер рвал запрос, хотя сервер доделывал
      // импорт. Ход виден в окне прогресса, ограничивает только nginx (1 ч).
      const { data } = await api.post('/import', body, { timeout: 0 })
      const created = data.playlists?.length || (data.playlist ? 1 : 0)
      const parts = [`Импортировано треков: ${data.imported}`]
      if (created > 1) parts.push(`плейлистов: ${created}`)
      if (data.matched) parts.push(`подобрано: ${data.matched}`)
      if (data.skipped) parts.push(`пропущено: ${data.skipped}`)
      toast.success(parts.join(', '))
      resetImport()
      await fetchPlaylists()
      // Профиль даёт несколько плейлистов — остаёмся в медиатеке.
      if (created === 1 && data.playlist?.id) navigate(`/playlists/${data.playlist.id}`)
    } catch (error) {
      const detail = error.response?.data?.detail || 'Не удалось импортировать'
      toast.error(detail)
    } finally {
      setImporting(false)
      setImportProgress(null)
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
    setSelectedCollections(new Set())
  }

  const isProfilePreview = preview?.kind === 'profile' && preview.collections?.length > 0


  if (loading) {
    return (
      <Spinner page />
    )
  }

  return (
    <div className="page-container">
      {importProgress && (
        <ImportProgressModal
          importId={importProgress.id}
          title={importProgress.title}
          onClose={() => setImportProgress(null)}
        />
      )}
      <div className="playlists-header">
        <h1>Медиатека</h1>
        <div className="playlists-header-actions">
          {/* Загрузка своего трека: отдельного пункта меню под неё нет ни
              на мобильном, ни в сайдбаре — ссылка на /upload живёт здесь. */}
          <Link to="/upload" className="btn btn--secondary import-playlist-btn">
            <Upload size={20} />
            Загрузить трек
          </Link>
          <button
            className="btn btn--secondary import-playlist-btn"
            onClick={() => { setShowImportForm(!showImportForm); setShowCreateForm(false) }}
          >
            <Download size={20} />
            Импорт по ссылке
          </button>
          <button
            className="btn btn--primary create-playlist-btn"
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
            Вставьте ссылку на плейлист, альбом, профиль или избранное SoundCloud, Yandex Music
            либо Spotify. Треки Yandex и Spotify подбираются из YouTube Music. Из профиля
            Yandex Music переносятся открытые плейлисты и «Мне нравится» — каждый отдельным
            плейлистом.
          </p>
          <div className="import-examples">
            <div className="import-example">
              <span className="import-example-label">Spotify:</span>
              <span className="import-example-url">open.spotify.com/playlist/37i9dQ...</span>
              <span className="import-example-url">open.spotify.com/album/1DFixL...</span>
              <span className="import-example-url">open.spotify.com/track/4cOdK2...</span>
            </div>
           
            <div className="import-example">
              <span className="import-example-label">Yandex Music:</span>
              <span className="import-example-url">music.yandex.ru/users/login (профиль)</span>
              <span className="import-example-url">music.yandex.ru/users/login/playlists/1003</span>
              <span className="import-example-url">music.yandex.ru/album/5307899</span>
            </div>

            <div className="import-example">
              <span className="import-example-label">SoundCloud:</span>
              <span className="import-example-url">soundcloud.com/user/sets/playlist</span>
              <span className="import-example-url">soundcloud.com/user/track</span>
            </div>
          </div>

          <div className="import-input-row">
            <input
              className="field"
              type="url"
              placeholder="https://open.spotify.com/... , https://music.yandex.ru/... или https://soundcloud.com/..."
              value={importUrl}
              onChange={(e) => { setImportUrl(e.target.value); setPreview(null) }}
              autoFocus
            />
            <button
              type="button"
              className="btn btn--primary submit-btn"
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
              {isProfilePreview ? (
                <ImportCollectionPicker
                  collections={preview.collections}
                  selected={selectedCollections}
                  onChange={setSelectedCollections}
                  disabled={importing}
                />
              ) : (
                <ul className="import-preview-list">
                  {preview.tracks.slice(0, 5).map((t, i) => (
                    <li key={i}>
                      <span className="import-preview-track">{t.title}</span>
                      <span className="import-preview-artist">{t.artist}</span>
                    </li>
                  ))}
                  {preview.track_count > 5 && <li>…и ещё {preview.track_count - 5}</li>}
                </ul>
              )}
            </div>
          )}

          <div className="form-actions">
            <button
              type="button"
              className="btn btn--primary submit-btn"
              onClick={handleImport}
              disabled={importing || !importUrl.trim() || (isProfilePreview && !selectedCollections.size)}
            >
              {importing
                ? 'Импорт...'
                : isProfilePreview
                  ? `Импортировать (${selectedCollections.size} · ${selectedTrackCount(preview, selectedCollections)} треков)`
                  : 'Импортировать'}
            </button>
            <button type="button" className="btn btn--ghost cancel-btn" onClick={resetImport}>
              Отмена
            </button>
          </div>
        </div>
      )}

      {showCreateForm && (
        <form onSubmit={handleCreatePlaylist} className="create-playlist-form">
          <input
            className="field"
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
            <button type="submit" className="btn btn--primary submit-btn" disabled={creating}>
              {creating ? 'Создание...' : 'Создать'}
            </button>
            <button
              type="button"
              className="btn btn--ghost cancel-btn"
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
        <>
          <div className="playlists-grid">
            {visiblePlaylists.map((playlist) => (
              <div key={playlist.id} className="playlist-card">
                <button
                  className="playlist-delete-btn"
                  title="Удалить плейлист"
                  onClick={(e) => handleDeletePlaylist(e, playlist)}
                >
                  <Trash2 size={18} />
                </button>
                <Link
                  to={`/playlists/${playlist.id}`}
                  className="playlist-card-link"
                  {...intentPrefetchHandlers(() => prefetchPlaylist(playlist.id))}
                >
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
          {/* Маячок догрузки — соседом, а не ячейкой сетки: внутри
              .playlists-grid он занял бы колонку и порвал ряд. */}
          <div ref={playlistsSentinelRef} aria-hidden="true" />
        </>
      )}
    </div>
  )
}

export default Playlists
