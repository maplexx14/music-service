import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Download } from 'lucide-react'
import { usePlayerStore, trackIntentHandlers } from '../store/playerStore'
import api from '../services/api'
import Spinner from '../components/Spinner'
import defaultCover from '../assets/default-cover.png'
import { resolveCoverUrl, handleCoverError } from '../utils/media'
import './Search.css'

const SEARCH_DEBOUNCE_MS = 600

// Лейбл и класс бейджа по источнику внешнего трека.
const SOURCE_META = {
  soulseek: { label: 'FLAC', className: 'source-badge--flac' },
  ytmusic: { label: 'MP3', className: 'source-badge--mp3' },
  soundcloud: { label: 'SC', className: 'source-badge--soundcloud' },
}

function sourceMeta(source) {
  return SOURCE_META[source] || { label: source || 'EXT', className: '' }
}

function Search() {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState({ tracks: [], playlists: [], users: [] })
  const [externalTracks, setExternalTracks] = useState([])
  const [externalPlaylists, setExternalPlaylists] = useState([])
  const [loading, setLoading] = useState(false)
  const [searchError, setSearchError] = useState('')

  useEffect(() => {
    const searchQuery = query.trim()
    if (searchQuery.length > 0) {
      const controller = new AbortController()
      const timeoutId = window.setTimeout(() => {
        performSearch(searchQuery, controller.signal)
      }, SEARCH_DEBOUNCE_MS)
      return () => {
        window.clearTimeout(timeoutId)
        controller.abort()
      }
    }

    setResults({ tracks: [], playlists: [], users: [] })
    setExternalTracks([])
    setExternalPlaylists([])
    setLoading(false)
  }, [query])

  const performSearch = async (searchQuery, signal) => {
    setLoading(true)
    setSearchError('')
    // Старые внешние результаты чистим сразу: они дорисуются позже и не
    // должны миксоваться с новым запросом.
    setExternalTracks([])
    setExternalPlaylists([])

    // Внешний каталог медленный (секунды) — не блокируем им локальную выдачу,
    // его секции дорисовываются по мере прихода ответов.
    api
      .get('/search/external', {
        params: { q: searchQuery, limit: 30 },
        skipErrorToast: true,
        signal,
      })
      .then((response) => {
        if (signal.aborted) return
        setExternalTracks(response.data)
        // Прогреваем резолв топ-нескольких результатов заранее — большинство
        // кликов приходится на верх списка, и к моменту клика резолв уже тёплый.
        // Ограничиваем прогрев видимой верхушкой, чтобы поиск не создавал
        // всплеск фоновых запросов на слабом клиенте или под нагрузкой.
        usePlayerStore.getState().prefetchTracks(response.data, 4)
      })
      .catch((error) => {
        if (!signal.aborted) console.error('External search error:', error)
      })
    api
      .get('/search/external/playlists', {
        params: { q: searchQuery, limit: 10 },
        skipErrorToast: true,
        signal,
      })
      .then((response) => {
        if (!signal.aborted) setExternalPlaylists(response.data)
      })
      .catch((error) => {
        if (!signal.aborted) console.error('External playlist search error:', error)
      })

    try {
      const response = await api.get('/search', {
        params: { q: searchQuery, limit: 20 },
        signal,
      })
      if (signal.aborted) return
      setResults(response.data)
    } catch (error) {
      if (signal.aborted) return
      console.error('Local search error:', error)
      setResults({ tracks: [], playlists: [], users: [] })
      setSearchError('Не удалось выполнить поиск. Попробуйте ещё раз.')
    } finally {
      if (!signal.aborted) setLoading(false)
    }
  }

  const handlePlayTrack = (track) => {
    const { playTrack } = usePlayerStore.getState()
    playTrack(track, results.tracks)
  }

  const handlePlayExternalTrack = (track) => {
    const { playTrack } = usePlayerStore.getState()
    playTrack(track, externalTracks, 'external')
  }

  const handleImportExternalPlaylist = (playlist) => {
    // Открываем просмотр — импорт в библиотеку только по явной кнопке там.
    navigate(`/external/soundcloud/playlists/${playlist.external_id}`)
  }

  const hasResults =
    results.tracks.length > 0 ||
    externalTracks.length > 0 ||
    results.playlists.length > 0 ||
    externalPlaylists.length > 0 ||
    results.users.length > 0

  return (
    <div className="page-container">
      <div className="search-header">
        <input
          type="text"
          placeholder="Что вы хотите послушать?"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="search-input"
          autoFocus
        />
      </div>

      {loading && (
        <Spinner label="Поиск..." />
      )}

      {!loading && query && searchError && (
        <div className="search-error">{searchError}</div>
      )}

      {!loading && query && (
        <div className="search-results">
          {results.tracks.length > 0 && (
            <div className="results-section">
              <h2 className="results-title">Треки</h2>
              <div className="tracks-list">
                {results.tracks.map((track) => (
                  <div
                    key={track.id}
                    className="track-item"
                    onClick={() => handlePlayTrack(track)}
                    {...trackIntentHandlers(track)}
                  >
                    <img
                      src={resolveCoverUrl(track.cover_url) || defaultCover}
                      alt={track.title}
                      className="track-item-cover"
                      onError={handleCoverError}
                      loading="lazy"
                      decoding="async"
                    />
                    <div className="track-item-info">
                      <div className="track-item-title">{track.title}</div>
                      <div className="track-item-artist">{track.artist}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {externalTracks.length > 0 && (
            <div className="results-section">
              <h2 className="results-title">Внешний каталог</h2>
              <div className="tracks-list">
                {externalTracks.map((track) => (
                  // intent-префетч: наведение/касание строки прогревает резолв на
                  // бэке до клика — важно для результатов ниже топ-4 (их автопрогрев
                  // не покрывает, см. performSearch).
                  <div
                    key={track.id}
                    className="track-item"
                    onClick={() => handlePlayExternalTrack(track)}
                    {...trackIntentHandlers(track)}
                  >
                    <img
                      src={resolveCoverUrl(track.cover_url) || defaultCover}
                      alt={track.title}
                      className="track-item-cover"
                      loading="lazy"
                      decoding="async"
                      onError={handleCoverError}
                    />
                    <div className="track-item-info">
                      <div className="track-item-title">{track.title}</div>
                      <div className="track-item-artist">{track.artist}</div>
                    </div>
                    <div className="track-item-meta">
                      <span
                        className={`source-badge ${sourceMeta(track.source).className}`}
                        data-label={sourceMeta(track.source).label}
                      >
                        {sourceMeta(track.source).label}
                      </span>
                      {track.download_allowed && track.download_url && (
                        <a
                          className="track-download"
                          href={track.download_url}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(event) => event.stopPropagation()}
                          aria-label={`Скачать ${track.title}`}
                        >
                          <Download size={18} />
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {results.playlists.length > 0 && (
            <div className="results-section">
              <h2 className="results-title">Плейлисты</h2>
              <div className="playlists-list">
                {results.playlists.map((playlist) => (
                  <div
                    key={playlist.id}
                    className="playlist-item"
                    onClick={() => navigate(`/playlists/${playlist.id}`)}
                  >
                    <img
                      src={resolveCoverUrl(playlist.cover_url) || defaultCover}
                      alt={playlist.name}
                      className="playlist-item-cover"
                      loading="lazy"
                      decoding="async"
                      onError={handleCoverError}
                    />
                    <div className="playlist-item-info">
                      <div className="playlist-item-name">{playlist.name}</div>
                      {playlist.description && (
                        <div className="playlist-item-description">{playlist.description}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {externalPlaylists.length > 0 && (
            <div className="results-section">
              <h2 className="results-title">Плейлисты SoundCloud</h2>
              <div className="playlists-list">
                {externalPlaylists.map((playlist) => (
                  <div
                    key={playlist.id}
                    className="playlist-item"
                    onClick={() => handleImportExternalPlaylist(playlist)}
                    title="Открыть плейлист"
                  >
                    <img
                      src={playlist.cover_url || defaultCover}
                      alt={playlist.title}
                      className="playlist-item-cover"
                      onError={handleCoverError}
                    />
                    <div className="playlist-item-info">
                      <div className="playlist-item-name">{playlist.title}</div>
                      <div className="playlist-item-description">
                        {`${playlist.owner ? playlist.owner + ' · ' : ''}${playlist.track_count} треков · SoundCloud`}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {results.users.length > 0 && (
            <div className="results-section">
              <h2 className="results-title">Пользователи</h2>
              <div className="users-list">
                {results.users.map((user) => (
                  <div key={user.id} className="user-item">
                    {user.avatar_url ? (
                      <img src={user.avatar_url} alt={user.username} className="user-avatar" />
                    ) : (
                      <div className="user-avatar placeholder">{user.username[0].toUpperCase()}</div>
                    )}
                    <div className="user-info">
                      <div className="user-name">{user.full_name || user.username}</div>
                      <div className="user-username">@{user.username}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!loading && query && !hasResults && (
            <div className="no-results">
              <p>Ничего не найдено</p>
            </div>
          )}
        </div>
      )}

      {!query && (
        <div className="search-placeholder">
          <h2>Найдите любимую музыку</h2>
          <p>Ищите треки, плейлисты и исполнителей</p>
        </div>
      )}
    </div>
  )
}

export default Search

