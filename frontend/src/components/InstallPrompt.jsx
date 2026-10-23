import { useEffect, useState } from 'react'
import { Download, Share, Plus, X } from 'lucide-react'
import { isIOS, isStandalone } from '../services/navigation'
import { canPromptInstall, onInstallAvailability, promptInstall, setInstallPromptVisible } from '../services/installPrompt'
import './InstallPrompt.css'

const DISMISSED_KEY = 'install-prompt-dismissed-at'
// После «Не сейчас» напоминаем не чаще раза в две недели.
const REPEAT_AFTER_MS = 14 * 24 * 60 * 60 * 1000
// Не встречаем подсказкой с порога: сначала даём человеку начать слушать.
const SHOW_DELAY_MS = 8000

const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
const isAndroid = /Android/.test(ua)
// Сторонние браузеры на iOS (16.4+) тоже умеют «На экран Домой» через
// «Поделиться», но кнопка не внизу, как в Safari.
const isIOSOtherBrowser = /CriOS|FxiOS|EdgiOS|OPiOS|YaBrowser/.test(ua)
// Встроенные браузеры (Telegram, Instagram, приложение Google) — WKWebView
// без токена Safari/: оттуда на главный экран не добавить, только через Safari.
const isIOSInApp = !isIOSOtherBrowser && (/GSA\//.test(ua) || !/Safari\//.test(ua))

function wasDismissedRecently() {
  try {
    const at = Number(localStorage.getItem(DISMISSED_KEY))
    return at > 0 && Date.now() - at < REPEAT_AFTER_MS
  } catch {
    return false
  }
}

// На iPad подсказка не нужна в широком окне — там десктопная раскладка.
const iosEligible = isIOS && typeof window !== 'undefined' && window.innerWidth <= 768

// Подсказка «добавь на главный экран». iOS: события установки нет, только
// вручную через «Поделиться». Android: Chrome даёт beforeinstallprompt, и
// кнопка открывает системный диалог. Без установки нет ни свайпов, ни
// нормального фонового воспроизведения.
function InstallPrompt() {
  const [delayPassed, setDelayPassed] = useState(false)
  const [androidReady, setAndroidReady] = useState(() => isAndroid && canPromptInstall())
  const [dismissed, setDismissed] = useState(() => isStandalone || wasDismissedRecently())

  useEffect(() => {
    if (dismissed || !(iosEligible || isAndroid)) return undefined
    const timer = setTimeout(() => setDelayPassed(true), SHOW_DELAY_MS)
    const unsubscribe = isAndroid ? onInstallAvailability(setAndroidReady) : undefined
    return () => {
      clearTimeout(timer)
      unsubscribe?.()
    }
  }, [dismissed])

  const visible = !dismissed && delayPassed && (iosEligible || androidReady)

  useEffect(() => {
    setInstallPromptVisible(visible)
  }, [visible])

  if (!visible) return null

  const dismiss = () => {
    setDismissed(true)
    try {
      localStorage.setItem(DISMISSED_KEY, String(Date.now()))
    } catch {
      // Приватный режим: просто не запомним.
    }
  }

  const install = async () => {
    const outcome = await promptInstall()
    // Отказ в системном диалоге — тот же «Не сейчас».
    if (outcome === 'dismissed') dismiss()
    else setDismissed(true)
  }

  let title = 'Добавь bolt на главный экран'
  let body
  if (isAndroid) {
    title = 'Установи bolt как приложение'
    body = (
      <>
        <p className="install-prompt-text">Откроется на весь экран, без адресной строки браузера.</p>
        <div className="push-prompt-actions">
          <button type="button" className="btn btn--primary btn--sm" onClick={install}>
            <Download size={14} aria-hidden="true" /> Установить
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={dismiss}>
            Не сейчас
          </button>
        </div>
      </>
    )
  } else if (isIOSInApp) {
    title = 'Открой bolt в Safari'
    body = (
      <p className="install-prompt-text">
        Отсюда на главный экран не добавить. Открой ссылку в Safari через меню этого приложения, там нажми{' '}
        <Share size={16} aria-label="«Поделиться»" className="install-prompt-glyph" /> и «На экран Домой».
      </p>
    )
  } else if (isIOSOtherBrowser) {
    body = (
      <p className="install-prompt-text">
        Нажми <Share size={16} aria-label="«Поделиться»" className="install-prompt-glyph" /> в адресной строке или
        меню браузера, затем «На экран Домой»{' '}
        <Plus size={16} aria-hidden="true" className="install-prompt-glyph install-prompt-plus" />. Если такого пункта
        нет, открой bolt в Safari.
      </p>
    )
  } else {
    body = (
      <p className="install-prompt-text">
        Нажми <Share size={16} aria-label="«Поделиться»" className="install-prompt-glyph" /> внизу Safari, затем «На
        экран Домой» <Plus size={16} aria-hidden="true" className="install-prompt-glyph install-prompt-plus" />.
        Откроется как приложение, на весь экран.
      </p>
    )
  }

  return (
    <div className="install-prompt" role="dialog" aria-label="Установка приложения">
      <div className="install-prompt-body">
        <p className="install-prompt-title">{title}</p>
        {body}
      </div>
      <button type="button" className="install-prompt-close" onClick={dismiss} aria-label="Закрыть подсказку">
        <X size={18} />
      </button>
    </div>
  )
}

export default InstallPrompt
