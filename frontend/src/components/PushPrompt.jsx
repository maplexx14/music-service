import { useEffect, useState } from 'react'
import { Bell, X } from 'lucide-react'
import { enablePush, pushPermission } from '../services/push'
import { toast } from '../store/toastStore'
import { isInstallPromptVisible } from '../services/installPrompt'
import './InstallPrompt.css'

const DISMISSED_KEY = 'push-prompt-dismissed-at'
// После «Не сейчас» снова спросим через две недели.
const REPEAT_AFTER_MS = 14 * 24 * 60 * 60 * 1000
// Не с порога: сначала человек успевает что-то послушать.
const SHOW_DELAY_MS = 45000

function wasDismissedRecently() {
  try {
    const at = Number(localStorage.getItem(DISMISSED_KEY))
    return at > 0 && Date.now() - at < REPEAT_AFTER_MS
  } catch {
    return false
  }
}

/**
 * Предложение включить уведомления. Системный запрос разрешения браузер
 * показывает один раз, а отказ уже не переспросить, — поэтому сначала своя
 * карточка с объяснением, системный запрос только по «Включить».
 */
function PushPrompt() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (pushPermission() !== 'default' || wasDismissedRecently()) return undefined
    // Подсказка установки занимает то же место — спросим в другой раз.
    const timer = setTimeout(() => setVisible(!isInstallPromptVisible()), SHOW_DELAY_MS)
    return () => clearTimeout(timer)
  }, [])

  if (!visible) return null

  const remember = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, String(Date.now()))
    } catch {
      // Приватный режим: просто не запомним.
    }
  }

  const dismiss = () => {
    setVisible(false)
    remember()
  }

  const enable = async () => {
    setVisible(false)
    const result = await enablePush()
    if (result === 'enabled') toast.success('Готово — сообщим о новых релизах')
    else remember()
  }

  return (
    <div className="install-prompt" role="dialog" aria-label="Уведомления">
      <div className="install-prompt-body">
        <p className="install-prompt-title">Сообщать о новых релизах?</p>
        <p className="install-prompt-text">
          Когда у ваших артистов выйдет новое — пришлём уведомление. Не чаще раза в день.
        </p>
        <div className="push-prompt-actions">
          <button type="button" className="btn btn--primary btn--sm" onClick={enable}>
            <Bell size={14} aria-hidden="true" /> Включить
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={dismiss}>
            Не сейчас
          </button>
        </div>
      </div>
      <button type="button" className="install-prompt-close" onClick={dismiss} aria-label="Закрыть">
        <X size={18} />
      </button>
    </div>
  )
}

export default PushPrompt
