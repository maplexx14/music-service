// Установка PWA на Android: Chrome (и Samsung Internet, Edge) шлёт
// beforeinstallprompt, когда сайт устанавливаем. Сам он предлагает установку
// только пунктом в меню и изредка мини-баннером, так что событие ловим и
// показываем свою кнопку. Ловить надо с запуска: событие приходит один раз,
// часто раньше, чем смонтируется подсказка.

let deferred = null
const listeners = new Set()
// Видна ли сейчас подсказка установки: другие карточки в том же месте
// (уведомления) не вылезают поверх неё.
let promptVisible = false

export function setInstallPromptVisible(visible) {
  promptVisible = visible
}

export function isInstallPromptVisible() {
  return promptVisible
}

function notify() {
  listeners.forEach((fn) => fn(deferred !== null))
}

export function installInstallPromptCapture() {
  if (typeof window === 'undefined') return
  window.addEventListener('beforeinstallprompt', (event) => {
    // Без preventDefault Chrome может показать свой мини-баннер поверх нашей.
    event.preventDefault()
    deferred = event
    notify()
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    notify()
  })
}

export function canPromptInstall() {
  return deferred !== null
}

export function onInstallAvailability(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// Показывает системный диалог установки. prompt() одноразовый: после ответа
// событие сгорает, новое Chrome пришлёт сам, если юзер отказался.
export async function promptInstall() {
  const event = deferred
  if (!event) return 'unavailable'
  deferred = null
  notify()
  try {
    await event.prompt()
    const { outcome } = await event.userChoice
    return outcome
  } catch {
    return 'unavailable'
  }
}
