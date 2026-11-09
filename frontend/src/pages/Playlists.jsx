import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Download, Trash2, Upload, Link2, X, ChevronDown, ArrowRight, Loader2 } from 'lucide-react'
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
import ImportFormDialog from '../components/ImportFormDialog'
import ImportCollectionPicker, {
  allCollectionKeys,
  selectedTrackCount,
} from '../components/ImportCollectionPicker'
import { useImportStore } from '../store/importStore'
import { useLazyBatch } from '../hooks/useLazyBatch'
import defaultCover from '../assets/default-cover.webp'
import spotifyLogo from '../assets/service-logos/spotify.svg'
import deezerLogo from '../assets/service-logos/deezer.png'
import yandexMusicLogo from '../assets/service-logos/yandex-music.svg'
import soundcloudLogo from '../assets/service-logos/soundcloud.png'
import { resolveCoverUrl, handleCoverError } from '../utils/media'
import { plural } from '../utils/format'
import './Playlists.css'

const IMPORT_SERVICES = [
  { source: 'spotify', name: 'Spotify', logo: spotifyLogo, examples: ['open.spotify.com/playlist/…', 'open.spotify.com/album/…', 'open.spotify.com/track/…'] },
  { source: 'deezer', name: 'Deezer', logo: deezerLogo, examples: ['deezer.com/playlist/…', 'deezer.com/album/…', 'link.deezer.com/s/…'] },
  { source: 'yandex', name: 'Яндекс Музыка', logo: yandexMusicLogo, examples: ['music.yandex.ru/users/login', 'music.yandex.ru/users/login/playlists/…', 'music.yandex.ru/album/…'] },
  { source: 'soundcloud', name: 'SoundCloud', logo: soundcloudLogo, examples: ['soundcloud.com/user/sets/playlist', 'soundcloud.com/user/track'] },
]

