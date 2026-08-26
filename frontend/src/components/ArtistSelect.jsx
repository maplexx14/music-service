import { useEffect, useMemo, useState } from 'react'
import { Plus, X, Search, Sparkles } from 'lucide-react'
import api from '../services/api'
import './PreferencePicker.css'

/**
 * Выбор любимых артистов.
 *
 * Подсказки зависят от ЖАНРОВ: пустой ввод — топ артистов выбранных жанров
 * (Last.fm tag.getTopArtists через /users/artists/by-genres), ввод — поиск по
 * каталогу и YouTube Music (/users/artists/suggest). Без жанров подсказки не
 * пропадают: бэкенд добирает самыми слушаемыми артистами каталога.
 *
 * Контролируемый: selected/excluded — string[], onChange({ artists,
 * excludedArtists }).
 */
function ArtistSelect({
  selected = [],
  excluded = [],
  detected = [],
  genres = [],
  onChange,
}) {
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState([])
  const [loading, setLoading] = useState(false)

  // Ключ стабилизирует эффект: массив жанров пересоздаётся на каждый рендер
  // родителя, а запрос должен уходить только при реальной смене выбора.
  const genresKey = genres.join('|')

  useEffect(() => {
    const term = query.trim()
    let active = true
    setLoading(true)
    const timer = setTimeout(() => {
      const request = term
        ? api.get('/users/artists/suggest', { params: { q: term, limit: 12 } })
        : api.get('/users/artists/by-genres', {
            // Жанры одной строкой через запятую: axios сериализует массив как
            // genres[]=..., чего FastAPI в List[str] = Query() не разбирает.
            params: { genres: genresKey.split('|').filter(Boolean).join(','), limit: 24 },
          })
      request
        .then((res) => {
          if (active) setSuggestions(res.data || [])
        })
        .catch(() => {
          if (active) setSuggestions([])
        })
        .finally(() => {
          if (active) setLoading(false)
        })
    }, term ? 250 : 0)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [query, genresKey])

  const unusedDetected = useMemo(
    () =>
      detected.filter(
        (d) =>
          !selected.some((a) => a.toLowerCase() === d.toLowerCase()) &&
          !excluded.some((a) => a.toLowerCase() === d.toLowerCase())
      ),
    [detected, selected, excluded]
  )

  const visibleSuggestions = useMemo(
    () =>
      suggestions.filter(
        (s) =>
          !selected.some((a) => a.toLowerCase() === s.toLowerCase()) &&
          !unusedDetected.some((d) => d.toLowerCase() === s.toLowerCase())
      ),
    [suggestions, selected, unusedDetected]
  )

  const addArtist = (name) => {
    const clean = (name || '').trim()
    if (!clean) return
    const dup = selected.some((a) => a.toLowerCase() === clean.toLowerCase())
    if (!dup) {
      onChange({
        artists: [...selected, clean],
        excludedArtists: excluded.filter(
          (e) => e.toLowerCase() !== clean.toLowerCase()
        ),
      })
    }
    setQuery('')
  }

  const removeArtist = (name) => {
    onChange({
      artists: selected.filter((a) => a !== name),
      excludedArtists: excluded,
    })
  }

  const excludeDetected = (name) => {
    onChange({ artists: selected, excludedArtists: [...excluded, name] })
  }

  const handleKeyDown = (e) => {
    // Не отправляем во время IME-композиции (CJK) и на неточном событии Safari.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter') {
      e.preventDefault()
      addArtist(query)
    }
  }

  return (
    <div className="pref-section">
      {selected.length > 0 && (
        <div className="pref-tags">
          {selected.map((a) => (
            <span className="pref-tag" key={a}>
              {a}
              <button type="button" onClick={() => removeArtist(a)} aria-label={`Убрать ${a}`}>
                <X size={14} />
              </button>
            </span>
          ))}
        </div>
      )}

      {unusedDetected.length > 0 && (
        <div className="pref-detected">
          <div className="pref-detected-label">
            <Sparkles size={14} /> Определено по вашим прослушиваниям
          </div>
          <div className="pref-suggestions">
            {unusedDetected.map((a) => (
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
                  onClick={() => excludeDetected(a)}
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
            onClick={() =>
              onChange({
                artists: [...selected, ...unusedDetected],
                excludedArtists: excluded.filter(
                  (e) => !unusedDetected.some((a) => a.toLowerCase() === e.toLowerCase())
                ),
              })
            }
          >
            <Sparkles size={14} /> Добавить всех ({unusedDetected.length})
          </button>
        </div>
      )}

      <div className="pref-artist-input">
        <Search size={18} className="pref-artist-icon" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Найти артиста"
        />
        {query.trim() && (
          <button type="button" className="pref-add-btn" onClick={() => addArtist(query)}>
            <Plus size={16} /> Добавить
          </button>
        )}
      </div>

      {!query.trim() && genres.length > 0 && (
        <p className="pref-subtitle pref-hint">
          Популярное в выбранных жанрах
        </p>
      )}

      {visibleSuggestions.length > 0 ? (
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
      ) : (
        loading && <p className="pref-subtitle">Подбираем артистов…</p>
      )}
    </div>
  )
}

export default ArtistSelect
