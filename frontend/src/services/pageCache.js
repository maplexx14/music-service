import api from './api'
import { readUiSession, writeUiSession } from './uiSession'

// Кэш данных страниц в памяти (stale-while-revalidate). Роутер размонтирует
// страницу при уходе, и возврат на неё начинался со спиннера и повторного
// ожидания сети — даже когда данные только что были на экране. Теперь страница
// сразу рисует то, что видела в прошлый раз, и тихо обновляет это в фоне.
//
// В памяти — до конца сессии, недавние страницы — ещё и локально на 5 минут.
// Оба слоя чистятся на выходе и смене аккаунта.
const entries = new Map()
const inflight = new Map()
let generation = 0
// Подписчики на запись ключа: место вне страницы (сайдбар) следует за тем,
// что страница положила в кэш, не перезапрашивая сеть.
const listeners = new Map()

// Верхняя граница, чтобы долгая сессия с сотней открытых артистов не копила
// мегабайты: вытесняем самые старые записи.
const MAX_ENTRIES = 60
const DISK_FRESH_MS = 5 * 60000
const DISK_MAX_BYTES = 750000

function persistCache() {
  // Сохраняем только недавние страницы; длинные очереди не забивают storage.
  const recent = []
  let size = 0
  const stored = readUiSession('page-cache')
  const candidates = new Map(Array.isArray(stored) ? stored.filter((row) => Array.isArray(row) && typeof row[0] === 'string' && Number.isFinite(row[1]?.at)) : [])
  for (const [key, entry] of entries) candidates.set(key, entry)
  for (const [key, entry] of [...candidates].sort(([, a], [, b]) => b.at - a.at)) {
    if (Date.now() - entry.at > DISK_FRESH_MS) continue
    const bytes = JSON.stringify(entry).length
    if (size + bytes > DISK_MAX_BYTES) continue
    size += bytes
    recent.push([key, entry])
    if (recent.length === 12) break
  }
  writeUiSession('page-cache', recent.reverse())
}

export function peekCache(key) {
  if (!entries.has(key)) {
    const stored = readUiSession('page-cache')
    const entry = Array.isArray(stored) ? stored.find((row) => Array.isArray(row) && row[0] === key)?.[1] : null
    if (entry && Number.isFinite(entry.at) && Date.now() - entry.at < DISK_FRESH_MS) entries.set(key, entry)
  }
  return entries.get(key)?.data
}

// Возраст записи в мс (Infinity, если её нет) — страницы с дорогими внешними
// источниками не перезапрашивают свежий кэш.
export function cacheAge(key) {
  const entry = entries.get(key)
  return entry ? Date.now() - entry.at : Infinity
}

export function writeCache(key, data) {
  entries.delete(key)
  entries.set(key, { data, at: Date.now() })
  while (entries.size > MAX_ENTRIES) {
    entries.delete(entries.keys().next().value)
  }
  persistCache()
  listeners.get(key)?.forEach((fn) => fn(data))
}

// fn(data) — на каждую запись ключа. Возвращает отписку.
export function subscribeCache(key, fn) {
  if (!listeners.has(key)) listeners.set(key, new Set())
  listeners.get(key).add(fn)
  return () => listeners.get(key)?.delete(fn)
}

// Правка записи без продления её свежести: лайк или сохранение на странице
// меняют пару полей, а не делают остальные данные свежими.
export function patchCache(key, patch) {
  const entry = entries.get(key)
  if (entry) entry.data = { ...entry.data, ...patch }
  if (entry) persistCache()
}

export function invalidateCache(prefix) {
  for (const key of entries.keys()) {
    if (key.startsWith(prefix)) entries.delete(key)
  }
  const stored = readUiSession('page-cache')
  if (Array.isArray(stored)) writeUiSession('page-cache', stored.filter((row) => Array.isArray(row) && typeof row[0] === 'string' && !row[0].startsWith(prefix)))
}

export function clearPageCache() {
  generation += 1
  entries.clear()
  inflight.clear()
  writeUiSession('page-cache', [])
}

// Прогрев по намерению (наведение, касание): к моменту клика данные уже в
// кэше и страница открывается без спиннера. Свежую запись не трогаем, а
// одинаковые прогревы склеиваем. `select` превращает ответ в то, что страница
// кладёт в кэш сама, — формат записи должен совпадать.
export function prefetchCache(key, url, { params, select = (res) => res.data, maxAgeMs = 60000 } = {}) {
  if (cacheAge(key) < maxAgeMs || inflight.has(key)) return
  const startedIn = generation
  const request = api
    .get(url, { params, skipErrorToast: true })
    .then((response) => {
      if (generation === startedIn) writeCache(key, select(response))
    })
    .catch(() => {})
    .finally(() => {
      if (inflight.get(key) === request) inflight.delete(key)
    })
  inflight.set(key, request)
}

// Летит ли сейчас прогрев по намерению — тогда данные нового экрана могут
// успеть к началу перехода (services/navigation, waitForCommit).
export const prefetchInFlight = () => inflight.size > 0

// Наведение мышью прогревает с задержкой: курсор, пролетающий над списком,
// не должен рассылать запрос на каждую строку. Касание (pointerdown) — сразу.
const HOVER_DELAY_MS = 150

export function intentPrefetchHandlers(prefetch) {
  let timer = null
  const cancel = () => {
    if (timer !== null) {
      window.clearTimeout(timer)
      timer = null
    }
  }
  return {
    onPointerEnter: (e) => {
      if (e.pointerType !== 'mouse') return
      cancel()
      timer = window.setTimeout(() => {
        timer = null
        prefetch()
      }, HOVER_DELAY_MS)
    },
    onPointerLeave: cancel,
    onPointerDown: () => {
      cancel()
      prefetch()
    },
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('ui-session:changed', () => {
    generation += 1
    entries.clear()
    inflight.clear()
  })
  window.addEventListener('auth:unauthorized', clearPageCache)
}

// Ключи и загрузчики общие для страниц и мест, которые их прогревают.
export const LIBRARY_CACHE_KEY = 'playlists:me'
export const artistCacheKey = (name) => `artist:${name}`
export const prefetchArtist = (name) =>
  prefetchCache(artistCacheKey(name), '/artists', { params: { name }, maxAgeMs: 5 * 60000 })

export const PLAYLIST_PAGE_SIZE = 20
export const LIKED_CACHE_KEY = 'playlist:liked'
export const playlistCacheKey = (id) => `playlist:${id}`
export const prefetchPlaylist = (id) =>
  prefetchCache(playlistCacheKey(id), `/playlists/${id}`, {
    params: { skip: 0, limit: PLAYLIST_PAGE_SIZE },
    select: (response) => ({
      playlist: response.data,
      total: Number(response.headers['x-total-count']) || response.data.tracks.length,
    }),
  })
