import { useEffect, useMemo, useState } from 'react'
import { Check, Sparkles } from 'lucide-react'
import api from '../services/api'
import './PreferencePicker.css'

/**
 * Выбор любимых жанров. Каталог приходит с бэкенда (теги Last.fm + наши
 * ключи, см. lastfm_genres.py) и раскладывается по группам: тегов теперь
 * десятки, плоской простынёй чипов их читать невозможно.
 *
 * Контролируемый: selected = string[] ключей, onChange(next) получает новый
 * массив. detected — жанры, выведенные из прослушиваний (подсвечиваем).
 */
function GenreSelect({ selected = [], detected = [], onChange }) {
  const [options, setOptions] = useState([])
  const [loading, setLoading] = useState(true)

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
    options.forEach((option) => {
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
  }, [options])

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
      <div className="pref-genre-list">
        {groups.map((group) => (
          <div className="pref-group" key={group.key}>
            {group.label && <div className="pref-group-label">{group.label}</div>}
            <div className="pref-genres">
              {group.items.map((option) => {
                const active = selected.includes(option.key)
                const fromHistory = detected.includes(option.key)
                return (
                  <button
                    type="button"
                    key={option.key}
                    className={`pref-chip ${active ? 'active' : ''} ${
                      fromHistory ? 'detected' : ''
                    }`}
                    onClick={() => toggle(option.key)}
                    aria-pressed={active}
                    title={fromHistory ? 'Определено по вашим прослушиваниям' : undefined}
                  >
                    {active && <Check size={16} />}
                    {option.label}
                    {fromHistory && !active && <Sparkles size={14} />}
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
