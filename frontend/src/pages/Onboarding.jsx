import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../services/api'
import './Onboarding.css'

function Onboarding() {
  const [step, setStep] = useState('genres') // genres | artists
  const [allGenres, setAllGenres] = useState([])
  const [allArtists, setAllArtists] = useState([])
  const [genreQuery, setGenreQuery] = useState('')
  const [artistQuery, setArtistQuery] = useState('')
  const [selectedGenres, setSelectedGenres] = useState([])
  const [selectedArtists, setSelectedArtists] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const navigate = useNavigate()

  useEffect(() => {
    fetchInitialOptions()
  }, [])

  const fetchInitialOptions = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await api.get('/users/me/onboarding-options')
      setAllGenres(response.data.genres || [])
      setAllArtists(response.data.artists || [])
    } catch (err) {
      setError(err.response?.data?.detail || 'Не удалось загрузить подборку')
    } finally {
      setLoading(false)
    }
  }

  const fetchArtistsByGenres = async (genres) => {
    try {
      const params = new URLSearchParams()
      genres.forEach((genre) => params.append('genres', genre))
      params.append('artist_limit', '80')
      const response = await api.get(`/users/me/onboarding-options?${params.toString()}`)
      const artists = response.data.artists || []
      setAllArtists(artists)
      setSelectedArtists((prev) => prev.filter((artist) => artists.includes(artist)))
    } catch (err) {
      setError(err.response?.data?.detail || 'Не удалось обновить список исполнителей')
    }
  }

  const toggleGenre = (genre) => {
    setSelectedGenres((prev) => {
      const hasGenre = prev.includes(genre)
      const nextGenres = hasGenre ? prev.filter((item) => item !== genre) : [...prev, genre]
      setError('')
      fetchArtistsByGenres(nextGenres)
      return nextGenres
    })
  }

  const toggleArtist = (artist) => {
    setSelectedArtists((prev) =>
      prev.includes(artist) ? prev.filter((item) => item !== artist) : [...prev, artist]
    )
  }

  const handleNext = () => {
    if (!selectedGenres.length) {
      setError('Выберите хотя бы один жанр')
      return
    }
    setError('')
    setStep('artists')
  }

  const handleSave = async () => {
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
      navigate('/')
    } catch (err) {
      setError(err.response?.data?.detail || 'Не удалось сохранить предпочтения')
    } finally {
      setSaving(false)
    }
  }

  const title = useMemo(() => {
    if (step === 'genres') return 'Какая музыка вам нравится?'
    return 'Выберите любимых исполнителей'
  }, [step])

  const filteredGenres = useMemo(() => {
    const q = genreQuery.trim().toLowerCase()
    if (!q) return allGenres
    return allGenres.filter((genre) => genre.toLowerCase().includes(q))
  }, [allGenres, genreQuery])

  const filteredArtists = useMemo(() => {
    const q = artistQuery.trim().toLowerCase()
    if (!q) return allArtists
    return allArtists.filter((artist) => artist.toLowerCase().includes(q))
  }, [allArtists, artistQuery])

  if (loading) {
    return (
      <div className="onboarding-page">
        <div className="onboarding-card">
          <p>Подготавливаем персонализацию...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="onboarding-page">
      <div className="onboarding-card">
        <h1>{title}</h1>
        <p className="onboarding-subtitle">
          Это поможет быстрее собрать рекомендации под ваш вкус.
        </p>
        {error && <div className="onboarding-error">{error}</div>}

        {step === 'genres' ? (
          <>
            <input
              type="text"
              value={genreQuery}
              onChange={(e) => setGenreQuery(e.target.value)}
              className="onboarding-search"
              placeholder="Поиск жанра..."
              autoComplete="off"
            />
            <div className="onboarding-grid">
              {filteredGenres.map((genre) => (
                <button
                  key={genre}
                  type="button"
                  className={`chip ${selectedGenres.includes(genre) ? 'active' : ''}`}
                  onClick={() => toggleGenre(genre)}
                >
                  {genre}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <input
              type="text"
              value={artistQuery}
              onChange={(e) => setArtistQuery(e.target.value)}
              className="onboarding-search"
              placeholder="Поиск исполнителя..."
              autoComplete="off"
            />
            <div className="onboarding-grid">
              {filteredArtists.map((artist) => (
                <button
                  key={artist}
                  type="button"
                  className={`chip ${selectedArtists.includes(artist) ? 'active' : ''}`}
                  onClick={() => toggleArtist(artist)}
                >
                  {artist}
                </button>
              ))}
            </div>
          </>
        )}

        {step === 'genres' && filteredGenres.length === 0 && (
          <div className="onboarding-empty">Жанры не найдены</div>
        )}
        {step === 'artists' && filteredArtists.length === 0 && (
          <div className="onboarding-empty">Исполнители не найдены</div>
        )}

        <div className="onboarding-actions">
          {step === 'artists' && (
            <button type="button" className="secondary-btn" onClick={() => setStep('genres')}>
              Назад
            </button>
          )}
          {step === 'genres' ? (
            <button type="button" className="primary-btn" onClick={handleNext}>
              Далее
            </button>
          ) : (
            <button type="button" className="primary-btn" onClick={handleSave} disabled={saving}>
              {saving ? 'Сохраняем...' : 'Завершить'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default Onboarding
