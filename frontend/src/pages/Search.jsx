import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Download } from 'lucide-react'
import { usePlayerStore } from '../store/playerStore'
import api from '../services/api'
import Spinner from '../components/Spinner'
import defaultCover from '../assets/default-cover.png'
import { resolveCoverUrl, handleCoverError, upscaleCover } from '../utils/media'
import './Search.css'

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
    if (query.trim().length > 0) {
      const timeoutId = setTimeout(() => {
        performSearch()
      }, 500)
      return () => clearTimeout(timeoutId)
    } else {
      setResults({ tracks: [], playlists: [], users: [] })
      setExternalTracks([])
      setExternalPlaylists([])
    }
  }, [query])

  const performSearch = async () => {
    setLoading(true)
    setSearchError('')
    try {
      const [localResult, externalResult, externalPlaylistsResult] = await Promise.allSettled([
        api.get('/search', {
          params: { q: query, limit: 20 },
        }),
        api.get('/search/external', {
          params: { q: query, limit: 30 },
          skipErrorToast: true,
        }),
        api.get('/search/external/playlists', {
          params: { q: query, limit: 10 },
          skipErrorToast: true,
        }),
      ])
      if (localResult.status === 'fulfilled') {
        setResults(localResult.value.data)
      } else {
        console.error('Local search error:', localResult.reason)
        setResults({ tracks: [], playlists: [], users: [] })
        setSearchError('Не удалось выполнить поиск. Попробуйте ещё раз.')
      }
      if (externalResult.status === 'fulfilled') {
        setExternalTracks(externalResult.value.data)
        // Прогреваем резолв топ-нескольких результатов заранее — большинство
        // кликов приходится на верх списка, и к моменту клика резолв уже тёплый.
        // С Invidious прогрев дешёвый, так что греем пошире — клик почти в
        // любой видимый результат стартует с диска, без паузы на резолв.
        usePlayerStore.getState().prefetchTracks(externalResult.value.data, 8)
      } else {
        console.error('External search error:', externalResult.reason)
        setExternalTracks([])
      }
      if (externalPlaylistsResult.status === 'fulfilled') {
        setExternalPlaylists(externalPlaylistsResult.value.data)
      } else {
        console.error('External playlist search error:', externalPlaylistsResult.reason)
        setExternalPlaylists([])
      }
    } catch (error) {
      console.error('Search error:', error)
      setResults({ tracks: [], playlists: [], users: [] })
      setExternalTracks([])
      setExternalPlaylists([])
      setSearchError('Не удалось выполнить поиск. Попробуйте ещё раз.')
    } finally {
      setLoading(false)
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
                  >
                    <img
                      src={resolveCoverUrl(track.cover_url) || defaultCover}
                      alt={track.title}
                      className="track-item-cover"
                      onError={handleCoverError}
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
                  <div
                    key={track.id}
                    className="track-item"
                    onClick={() => handlePlayExternalTrack(track)}
                  >
                    <img
                      src={upscaleCover(track.cover_url) || defaultCover}
                      alt={track.title}
                      className="track-item-cover"
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
