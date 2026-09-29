import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, X } from 'lucide-react'
import api from '../services/api'
import './ImportProgressModal.css'

const POLL_MS = 1000

const STAGE_LABELS = {
  fetching: 'Читаем коллекцию…',
  matching: 'Подбираем треки',
  saving: 'Сохраняем плейлист…',
  done: 'Готово',
  error: 'Ошибка импорта',
}

/** Id импорта, под которым бэкенд пишет прогресс (GET /import/progress/{id}). */
export function newImportId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID()
  return `imp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Окно прогресса импорта. Импорт идёт одним POST /import, а окно параллельно
 * опрашивает прогресс по importId. Закрыть окно можно — импорт продолжится,
 * итог придёт тостом, как и без окна.
 */
function ImportProgressModal({ importId, title, onClose }) {
  const [state, setState] = useState(null)

  useEffect(() => {
    if (!importId) return undefined
    let active = true
    let timer = null

    const poll = async () => {
      try {
        const { data } = await api.get(`/import/progress/${importId}`)
        if (active) setState(data)
      } catch {
        // 404 до первой записи прогресса — просто ждём следующего опроса.
      }
      if (active) timer = setTimeout(poll, POLL_MS)
    }
    poll()

    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [importId])

  if (!importId) return null

  const stage = state?.stage || 'fetching'
  const total = state?.total || 0
  const done = Math.min(state?.done || 0, total)
  const percent = total ? Math.round((done / total) * 100) : 0
  const indeterminate = !total || stage === 'fetching'
  const collectionsTotal = state?.collections_total || 0

  return createPortal(
    <div className="import-progress-overlay" role="dialog" aria-modal="true" aria-label="Импорт">
      <div className="import-progress-modal">
        <button
          type="button"
          className="import-progress-close"
          onClick={onClose}
          title="Скрыть — импорт продолжится"
        >
          <X size={18} />
        </button>

        <div className="import-progress-head">
          <Download size={20} />
          <span>{title || 'Импорт'}</span>
        </div>

        <div className="import-progress-stage">
          {STAGE_LABELS[stage] || STAGE_LABELS.fetching}
          {stage === 'matching' && total > 0 && ` · ${done} из ${total}`}
        </div>

        {state?.collection && (
          <div className="import-progress-collection">
            {collectionsTotal > 1 &&
              `${Math.min((state.collections_done || 0) + 1, collectionsTotal)}/${collectionsTotal} · `}
            {state.collection}
          </div>
        )}

        <div className={`import-progress-bar ${indeterminate ? 'indeterminate' : ''}`}>
          <div
            className="import-progress-fill"
            style={indeterminate ? undefined : { width: `${percent}%` }}
          />
        </div>
        {!indeterminate && <div className="import-progress-percent">{percent}%</div>}

        {stage === 'error' && state?.error && (
          <div className="import-progress-error">{state.error}</div>
        )}

        <p className="import-progress-hint">
          Треки подбираются в YouTube Music — большой плейлист может занять пару минут.
          Окно можно закрыть, импорт продолжится.
        </p>
      </div>
    </div>,
    document.body,
  )
}

export default ImportProgressModal
