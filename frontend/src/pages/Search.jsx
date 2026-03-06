import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePlayerStore } from '../store/playerStore'
import { Search as SearchIcon, X, Heart, ChevronRight } from 'lucide-react'
import api from '../services/api'
import defaultCover from '../assets/default-cover.svg'
import { resolveCoverUrl } from '../utils/media'
import './Search.css'

function Search() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState({ tracks: [], playlists: [], users: [] })
  const [loading, setLoading] = useState(false)
  const [likedTrackIds, setLikedTrackIds] = useState(new Set())
  const navigate = useNavigate()

  useEffect(() => {
    fetchLikedTracks()
  }, [])

  const fetchLikedTracks = async () => {
    try {
      const res = await api.get('/tracks/me/liked')
      setLikedTrackIds(new Set(res.data.map(t => t.id)))
    } catch (error) {
      console.error('Error fetching liked tracks:', error)
    }
  }

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

      const { tracks, playlists, users } = response.data

      // Extract unique artists from tracks that are not already listed as users
      const existingUsernames = new Set(users.map(u => u.username.toLowerCase()))
      const existingFullNames = new Set(users.map(u => (u.full_name || '').toLowerCase()))

      const trackArtists = [...new Set(tracks.map(t => t.artist).filter(Boolean))]
      const newArtists = trackArtists.filter(artist => {
        const lower = artist.toLowerCase()
        return !existingUsernames.has(lower) && !existingFullNames.has(lower)
      })

      // Simple string hashing function to generate 8-char hex
      const generateHexId = (str) => {
        let hash = 0
        for (let i = 0; i < str.length; i++) {
          hash = (hash << 5) - hash + str.charCodeAt(i)
          hash |= 0 // Convert to 32bit integer
        }
        return Math.abs(hash).toString(16).padStart(8, '0').slice(0, 8)
      }

      const simulatedArtists = newArtists.map((artist) => {
        const hexId = generateHexId(artist)
        return {
          id: hexId,
          username: artist,
          full_name: artist,
          avatar_url: null,
          is_simulated: true,
          real_id: hexId,
          original_name: artist
        }
      })

      setResults({
        tracks,
        playlists,
        users: [...users, ...simulatedArtists]
      })
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

  const handleToggleLikeTrack = async (e, trackId) => {
    e.stopPropagation()
    const isLiked = likedTrackIds.has(trackId)
    try {
      if (isLiked) {
        await api.delete(`/tracks/${trackId}/like`)
        setLikedTrackIds(prev => {
          const next = new Set(prev)
          next.delete(trackId)
          return next
        })
      } else {
        await api.post(`/tracks/${trackId}/like`)
        setLikedTrackIds(prev => new Set(prev).add(trackId))
      }
    } catch (error) {
      console.error('Error toggling track like:', error)
    }
  }

  const formatTime = (seconds) => {
    if (!seconds || isNaN(seconds)) return '0:00'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  return (
    <div className="page-container search-page-wrap">
      <div className="search-header-container">
        <div className="search-input-wrapper">
          <SearchIcon className="search-icon-left" size={20} />
          <input
            type="text"
            placeholder="Имя артиста, трек или плейлист"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="search-input-fancy"
            autoFocus
          />
          {query && (
            <button className="search-clear-btn" onClick={() => setQuery('')}>
              <X size={20} />
            </button>
          )}
        </div>
      </div>

      {loading && (
        <div className="search-loading">Поиск...</div>
      )}

      {!loading && query && (
        <div className="search-results-fancy">
          {(results.users.length > 0 || results.tracks.length > 0 || results.playlists.length > 0) && (
            <div className="search-grid-2col">
              {/* === Пользователи (Исполнители) === */}
              {results.users.map((user) => (
                <div
                  key={`user-${user.id}`}
                  className="search-item-fancy track-hover"
                  onClick={() => {
                    if (user.is_simulated) {
                      // Pass actual name in state so Artist page doesn't have to brute force crack the hash
                      navigate(`/artist/${user.id}`, { state: { artistName: user.original_name } })
                    } else {
                      navigate(`/artist/${user.id}`)
                    }
                  }}
                >
                  {user.avatar_url ? (
                    <img src={user.avatar_url} alt={user.username} className="search-item-cover round" />
                  ) : (
                    <div className="search-item-cover round placeholder">{user.username[0].toUpperCase()}</div>
                  )}
                  <div className="search-item-info">
                    <div className="search-item-title">{user.full_name || user.username}</div>
                    <div className="search-item-subtitle auth-role">Исполнитель</div>
                  </div>
                  <div className="search-item-trailing">
                    <ChevronRight size={20} className="trailing-icon" />
                  </div>
                </div>
              ))}

              {/* === Треки === */}
              {results.tracks.map((track) => (
                <div
                  key={`track-${track.id}`}
                  className="search-item-fancy track-hover"
                  onClick={() => handlePlayTrack(track)}
                >
                  <img
                    src={resolveCoverUrl(track.cover_url) || defaultCover}
                    alt={track.title}
                    className="search-item-cover"
                  />
                  <div className="search-item-info">
                    <div className="search-item-title">{track.title}</div>
                    <div className="search-item-subtitle">{track.artist}</div>
                  </div>
                  <div className="search-item-trailing">
                    <button
                      className="search-like-btn"
                      onClick={(e) => handleToggleLikeTrack(e, track.id)}
                    >
                      <Heart
                        size={18}
                        className={`trailing-icon heart-icon ${likedTrackIds.has(track.id) ? 'liked' : ''}`}
                        fill={likedTrackIds.has(track.id) ? 'var(--color-accent)' : 'none'}
                        color={likedTrackIds.has(track.id) ? 'var(--color-accent)' : 'currentColor'}
                      />
                    </button>
                    <span className="trailing-time">{formatTime(track.duration)}</span>
                  </div>
                </div>
              ))}

              {/* === Плейлисты === */}
              {results.playlists.map((playlist) => (
                <div key={`pl-${playlist.id}`} className="search-item-fancy">
                  <img
                    src={resolveCoverUrl(playlist.cover_url) || defaultCover}
                    alt={playlist.name}
                    className="search-item-cover"
                  />
                  <div className="search-item-info">
                    <div className="search-item-title">{playlist.name}</div>
                    <div className="search-item-subtitle">{playlist.description || 'Плейлист'}</div>
                  </div>
                  <div className="search-item-trailing">
                    <ChevronRight size={20} className="trailing-icon" />
                  </div>
                </div>
              ))}
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
          <SearchIcon size={64} className="placeholder-icon" />
          <h2>Найдите любимую музыку</h2>
          <p>Ищите треки, плейлисты и исполнителей</p>
        </div>
      )}
    </div>
  )
}

export default Search
