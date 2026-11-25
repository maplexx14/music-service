import { API_URL } from '../config'

// navigator.onLine на телефонах сообщает только о наличии сетевого интерфейса:
// с подключённым Wi-Fi без интернета он остаётся true. Поэтому доступность
// проверяем реальным запросом к /health, а события браузера используем как
// повод перепроверить состояние.
// На телефоне health-запрос может стоять в очереди за медиабайтами
// (в логах nginx — до 15 с при 2 МБ). Большой таймаут не даёт принять
// медленную сеть за отсутствие интернета.
const PROBE_TIMEOUT_MS = 12000
const ONLINE_POLL_MS = 30000
const OFFLINE_POLL_MS = 10000
const PROBE_URL = `${API_URL}/health`

const browserNavigator = typeof navigator !== 'undefined' ? navigator : null

let offline = browserNavigator?.onLine === false
let probePromise = null
let pollTimer = null
let monitorStarted = false
let consecutiveFailures = 0
const listeners = new Set()

function emit() {
  for (const listener of [...listeners]) listener()
}

function setOffline(next) {
  if (offline === next) return
  offline = next
  emit()
}

export function isOffline() {
  return offline
}

export function isOnline() {
  return !offline
}

export function subscribeConnectivity(listener) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

// Любой ответ сервера (даже 5xx) означает, что сеть до него есть.
// В офлайн-режим уходим только когда запрос не дошёл вовсе.
async function runProbe(confirm) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    await fetch(`${PROBE_URL}?probe=${Date.now()}`, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    consecutiveFailures = 0
    setOffline(false)
    return true
  } catch {
    consecutiveFailures += 1
    // Подтверждаем офлайн двумя провалами подряд: одиночный таймаут в
    // очереди за стримом не должен выкидывать пользователя в «Скачанные».
    if (browserNavigator?.onLine === false || !confirm || consecutiveFailures >= 2) setOffline(true)
    return false
  } finally {
    clearTimeout(timeout)
  }
}

export function probeConnectivity({ confirm = false } = {}) {
  if (typeof fetch !== 'function') return Promise.resolve(!offline)
  if (probePromise) return probePromise
  probePromise = runProbe(confirm).finally(() => { probePromise = null })
  return probePromise
}

// Успешный API-запрос — самый свежий признак того, что сеть работает.
export function markOnline() {
  consecutiveFailures = 0
  setOffline(false)
}

export function reportNetworkFailure(error) {
  if (error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError' || error?.name === 'AbortError') return
  if (browserNavigator?.onLine === false) {
    setOffline(true)
    return
  }
  // Запрос без ответа мог оборваться из-за переключения сети. Проверяем
  // отдельным лёгким запросом, чтобы не включить офлайн из-за случайного сбоя.
  if (!offline) probeConnectivity()
}

function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = setTimeout(async () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      schedulePoll()
      return
    }
    await probeConnectivity({ confirm: true })
    schedulePoll()
  }, offline ? OFFLINE_POLL_MS : ONLINE_POLL_MS)
}

export function startConnectivityMonitor(targetWindow = typeof window !== 'undefined' ? window : null) {
  if (monitorStarted || !targetWindow) return () => {}
  monitorStarted = true
  const onOffline = () => {
    setOffline(true)
  }
  const onOnline = () => { probeConnectivity({ confirm: true }) }
  const onVisible = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    probeConnectivity({ confirm: !offline })
  }
  targetWindow.addEventListener('online', onOnline)
  targetWindow.addEventListener('offline', onOffline)
  targetWindow.addEventListener('pageshow', onVisible)
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
  probeConnectivity()
  schedulePoll()
  return () => {
    monitorStarted = false
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = null
    targetWindow.removeEventListener('online', onOnline)
    targetWindow.removeEventListener('offline', onOffline)
    targetWindow.removeEventListener('pageshow', onVisible)
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
  }
}
