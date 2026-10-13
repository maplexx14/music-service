import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, Check, Download, X } from 'lucide-react'
import { useImportStore, importIsFinal } from '../store/importStore'
import './ImportProgressModal.css'

const STEPS = [
  { stage: 'fetching', label: 'Читаем ссылку' },
  { stage: 'matching', label: 'Подбираем треки' },
  { stage: 'saving', label: 'Сохраняем плейлист' },
]
const STAGE_ORDER = ['fetching', 'matching', 'saving', 'done']

export const formatDuration = (seconds) => {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s} с`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} мин ${String(s % 60).padStart(2, '0')} с`
  return `${Math.floor(m / 60)} ч ${m % 60} мин`
}

/** Счётчик текущего шага: [сделано, всего] или null, если шаг без счётчика. */
export function stageCounter(state) {
  if (state?.stage === 'matching' && state.total) return [Math.min(state.done || 0, state.total), state.total]
  if (state?.stage === 'saving' && state.save_total) {
    return [Math.min(state.saved || 0, state.save_total), state.save_total]
  }
  return null
}

/**
 * Оценка оставшегося времени по скорости текущего шага. Отсчёт — с момента,
 * когда окно увидело шаг: у бэкенда время начала шага не хранится.
 */
function useEta(id, state) {
  const mark = useRef(null)
  const counter = stageCounter(state)
  const now = Date.now() / 1000
  if (!counter) {
    mark.current = null
    return null
  }
  const [value, total] = counter
  if (!mark.current || mark.current.id !== id || mark.current.stage !== state.stage) {
    mark.current = { id, stage: state.stage, t: now, value }
    return null
  }
  const elapsed = now - mark.current.t
  const progressed = value - mark.current.value
  if (elapsed < 3 || progressed <= 0) return null
  return ((total - value) * elapsed) / progressed
}

/**
 * Окно статуса импорта. Импорт ведёт importStore — окно только показывает
 * его: закрыть окно можно, импорт продолжится, статус останется плашкой
 * внизу экрана (ImportStatusPill).
 */
function ImportProgressModal() {
  const navigate = useNavigate()
  const openId = useImportStore((s) => s.openId)
  const entry = useImportStore((s) => (s.openId ? s.imports[s.openId] : null))
  const close = useImportStore((s) => s.close)
  const dismiss = useImportStore((s) => s.dismiss)
  const eta = useEta(openId, entry?.state)

  if (!entry) return null

  const { state, title, lost } = entry
  const stage = state.stage || 'fetching'
  const final = importIsFinal(state)
  const counter = stageCounter(state)
  const percent = counter ? Math.round((counter[0] / counter[1]) * 100) : 0
  const stageIndex = STAGE_ORDER.indexOf(stage)
  const elapsed = state.started_at ? Date.now() / 1000 - state.started_at : 0
  const collectionsTotal = state.collections_total || 0
  const playlistIds = state.playlist_ids || []

  const hide = () => (final ? dismiss(entry.id) : close())
  const openResult = () => {
    dismiss(entry.id)
    navigate(playlistIds.length === 1 ? `/playlists/${playlistIds[0]}` : '/playlists')
  }

  return createPortal(
    <div
      className="import-progress-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Импорт"
      onClick={(e) => e.target === e.currentTarget && hide()}
    >
      <div className="import-progress-modal">
        <button
          type="button"
          className="import-progress-close"
          onClick={hide}
          aria-label={final ? 'Закрыть' : 'Скрыть — импорт продолжится'}
          title={final ? 'Закрыть' : 'Скрыть — импорт продолжится'}
        >
          <X size={18} />
        </button>

        <div className="import-progress-head">
          <Download size={20} />
          <span>{title || 'Импорт'}</span>
        </div>

        {collectionsTotal > 1 && state.collection && (
          <div className="import-progress-collection">
            Коллекция {Math.min((state.collections_done || 0) + 1, collectionsTotal)} из{' '}
            {collectionsTotal} · {state.collection}
          </div>
        )}

        {stage !== 'done' && !state.stalled && stage !== 'error' && (
          <ol className="import-progress-steps">
            {STEPS.map((step, index) => {
              const status = index < stageIndex ? 'done' : index === stageIndex ? 'active' : 'pending'
              const showCounter = status === 'active' && counter
              return (
                <li key={step.stage} className={`import-progress-step ${status}`}>
                  <span className="import-progress-step-mark" aria-hidden="true">
                    {status === 'done' ? <Check size={12} strokeWidth={3} /> : index + 1}
                  </span>
                  <span className="import-progress-step-label">{step.label}</span>
                  {showCounter && (
                    <span className="import-progress-step-count">
                      {counter[0]} из {counter[1]}
                    </span>
                  )}
                </li>
              )
            })}
          </ol>
        )}

        {!final && (
          <>
            <div className={`import-progress-bar ${counter ? '' : 'indeterminate'}`}>
              <div
                className="import-progress-fill"
                style={counter ? { width: `${percent}%` } : undefined}
              />
            </div>
            <div className="import-progress-meta">
              <span>Прошло {formatDuration(elapsed)}</span>
              <span>
                {counter && `${percent}%`}
                {eta != null && ` · осталось ~${formatDuration(eta)}`}
              </span>
            </div>
          </>
        )}

        {stage === 'done' && (
          <div className="import-progress-result success">
            <Check size={18} />
            <div>
              <div className="import-progress-result-title">Импорт готов</div>
              <div className="import-progress-result-text">
                {playlistIds.length > 1 && `Плейлистов: ${playlistIds.length}. `}
                Треков в плейлисте: {state.imported ?? 0}
                {state.skipped > 0 && `. Не нашлось: ${state.skipped}`}
              </div>
            </div>
          </div>
        )}

        {state.stalled && (
          <div className="import-progress-result warning">
            <AlertTriangle size={18} />
            <div>
              <div className="import-progress-result-title">Импорт прервался</div>
              <div className="import-progress-result-text">
                Сервер перезапускался, плейлист не создан. Запустите импорт ещё раз — уже
                подобранные треки запомнены, второй раз пойдёт быстрее.
              </div>
            </div>
          </div>
        )}

        {stage === 'error' && !state.stalled && (
          <div className="import-progress-result error">
            <AlertTriangle size={18} />
            <div>
              <div className="import-progress-result-title">Ошибка импорта</div>
              <div className="import-progress-result-text">{state.error || 'Не удалось импортировать'}</div>
            </div>
          </div>
        )}

        {stage === 'done' ? (
          <button type="button" className="btn btn--primary import-progress-action" onClick={openResult}>
            {playlistIds.length === 1 ? 'Открыть плейлист' : 'Открыть медиатеку'}
          </button>
        ) : final ? (
          <button type="button" className="btn btn--secondary import-progress-action" onClick={hide}>
            Закрыть
          </button>
        ) : (
          <p className="import-progress-hint">
            {lost && 'Связь со страницей прерывалась, но импорт идёт на сервере. '}
            Не запускайте импорт заново: окно можно закрыть или уйти со страницы — статус
            останется внизу экрана.
          </p>
        )}
      </div>
    </div>,
    document.body,
  )
}

export default ImportProgressModal
