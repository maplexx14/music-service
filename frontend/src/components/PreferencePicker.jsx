import { useEffect, useMemo, useState } from 'react'
import { Check, Plus, X, Search } from 'lucide-react'
import api from '../services/api'
import './PreferencePicker.css'

/**
 * Переиспользуемый выбор музыкальных предпочтений (жанры + артисты).
 * Контролируемый: value = { genres: string[], artists: string[] }.
 * Используется на онбординге после регистрации и в настройках.
 */
function PreferencePicker({ value, onChange }) {
  const selectedGenres = value?.genres || []
  const selectedArtists = value?.artists || []

  const [genreOptions, setGenreOptions] = useState([])
  const [artistQuery, setArtistQuery] = useState('')
  const [suggestions, setSuggestions] = useState([])

  // Список жанров из встроенного словаря бэкенда.
  useEffect(() => {
    let active = true
    api
      .get('/users/genres')
      .then((res) => {
        if (active) setGenreOptions(res.data || [])
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

  // Подсказки артистов из каталога (с дебаунсом).
  useEffect(() => {
    const q = artistQuery.trim()
    let active = true
    const t = setTimeout(() => {
      api
        .get('/users/artists/suggest', { params: { q, limit: 8 } })
        .then((res) => {
          if (active) setSuggestions(res.data || [])
        })
        .catch(() => {
          if (active) setSuggestions([])
        })
    }, 250)
    return () => {
      active = false
      clearTimeout(t)
    }
  }, [artistQuery])

  const toggleGenre = (key) => {
    const has = selectedGenres.includes(key)
    const next = has
      ? selectedGenres.filter((g) => g !== key)
      : [...selectedGenres, key]
    onChange({ genres: next, artists: selectedArtists })
  }

  const addArtist = (name) => {
    const clean = (name || '').trim()
    if (!clean) return
    const dup = selectedArtists.some((a) => a.toLowerCase() === clean.toLowerCase())
    if (!dup) {
      onChange({ genres: selectedGenres, artists: [...selectedArtists, clean] })
    }
    setArtistQuery('')
  }

  const removeArtist = (name) => {
    onChange({
      genres: selectedGenres,
      artists: selectedArtists.filter((a) => a !== name),
    })
  }

  const handleKeyDown = (e) => {
    // Не отправляем во время IME-композиции (CJK) и на неточном событии Safari.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter') {
      e.preventDefault()
      addArtist(artistQuery)
    }
  }

  const visibleSuggestions = useMemo(
    () =>
      suggestions.filter(
        (s) => !selectedArtists.some((a) => a.toLowerCase() === s.toLowerCase())
      ),
    [suggestions, selectedArtists]
  )

  return (
    <div className="pref-picker">
      <section className="pref-section">
        <h3 className="pref-title">Любимые жанры</h3>
        <p className="pref-subtitle">
          Выберите то, что вам ближе — это настроит ваш поток
        </p>
        <div className="pref-genres">
          {genreOptions.map((g) => {
            const active = selectedGenres.includes(g.key)
            return (
              <button
                type="button"
                key={g.key}
                className={`pref-chip ${active ? 'active' : ''}`}
                onClick={() => toggleGenre(g.key)}
                aria-pressed={active}
              >
                {active && <Check size={16} />}
                {g.label}
              </button>
            )
          })}
        </div>
      </section>

      <section className="pref-section">
        <h3 className="pref-title">Любимые артисты</h3>
        <p className="pref-subtitle">
          Начните вводить имя или выберите из подсказок
        </p>

        {selectedArtists.length > 0 && (
          <div className="pref-tags">
            {selectedArtists.map((a) => (
              <span className="pref-tag" key={a}>
                {a}
                <button
                  type="button"
                  onClick={() => removeArtist(a)}
                  aria-label={`Убрать ${a}`}
                >
                  <X size={14} />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="pref-artist-input">
          <Search size={18} className="pref-artist-icon" />
          <input
            type="text"
            value={artistQuery}
            onChange={(e) => setArtistQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Например, Kizaru"
          />
          {artistQuery.trim() && (
            <button
              type="button"
              className="pref-add-btn"
              onClick={() => addArtist(artistQuery)}
            >
              <Plus size={16} /> Добавить
            </button>
          )}
        </div>

        {visibleSuggestions.length > 0 && (
          <div className="pref-suggestions">
            {visibleSuggestions.map((s) => (
              <button
                type="button"
                key={s}
                className="pref-suggestion"
                onClick={() => addArtist(s)}
              >
                <Plus size={14} /> {s}
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

export default PreferencePicker
