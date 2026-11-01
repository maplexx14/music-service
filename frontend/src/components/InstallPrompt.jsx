import { useEffect, useState } from 'react'
import { Download, Share, Plus, X } from 'lucide-react'
import { isIOS, isStandalone } from '../services/navigation'
import { setInstallPromptVisible } from '../services/installPrompt'
import useAndroidRelease from '../hooks/useAndroidRelease'
import {
  ANDROID_RELEASE_DISMISSED_KEY,
  androidDownloadUrl,
  isAndroidReleaseBrowser,
  shouldShowAndroidRelease,
} from '../services/androidRelease'
import './InstallPrompt.css'

const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
// Внутри нашего APK (WebView с BoltAndroid в UA) предлагать нечего. Мост и так
// выдаёт standalone, но на старом WebView без document-start скрипта не успевает.
const isAndroid = isAndroidReleaseBrowser(ua)

const DISMISSED_KEY = 'install-prompt-dismissed-at'
// На iOS после «Не сейчас» напоминаем не чаще раза в две недели.
// На Android запоминаем версию: следующее обновление покажется снова.
const REPEAT_AFTER_MS = 14 * 24 * 60 * 60 * 1000
// Не встречаем подсказкой с порога: сначала даём человеку начать слушать.
// На Android короче: приложение — главное, что мы там предлагаем.
const SHOW_DELAY_MS = isAndroid ? 3000 : 8000

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

function dismissedAndroidVersion() {
  try {
    const code = Number(localStorage.getItem(ANDROID_RELEASE_DISMISSED_KEY))
    return Number.isSafeInteger(code) && code > 0 ? code : 0
  } catch {
    return 0
  }
}

// На iPad подсказка не нужна в широком окне — там десктопная раскладка.
const iosEligible = isIOS && typeof window !== 'undefined' && window.innerWidth <= 768

// iOS: инструкция установки PWA. Android-браузеры и PWA: новая версия APK
// из опубликованного манифеста. Нативное приложение проверяет обновления само.
function InstallPrompt() {
  const [delayPassed, setDelayPassed] = useState(false)
  const [iosDismissed, setIosDismissed] = useState(() => isStandalone || wasDismissedRecently())
  const [dismissedVersion, setDismissedVersion] = useState(dismissedAndroidVersion)
  const release = useAndroidRelease(isAndroid)
  const eligible = isAndroid
    ? shouldShowAndroidRelease(release, dismissedVersion)
    : iosEligible && !iosDismissed

  useEffect(() => {
    if (!eligible) return undefined
    const timer = setTimeout(() => setDelayPassed(true), SHOW_DELAY_MS)
    return () => clearTimeout(timer)
  }, [eligible])

  const visible = eligible && delayPassed

  useEffect(() => {
    setInstallPromptVisible(visible)
    return () => setInstallPromptVisible(false)
  }, [visible])

  if (!visible) return null

  const dismiss = () => {
    if (isAndroid) setDismissedVersion(release.versionCode)
    else setIosDismissed(true)
    try {
      if (isAndroid) localStorage.setItem(ANDROID_RELEASE_DISMISSED_KEY, String(release.versionCode))
      else localStorage.setItem(DISMISSED_KEY, String(Date.now()))
    } catch {
      // Приватный режим: просто не запомним.
    }
  }

  let title = 'Добавь bolt на главный экран'
  let body
  if (isAndroid) {
    title = 'Вышла новая версия bolt для Android'
    body = (
      <>
        <p className="install-prompt-text">
          Версия {release.versionName}. {release.notes}
        </p>
        <p className="install-prompt-text install-prompt-install-hint">
          Открой скачанный APK и разреши установку.
        </p>
        <div className="push-prompt-actions">
          <a className="btn btn--primary btn--sm" href={androidDownloadUrl(release)} download="bolt.apk" onClick={dismiss}>
            <Download size={14} aria-hidden="true" /> Скачать APK
          </a>
          <button type="button" className="btn btn--ghost btn--sm" onClick={dismiss}>
            Позже
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
    <div className="install-prompt" role="dialog" aria-label={isAndroid ? 'Новая версия для Android' : 'Установка приложения'}>
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
