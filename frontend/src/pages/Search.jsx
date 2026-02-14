import { useState, useEffect } from 'react'
import { usePlayerStore } from '../store/playerStore'
import api from '../services/api'
import defaultCover from '../assets/default-cover.svg'
import { resolveCoverUrl } from '../utils/media'
import './Search.css'

function Search() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState({ tracks: [], playlists: [], users: [] })
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (query.trim().length > 0) {
      const timeoutId = setTimeout(() => {
        performSearch()
      }, 500)
      return () => clearTimeout(timeoutId)
    } else {
      setResults({ tracks: [], playlists: [], users: [] })
    }
  }, [query])

  const performSearch = async () => {
    setLoading(true)
    try {
      const response = await api.get('/search', {
        params: { q: query, limit: 20 },
      })
      setResults(response.data)
    } catch (error) {
      console.error('Search error:', error)
    } finally {
      setLoading(false)
    }
  }

  const handlePlayTrack = (track) => {
    const { playTrack } = usePlayerStore.getState()
    playTrack(track, results.tracks)
  }

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
        <div className="loading">Поиск...</div>
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

          {results.playlists.length > 0 && (
            <div className="results-section">
              <h2 className="results-title">Плейлисты</h2>
              <div className="playlists-list">
                {results.playlists.map((playlist) => (
                  <div key={playlist.id} className="playlist-item">
                    <img
                      src={resolveCoverUrl(playlist.cover_url) || defaultCover}
                      alt={playlist.name}
                      className="playlist-item-cover"
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

          {!loading && query && results.tracks.length === 0 && results.playlists.length === 0 && results.users.length === 0 && (
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
