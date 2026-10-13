import { useEffect } from 'react'
import { AlertTriangle, Check, Download, X } from 'lucide-react'
import { useImportStore, importIsFinal } from '../store/importStore'
import ImportProgressModal, { stageCounter } from './ImportProgressModal'
import './ImportProgressModal.css'

const STAGE_SHORT = {
  fetching: 'Читаем ссылку',
  matching: 'Подбор',
  saving: 'Сохранение',
}

function pillText(state) {
  if (state.stalled) return 'Импорт прервался'
  if (state.stage === 'done') return 'Импорт готов'
  if (state.stage === 'error') return 'Ошибка импорта'
  const counter = stageCounter(state)
  const label = STAGE_SHORT[state.stage] || STAGE_SHORT.fetching
  return counter ? `${label} · ${counter[0]} из ${counter[1]}` : `${label}…`
}

/**
 * Статус импортов на всё приложение: окно (ImportProgressModal) и плашка
 * внизу экрана, пока окно закрыто. Плашка видна на любой странице — юзер
 * знает, что импорт идёт, и не запускает его второй раз.
 */
function ImportTracker({ enabled }) {
  const imports = useImportStore((s) => s.imports)
  const openId = useImportStore((s) => s.openId)
  const open = useImportStore((s) => s.open)
  const dismiss = useImportStore((s) => s.dismiss)

  // После входа и перезагрузки — подхватить импорты, идущие на сервере.
  useEffect(() => {
    if (enabled) useImportStore.getState().resume()
    else useImportStore.getState().reset()
  }, [enabled])

  if (!enabled) return null

  const list = Object.values(imports)
  // Плашка — про самый свежий импорт; остальные открываются из окна по очереди.
  const latest = list[list.length - 1]

  return (
    <>
      <ImportProgressModal />
      {latest && !openId && (
        <div className="import-pill-container">
          <div className={`import-pill ${pillTone(latest.state)}`}>
            <button type="button" className="import-pill-main" onClick={() => open(latest.id)}>
              <PillIcon state={latest.state} />
              <span className="import-pill-text">
                <span className="import-pill-title">{latest.title || 'Импорт'}</span>
                <span className="import-pill-status">
                  {pillText(latest.state)}
                  {list.length > 1 && ` · ещё ${list.length - 1}`}
                </span>
              </span>
            </button>
            {importIsFinal(latest.state) && (
              <button
                type="button"
                className="import-pill-close"
                onClick={() => dismiss(latest.id)}
                aria-label="Убрать"
              >
                <X size={16} />
              </button>
            )}
            {!importIsFinal(latest.state) && <PillBar state={latest.state} />}
          </div>
        </div>
      )}
    </>
  )
}

function pillTone(state) {
  if (state.stage === 'done') return 'success'
  if (state.stalled || state.stage === 'error') return 'error'
  return ''
}

function PillIcon({ state }) {
  if (state.stage === 'done') return <Check size={18} className="import-pill-icon" />
  if (importIsFinal(state)) return <AlertTriangle size={18} className="import-pill-icon" />
  return <Download size={18} className="import-pill-icon" />
}

function PillBar({ state }) {
  const counter = stageCounter(state)
  return (
    <div className={`import-pill-bar ${counter ? '' : 'indeterminate'}`}>
      <div
        className="import-progress-fill"
        style={counter ? { width: `${Math.round((counter[0] / counter[1]) * 100)}%` } : undefined}
      />
    </div>
  )
}

export default ImportTracker
