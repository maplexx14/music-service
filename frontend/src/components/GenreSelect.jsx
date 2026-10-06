import { useEffect, useMemo, useState } from 'react'
import { Check, Search, Sparkles } from 'lucide-react'
import api from '../services/api'
import './PreferencePicker.css'

/**
 * Выбор любимых жанров. Каталог приходит с бэкенда (теги Last.fm + наши
 * ключи, см. lastfm_genres.py) и раскладывается по группам: тегов теперь
 * десятки, плоской простынёй чипов их читать невозможно.
 *
 * Контролируемый: selected = string[] ключей, onChange(next) получает новый
 * массив. detected — жанры, выведенные из прослушиваний (подсвечиваем).
 *
 * Жанр — цветная плитка: у ветки (Рок, Электроника...) свой оттенок, теги
 * внутри ветки чуть расходятся по тону, чтобы соседние плитки не сливались.
 */

// Оттенок OKLCH на ветку — наши ключи genre_keywords. Ветка вне списка
// получает оттенок из хэша ключа: цвет стабилен между заходами.
const GROUP_HUES = {
  phonk: 300,
  trap: 340,
  'hip-hop': 45,
  rock: 20,
  electronic: 215,
  lofi: 170,
  pop: 330,
  jazz: 75,
  classical: 255,
  reggae: 140,
  folk: 100,
  chill: 190,
  // Группы курированных жанров (lastfm_genres._CURATED_GENRES).
  'r&b': 275,
  world: 120,
}

function hueFor(group, index) {
  let hue = GROUP_HUES[group]
  if (hue === undefined) {
    hue = [...(group || '')].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 360, 7)
  }
  return (hue + (index % 6) * 9) % 360
}

function GenreSelect({ selected = [], detected = [], onChange }) {
  const [options, setOptions] = useState([])
  const [loading, setLoading] = useState(true)
  // Жанров под сотню — без поиска нужный приходится выискивать по группам.
  const [query, setQuery] = useState('')
  const term = query.trim().toLowerCase()

  useEffect(() => {
    let active = true
    api
      .get('/users/genres')
      .then((res) => {
        if (active) setOptions(res.data || [])
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  // Раскладка списка: сначала жанры, у которых своей ветки нет (Поп, Джаз,
  // Классика, Фонк...) — одним блоком БЕЗ заголовка, потому что заголовок над
  // одним чипом только шумит и врал бы («Поп» в группе «Другое»). Дальше —
  // ветки из нескольких тегов (Рок, Электроника, Хип-хоп) со своими подписями.
  // Внутри всё в порядке, который прислал бэкенд: популярность Last.fm.
  const groups = useMemo(() => {
    const byGroup = new Map()
    const visible = term
      ? options.filter(
          (option) =>
            option.label.toLowerCase().includes(term) ||
            option.key.includes(term) ||
            (option.group_label || '').toLowerCase().includes(term)
        )
      : options
    visible.forEach((option) => {
      const key = option.group || 'other'
      if (!byGroup.has(key)) {
        byGroup.set(key, { key, label: option.group_label || option.label, items: [] })
      }
      byGroup.get(key).items.push(option)
    })
    const families = []
    const loose = []
    byGroup.forEach((group) => {
      if (group.items.length > 1) families.push(group)
      else loose.push(...group.items)
    })
    return loose.length
      ? [{ key: 'loose', label: null, items: loose }, ...families]
      : families
  }, [options, term])

  const unusedDetected = useMemo(
    () => detected.filter((g) => !selected.includes(g)),
    [detected, selected]
  )

  const toggle = (key) => {
    onChange(
      selected.includes(key)
        ? selected.filter((g) => g !== key)
        : [...selected, key]
    )
  }

  if (loading && !options.length) {
    return <p className="pref-subtitle">Загружаем жанры…</p>
  }

  return (
    <div className="pref-section">
      <div className="pref-artist-input">
        <Search size={18} className="pref-artist-icon" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Найти жанр"
          aria-label="Найти жанр"
        />
      </div>

      {term && !groups.length && (
        <p className="pref-subtitle pref-hint">Такого жанра нет в списке.</p>
      )}

      <div className="pref-genre-list">
        {groups.map((group) => (
          <div className="pref-group" key={group.key}>
            {group.label && <div className="pref-group-label">{group.label}</div>}
            <div className="pref-genre-tiles">
              {group.items.map((option, index) => {
                const active = selected.includes(option.key)
                const fromHistory = detected.includes(option.key)
                return (
                  <button
                    type="button"
                    key={option.key}
                    className={`pref-genre-tile ${active ? 'active' : ''}`}
                    style={{ '--tile-hue': hueFor(option.group, group.key === 'loose' ? 0 : index) }}
                    onClick={() => toggle(option.key)}
                    aria-pressed={active}
                    title={fromHistory ? 'Определено по вашим прослушиваниям' : undefined}
                  >
                    <span className="pref-genre-label">{option.label}</span>
                    {fromHistory && !active && (
                      <span className="pref-genre-detected" aria-label="Определено по прослушиваниям">
                        <Sparkles size={14} />
                      </span>
                    )}
                    <span className="pref-genre-check" aria-hidden="true">
                      <Check size={14} strokeWidth={3} />
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {unusedDetected.length > 0 && (
        <button
          type="button"
          className="pref-apply-detected"
          onClick={() => onChange([...selected, ...unusedDetected])}
        >
          <Sparkles size={14} /> Добавить из прослушанного ({unusedDetected.length})
        </button>
      )}
    </div>
  )
}

export default GenreSelect
