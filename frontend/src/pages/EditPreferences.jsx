import { useEffect, useMemo, useState } from 'react'
import api from '../services/api'
import './EditPreferences.css'

function EditPreferences() {
  const [allGenres, setAllGenres] = useState([])
  const [allArtists, setAllArtists] = useState([])
  const [selectedGenres, setSelectedGenres] = useState([])
  const [selectedArtists, setSelectedArtists] = useState([])
  const [genreQuery, setGenreQuery] = useState('')
  const [artistQuery, setArtistQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    loadPreferences()
  }, [])

  const loadPreferences = async () => {
    setLoading(true)
    setError('')
    try {
      const [prefsRes, optionsRes] = await Promise.all([
        api.get('/users/me/preferences'),
        api.get('/users/me/onboarding-options'),
      ])
      const genres = prefsRes.data.genres || []
      const artists = prefsRes.data.artists || []
      setSelectedGenres(genres)
      setSelectedArtists(artists)
      setAllGenres(optionsRes.data.genres || [])

      if (genres.length > 0) {
        const params = new URLSearchParams()
        genres.forEach((g) => params.append('genres', g))
        params.append('artist_limit', '80')
        const artistsRes = await api.get(`/users/me/onboarding-options?${params.toString()}`)
        const artistList = artistsRes.data.artists || []
        const merged = [...new Set([...artists, ...artistList])]
        setAllArtists(merged)
      } else {
        setAllArtists(optionsRes.data.artists || [])
      }
    } catch (err) {
      setError(err.response?.data?.detail || 'Не удалось загрузить предпочтения')
    } finally {
      setLoading(false)
    }
  }

  const fetchArtistsByGenres = async (genres) => {
    try {
      const params = new URLSearchParams()
      genres.forEach((g) => params.append('genres', g))
      params.append('artist_limit', '80')
      const res = await api.get(`/users/me/onboarding-options?${params.toString()}`)
      setAllArtists(res.data.artists || [])
      setSelectedArtists((prev) => prev.filter((a) => (res.data.artists || []).includes(a)))
    } catch (err) {
      setError(err.response?.data?.detail || 'Не удалось обновить список исполнителей')
    }
  }

  const toggleGenre = (genre) => {
    setSelectedGenres((prev) => {
      const next = prev.includes(genre) ? prev.filter((g) => g !== genre) : [...prev, genre]
      setError('')
      fetchArtistsByGenres(next)
      return next
    })
  }

  const toggleArtist = (artist) => {
    setSelectedArtists((prev) =>
      prev.includes(artist) ? prev.filter((a) => a !== artist) : [...prev, artist]
    )
  }

  const handleSave = async () => {
    if (!selectedGenres.length) {
      setError('Выберите хотя бы один жанр')
      return
    }
    if (!selectedArtists.length) {
      setError('Выберите хотя бы одного исполнителя')
      return
    }
    setError('')
    setSaving(true)
    try {
      await api.put('/users/me/preferences', {
        genres: selectedGenres,
        artists: selectedArtists,
      })
      window.dispatchEvent(new Event('recommendations:refresh'))
    } catch (err) {
      setError(err.response?.data?.detail || 'Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }

  const filteredGenres = useMemo(() => {
    const q = genreQuery.trim().toLowerCase()
    return q ? allGenres.filter((g) => g.toLowerCase().includes(q)) : allGenres
  }, [allGenres, genreQuery])

  const filteredArtists = useMemo(() => {
    const q = artistQuery.trim().toLowerCase()
    return q ? allArtists.filter((a) => a.toLowerCase().includes(q)) : allArtists
  }, [allArtists, artistQuery])

  return (
    <div className="page-container">
      <div className="prefs-header">
        <h1>Изменить предпочтения</h1>
        <p>Любимые жанры и исполнители влияют на рекомендации</p>
      </div>

      <div className="prefs-card">
        {error && <div className="prefs-error">{error}</div>}
        {loading ? (
          <p className="prefs-loading">Загрузка...</p>
        ) : (
          <>
            <div className="prefs-section">
              <label className="prefs-label">Жанры</label>
              <input
                type="text"
                value={genreQuery}
                onChange={(e) => setGenreQuery(e.target.value)}
                className="prefs-search"
                placeholder="Поиск жанра..."
                autoComplete="off"
              />
              <div className="prefs-grid">
                {filteredGenres.map((genre) => (
                  <button
                    key={genre}
                    type="button"
                    className={'prefs-chip' + (selectedGenres.includes(genre) ? ' active' : '')}
                    onClick={() => toggleGenre(genre)}
                  >
                    {genre}
                  </button>
                ))}
              </div>
              {filteredGenres.length === 0 && <div className="prefs-empty">Жанры не найдены</div>}
            </div>
            <div className="prefs-section">
              <label className="prefs-label">Исполнители</label>
              <input
                type="text"
                value={artistQuery}
                onChange={(e) => setArtistQuery(e.target.value)}
                className="prefs-search"
                placeholder="Поиск исполнителя..."
                autoComplete="off"
              />
              <div className="prefs-grid">
                {filteredArtists.map((artist) => (
                  <button
                    key={artist}
                    type="button"
                    className={'prefs-chip' + (selectedArtists.includes(artist) ? ' active' : '')}
                    onClick={() => toggleArtist(artist)}
                  >
                    {artist}
                  </button>
                ))}
              </div>
              {filteredArtists.length === 0 && <div className="prefs-empty">Исполнители не найдены</div>}
            </div>
            <div className="prefs-actions">
              <button
                type="button"
                className="prefs-save-btn"
                onClick={handleSave}
                disabled={saving || !selectedGenres.length || !selectedArtists.length}
              >
                {saving ? 'Сохранение...' : 'Сохранить'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default EditPreferences
