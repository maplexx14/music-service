import { useEffect, useMemo, useState } from 'react'
import { Check, Plus, X, Search, Sparkles } from 'lucide-react'
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
  const excludedArtists = value?.excludedArtists || []

  const [genreOptions, setGenreOptions] = useState([])
  const [artistQuery, setArtistQuery] = useState('')
  const [suggestions, setSuggestions] = useState([])
  // Вкус, выведенный из прослушиваний — тот же профиль, что строит волну.
  const [detected, setDetected] = useState({ genres: [], artists: [] })

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

  useEffect(() => {
    let active = true
    api
      .get('/users/me/taste')
      .then((res) => {
        if (active) {
          setDetected({
            genres: res.data?.genres || [],
            artists: res.data?.artists || [],
          })
        }
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

  // Определённое по истории, что юзер ещё не выбрал явно.
  const unusedDetected = useMemo(
    () => detected.genres.filter((g) => !selectedGenres.includes(g)),
    [detected.genres, selectedGenres]
  )
  const unusedDetectedArtists = useMemo(
    () =>
      detected.artists.filter(
        (d) =>
          !selectedArtists.some((a) => a.toLowerCase() === d.toLowerCase()) &&
          !excludedArtists.some((a) => a.toLowerCase() === d.toLowerCase())
      ),
    [detected.artists, selectedArtists, excludedArtists]
  )

  const applyDetected = () => {
    onChange({
      genres: [...selectedGenres, ...unusedDetected],
      artists: selectedArtists,
      excludedArtists,
    })
  }

  const applyDetectedArtists = () => {
    onChange({
      genres: selectedGenres,
      artists: [...selectedArtists, ...unusedDetectedArtists],
      excludedArtists: excludedArtists.filter(
        (excluded) =>
          !unusedDetectedArtists.some(
            (artist) => artist.toLowerCase() === excluded.toLowerCase()
          )
      ),
    })
  }

  const toggleGenre = (key) => {
    const has = selectedGenres.includes(key)
    const next = has
      ? selectedGenres.filter((g) => g !== key)
      : [...selectedGenres, key]
    onChange({ genres: next, artists: selectedArtists, excludedArtists })
  }

  const addArtist = (name) => {
    const clean = (name || '').trim()
    if (!clean) return
    const dup = selectedArtists.some((a) => a.toLowerCase() === clean.toLowerCase())
    if (!dup) {
      onChange({
        genres: selectedGenres,
        artists: [...selectedArtists, clean],
        excludedArtists: excludedArtists.filter(
          (excluded) => excluded.toLowerCase() !== clean.toLowerCase()
        ),
      })
    }
    setArtistQuery('')
  }

  const removeArtist = (name) => {
    onChange({
      genres: selectedGenres,
      artists: selectedArtists.filter((a) => a !== name),
      excludedArtists,
    })
  }

  const excludeDetectedArtist = (name) => {
    onChange({
      genres: selectedGenres,
      artists: selectedArtists,
      excludedArtists: [...excludedArtists, name],
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

  // Определённые артисты показаны отдельным блоком выше, в подсказках
  // каталога они были бы дублем.
  const visibleSuggestions = useMemo(
    () =>
      suggestions.filter(
        (s) =>
          !selectedArtists.some((a) => a.toLowerCase() === s.toLowerCase()) &&
          !unusedDetectedArtists.some((d) => d.toLowerCase() === s.toLowerCase())
      ),
    [suggestions, selectedArtists, unusedDetectedArtists]
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
            const fromHistory = detected.genres.includes(g.key)
            return (
              <button
                type="button"
                key={g.key}
                className={`pref-chip ${active ? 'active' : ''} ${
                  fromHistory ? 'detected' : ''
                }`}
                onClick={() => toggleGenre(g.key)}
                aria-pressed={active}
                title={fromHistory ? 'Определено по вашим прослушиваниям' : undefined}
              >
                {active && <Check size={16} />}
                {g.label}
                {fromHistory && !active && <Sparkles size={14} />}
              </button>
            )
          })}
        </div>
        {unusedDetected.length > 0 && (
          <button type="button" className="pref-apply-detected" onClick={applyDetected}>
            <Sparkles size={14} /> Добавить из прослушанного ({unusedDetected.length})
          </button>
        )}
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

        {unusedDetectedArtists.length > 0 && (
          <div className="pref-detected">
            <div className="pref-detected-label">
              <Sparkles size={14} /> Определено по вашим прослушиваниям
            </div>
            <div className="pref-suggestions">
              {unusedDetectedArtists.map((a) => (
                <div className="pref-detected-artist" key={a}>
                  <button
                    type="button"
                    className="pref-suggestion detected"
                    onClick={() => addArtist(a)}
                  >
                    <Plus size={14} /> {a}
                  </button>
                  <button
                    type="button"
                    className="pref-dismiss-detected"
                    onClick={() => excludeDetectedArtist(a)}
                    aria-label={`Убрать ${a} из определённых артистов`}
                    title="Не учитывать этого артиста"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="pref-apply-detected"
              onClick={applyDetectedArtists}
            >
              <Sparkles size={14} /> Добавить всех ({unusedDetectedArtists.length})
            </button>
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