function Playlists() {
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
  const [importError, setImportError] = useState('')
  const importTriggerRef = useRef(null)
  const previewRequest = useRef(null)
  // Профиль Yandex Music: какие коллекции импортировать (ключи из превью).
  const [selectedCollections, setSelectedCollections] = useState(new Set())
  // Законченный импорт добавил плейлисты — перечитываем медиатеку.
  const importsCompleted = useImportStore((s) => s.completed)

  useEffect(() => () => previewRequest.current?.abort(), [])

  // Медиатека растёт без потолка, а обложка у каждого плейлиста своя — рисуем
  // карточки партиями по мере прокрутки. resetKey константный: медиатека здесь
  // одна, а создание и удаление правят список на месте — схлопывать из-за них
  // уже отрисованное не нужно.
  const { visibleItems: visiblePlaylists, sentinelRef: playlistsSentinelRef } =
    useLazyBatch(playlists, { resetKey: 'library' })

  useEffect(() => {
    fetchPlaylists()
  }, [importsCompleted])

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
      const response = await api.post('/playlists/', {
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

  const clearPreview = () => {
    previewRequest.current?.abort()
    previewRequest.current = null
    setPreviewing(false)
    setPreview(null)
    setImportError('')
    setSelectedCollections(new Set())
  }

  const handlePreview = async () => {
    if (!importUrl.trim() || previewing) return
    const controller = new AbortController()
    previewRequest.current = controller
    setPreviewing(true)
    setPreview(null)
    setImportError('')
    try {
      const { data } = await api.post('/import/preview', { url: importUrl.trim() }, {
        signal: controller.signal,
        skipErrorToast: true,
      })
      if (controller.signal.aborted) return
      setPreview(data)
      setSelectedCollections(allCollectionKeys(data))
    } catch (error) {
      if (controller.signal.aborted) return
      const detail = error.response?.data?.detail || 'Не удалось прочитать ссылку'
      setImportError(typeof detail === 'string' ? detail : 'Не удалось прочитать ссылку')
    } finally {
      if (previewRequest.current === controller) {
        previewRequest.current = null
        setPreviewing(false)
      }
    }
  }

  const handleImport = async () => {
    if (!preview || !importUrl.trim() || previewing || importing || (isProfilePreview && !selectedCollections.size)) return
    setImporting(true)
    // Ход и итог — в окне импорта (ImportTracker): оно переживает уход со
    // страницы, а «Открыть плейлист» в нём ведёт к результату.
    const { accepted } = await useImportStore.getState().start({
      url: importUrl.trim(),
      collections: isProfilePreview ? [...selectedCollections] : undefined,
      title: preview?.title,
    })
    if (accepted) resetImport()
    setImporting(false)
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
    clearPreview()
    setShowImportForm(false)
    setImportUrl('')
  }

  const isProfilePreview = preview?.kind === 'profile' && preview.collections?.length > 0
  const previewService = IMPORT_SERVICES.find((service) => service.source === preview?.source)


  if (loading) {
    return (
      <Spinner page />
    )
  }

  return (
    <div className="page-container">
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
            ref={importTriggerRef}
            className="btn btn--secondary import-playlist-btn"
            aria-expanded={showImportForm}
            aria-controls="playlist-import-form"
            onClick={() => {
              if (showImportForm) resetImport()
              else setShowImportForm(true)
              setShowCreateForm(false)
            }}
          >
            <Download size={20} />
            Импорт по ссылке
          </button>
          <button
            className="btn btn--primary create-playlist-btn"
            onClick={() => { setShowCreateForm(!showCreateForm); resetImport() }}
          >
            <Plus size={20} />
            Создать плейглист
          </button>
        </div>
      </div>

      {showImportForm && (
        <ImportFormDialog onClose={resetImport} triggerRef={importTriggerRef}>
          <form
            id="playlist-import-form"
            className="import-playlist-form"
            aria-labelledby="playlist-import-title"
            noValidate
            onSubmit={(event) => {
              event.preventDefault()
              if (preview) handleImport()
              else handlePreview()
            }}
          >
            <div className="import-form-header">
              <h2 id="playlist-import-title">Импорт музыки</h2>
              <button type="button" className="btn btn--ghost import-close" onClick={resetImport} aria-label="Закрыть импорт">
                <X size={20} aria-hidden="true" />
              </button>
            </div>
            <p className="import-hint">Добавьте музыку из другого сервиса по одной ссылке.</p>
            <ul className="import-services" aria-label="Поддерживаемые сервисы">
              {IMPORT_SERVICES.map(({ source, name, logo }) => (
                <li key={source} className="import-service">
                  <img src={logo} className="import-service-logo" alt="" width={18} height={18} draggable={false} />
                  <span>{name}</span>
                </li>
              ))}
            </ul>

            <label className="import-field-label" htmlFor="playlist-import-url">Ссылка на музыку</label>
            <div className="import-url-field">
              <Link2 size={18} aria-hidden="true" />
              <input
                id="playlist-import-url"
                className="field import-url-input"
                type="url"
                inputMode="url"
                enterKeyHint="go"
                placeholder="Вставьте ссылку"
                value={importUrl}
                onChange={(e) => { clearPreview(); setImportUrl(e.target.value) }}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={importing}
                aria-invalid={Boolean(importError)}
                aria-describedby={importError ? 'playlist-import-error' : 'playlist-import-hint'}
              />
            </div>
            {importError ? (
              <p id="playlist-import-error" className="import-field-error" role="alert">{importError}</p>
            ) : (
              <p id="playlist-import-hint" className="import-field-hint">Скопируйте её через «Поделиться» в нужном сервисе.</p>
            )}

            {preview && (
              <section className="import-preview" aria-labelledby="playlist-import-preview-title">
                <div className="import-preview-header">
                  <img
                    className="import-preview-cover"
                    src={resolveCoverUrl(preview.cover_url, 'thumb') || defaultCover}
                    alt=""
                    onError={handleCoverError}
                  />
                  <div className="import-preview-info">
                    <h3 id="playlist-import-preview-title" className="import-preview-title">{preview.title || 'Коллекция'}</h3>
                    <p className="import-preview-meta">
                      {preview.track_count} {plural(preview.track_count, 'трек', 'трека', 'треков')}
                      {' · '}
                      <span className="import-preview-source">
                        {previewService && <img src={previewService.logo} className="import-service-logo" alt="" width={14} height={14} draggable={false} />}
                        {previewService?.name || preview.source}
                      </span>
                    </p>
                  </div>
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
                    {(preview.tracks || []).slice(0, 5).map((t, i) => (
                      <li key={i}>
                        <span className="import-preview-number" aria-hidden="true">{i + 1}</span>
                        <div className="import-preview-song">
                          <span className="import-preview-track">{t.title}</span>
                          <span className="import-preview-artist">{t.artist}</span>
                        </div>
                      </li>
                    ))}
                    {preview.track_count > 5 && <li className="import-preview-more">И ещё {preview.track_count - 5} {plural(preview.track_count - 5, 'трек', 'трека', 'треков')}</li>}
                  </ul>
                )}
              </section>
            )}

            <div className="import-form-actions">
              {isProfilePreview && (
                <p className="import-selection-count">
                  Выбрано: {selectedCollections.size} {plural(selectedCollections.size, 'плейлист', 'плейлиста', 'плейлистов')}
                  {' · '}{selectedTrackCount(preview, selectedCollections)} {plural(selectedTrackCount(preview, selectedCollections), 'трек', 'трека', 'треков')}
                </p>
              )}
              <button
                type="submit"
                className="btn btn--primary btn--lg import-submit"
                disabled={previewing || importing || !importUrl.trim() || (isProfilePreview && !selectedCollections.size)}
              >
                {previewing || importing
                  ? <Loader2 size={18} className="import-busy-icon" aria-hidden="true" />
                  : preview ? <Download size={18} aria-hidden="true" /> : <ArrowRight size={18} aria-hidden="true" />}
                {previewing ? 'Проверяем ссылку…' : importing ? 'Импортируем…' : preview ? 'Импортировать' : 'Проверить ссылку'}
              </button>
            </div>

            <details className="import-help">
              <summary>Какие ссылки подходят<ChevronDown size={16} aria-hidden="true" /></summary>
              <div className="import-examples">
                {IMPORT_SERVICES.map(({ source, name, logo, examples }) => (
                  <div className="import-example" key={source}>
                    <span className="import-example-label">
                      <img src={logo} className="import-service-logo" alt="" width={18} height={18} draggable={false} />
                      {name}
                    </span>
                    {examples.map((url) => <code className="import-example-url" key={url}>{url}</code>)}
                  </div>
                ))}
              </div>
              <p className="import-help-note">
                Из профиля Яндекс Музыки можно перенести открытые плейлисты и «Мне нравится».
                Каждая выбранная коллекция сохранится отдельным плейлистом.
              </p>
            </details>
          </form>
        </ImportFormDialog>
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
                    <div className="playlist-name" title={playlist.name}>{playlist.name}</div>
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
