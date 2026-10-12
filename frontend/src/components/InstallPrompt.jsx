import { useEffect, useState } from 'react'
import { Share, Plus, X } from 'lucide-react'
import { isIOS, isStandalone } from '../services/navigation'
import './InstallPrompt.css'

const DISMISSED_KEY = 'install-prompt-dismissed-at'
// После «Не сейчас» напоминаем не чаще раза в две недели.
const REPEAT_AFTER_MS = 14 * 24 * 60 * 60 * 1000
// Не встречаем подсказкой с порога: сначала даём человеку начать слушать.
const SHOW_DELAY_MS = 8000

function wasDismissedRecently() {
  try {
    const at = Number(localStorage.getItem(DISMISSED_KEY))
    return at > 0 && Date.now() - at < REPEAT_AFTER_MS
  } catch {
    return false
  }
}

// Подсказка для iOS: в Safari нет события установки, добавить на главный
// экран можно только вручную через «Поделиться». Без установки нет ни
// свайпов, ни нормального фонового воспроизведения.
function InstallPrompt() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!isIOS || isStandalone || wasDismissedRecently()) return undefined
    const timer = setTimeout(() => setVisible(true), SHOW_DELAY_MS)
    return () => clearTimeout(timer)
  }, [])

  if (!visible) return null

  const dismiss = () => {
    setVisible(false)
    try {
      localStorage.setItem(DISMISSED_KEY, String(Date.now()))
    } catch {
      // Приватный режим: просто не запомним.
    }
  }

  return (
    <div className="install-prompt" role="dialog" aria-label="Установка приложения">
      <div className="install-prompt-body">
        <p className="install-prompt-title">Добавь bolt на главный экран</p>
        <p className="install-prompt-text">
          Нажми <Share size={16} aria-label="«Поделиться»" className="install-prompt-glyph" /> внизу
          Safari, затем «На экран Домой»{' '}
          <Plus size={16} aria-hidden="true" className="install-prompt-glyph install-prompt-plus" />. Откроется как
          приложение, на весь экран.
        </p>
      </div>
      <button type="button" className="install-prompt-close" onClick={dismiss} aria-label="Закрыть подсказку">
        <X size={18} />
      </button>
    </div>
  )
}

export default InstallPrompt
