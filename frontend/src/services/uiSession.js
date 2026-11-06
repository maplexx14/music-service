// Локальный контекст интерфейса. Без токенов, отдельно для текущего аккаунта.
// Запись отложена, но уход в фон сохраняет последний кадр сразу.
export const UI_SESSION_KEY = 'bolt-ui-session-v1'
const MAX_AGE_MS = 48 * 60 * 60 * 1000
const MAX_BYTES = 1500000
let userId = null
let values = {}
let timer = null

function readStored(user) {
  try {
    const raw = localStorage.getItem(UI_SESSION_KEY)
    if (!raw || raw.length > MAX_BYTES) return {}
    const data = JSON.parse(raw)
    if (data.userId !== user || !Number.isFinite(data.savedAt) ||
        Date.now() - data.savedAt > MAX_AGE_MS || !data.values ||
        typeof data.values !== 'object' || Array.isArray(data.values)) return {}
    return data.values
  } catch {
    return {}
  }
}

export function flushUiSession() {
  clearTimeout(timer)
  timer = null
  if (userId === null) return
  try {
    const data = JSON.stringify({ userId, savedAt: Date.now(), values })
    if (data.length <= MAX_BYTES) localStorage.setItem(UI_SESSION_KEY, data)
  } catch {
    // Недоступное хранилище не мешает навигации в текущем окне.
  }
}

export function readUiSession(key) {
  return values[key]
}

export function writeUiSession(key, value) {
  if (userId === null) return
  values[key] = value
  // Скролл обновляет память каждый кадр. Сериализация всей сессии и
  // синхронная запись в localStorage — только после паузы, иначе длинный
  // свайп прерывался такой записью каждые 800 мс. Уход в фон сохраняет сразу.
  clearTimeout(timer)
  timer = setTimeout(flushUiSession, 800)
}

export function setUiSessionUser(nextUserId) {
  const next = nextUserId == null ? null : String(nextUserId)
  if (next === userId) return
  clearTimeout(timer)
  timer = null
  userId = next
  values = next === null ? {} : readStored(next)
  window.dispatchEvent(new Event('ui-session:changed'))
}

export function clearUiSession() {
  clearTimeout(timer)
  timer = null
  values = {}
  try { localStorage.removeItem(UI_SESSION_KEY) } catch { /* unavailable */ }
  window.dispatchEvent(new Event('ui-session:changed'))
}

if (typeof window !== 'undefined') {
  try {
    const auth = JSON.parse(localStorage.getItem('auth-storage') || 'null')
    if (auth?.token && auth.user?.id != null) {
      userId = String(auth.user.id)
      values = readStored(userId)
    }
  } catch { /* no session */ }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushUiSession()
  })
  window.addEventListener('pagehide', flushUiSession)
  window.addEventListener('auth:unauthorized', () => {
    clearUiSession()
    setUiSessionUser(null)
  })
}
