import { resolveCoverUrl, handleCoverError } from '../utils/media'
import defaultCover from '../assets/default-cover.webp'
import './ImportCollectionPicker.css'

/**
 * Выбор коллекций при импорте профиля (Yandex Music): «Мне нравится» и
 * плейлисты владельца. Каждая выбранная коллекция станет отдельным плейлистом.
 * selected — Set ключей из preview.collections[].key.
 */
function ImportCollectionPicker({ collections, selected, onChange, disabled = false }) {
  const allSelected = collections.length > 0 && selected.size === collections.length

  const toggle = (key) => {
    const next = new Set(selected)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    onChange(next)
  }

  const toggleAll = () => {
    onChange(allSelected ? new Set() : new Set(collections.map((c) => c.key)))
  }

  return (
    <div className="import-collections">
      <label className="import-collections-all">
        <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={disabled} />
        Выбрать все ({collections.length})
      </label>
      <ul className="import-collections-list">
        {collections.map((c) => (
          <li key={c.key}>
            <label className="import-collection">
              <input
                type="checkbox"
                checked={selected.has(c.key)}
                onChange={() => toggle(c.key)}
                disabled={disabled}
              />
              <img
                src={resolveCoverUrl(c.cover_url, 'thumb') || defaultCover}
                alt=""
                className="import-collection-cover"
                loading="lazy"
                onError={handleCoverError}
              />
              <span className="import-collection-title">{c.title}</span>
              <span className="import-collection-count">{c.track_count}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Ключи всех коллекций превью — выбор по умолчанию. */
export function allCollectionKeys(preview) {
  return new Set((preview?.collections || []).map((c) => c.key))
}

/** Сколько треков в выбранных коллекциях. */
export function selectedTrackCount(preview, selected) {
  return (preview?.collections || [])
    .filter((c) => selected.has(c.key))
    .reduce((sum, c) => sum + c.track_count, 0)
}

export default ImportCollectionPicker
