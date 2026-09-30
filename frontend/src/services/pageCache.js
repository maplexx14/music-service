import api from './api'

// Кэш данных страниц в памяти (stale-while-revalidate). Роутер размонтирует
// страницу при уходе, и возврат на неё начинался со спиннера и повторного
// ожидания сети — даже когда данные только что были на экране. Теперь страница
// сразу рисует то, что видела в прошлый раз, и тихо обновляет это в фоне.
//
// Живёт только в памяти вкладки: переживает навигацию, но не перезагрузку, и
// чистится на выходе из аккаунта — выдача прошлого пользователя не должна
// встречать следующего.
const entries = new Map()
const inflight = new Map()

// Верхняя граница, чтобы долгая сессия с сотней открытых артистов не копила
// мегабайты: вытесняем самые старые записи.
const MAX_ENTRIES = 60

export function peekCache(key) {
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
}

// Правка записи без продления её свежести: лайк или сохранение на странице
// меняют пару полей, а не делают остальные данные свежими.
export function patchCache(key, patch) {
  const entry = entries.get(key)
  if (entry) entry.data = { ...entry.data, ...patch }
}

export function invalidateCache(prefix) {
  for (const key of entries.keys()) {
    if (key.startsWith(prefix)) entries.delete(key)
  }
}

export function clearPageCache() {
  entries.clear()
  inflight.clear()
}

// Прогрев по намерению (наведение, касание): к моменту клика данные уже в
// кэше и страница открывается без спиннера. Свежую запись не трогаем, а
// одинаковые прогревы склеиваем. `select` превращает ответ в то, что страница
// кладёт в кэш сама, — формат записи должен совпадать.
export function prefetchCache(key, url, { params, select = (res) => res.data, maxAgeMs = 60000 } = {}) {
  if (cacheAge(key) < maxAgeMs || inflight.has(key)) return
  const request = api
    .get(url, { params, skipErrorToast: true })
    .then((response) => writeCache(key, select(response)))
    .catch(() => {})
    .finally(() => inflight.delete(key))
  inflight.set(key, request)
}

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
  window.addEventListener('auth:unauthorized', clearPageCache)
}

// Ключи и загрузчики общие для страниц и мест, которые их прогревают.
export const LIBRARY_CACHE_KEY = 'playlists:me'
export const artistCacheKey = (name) => `artist:${name}`
export const prefetchArtist = (name) =>
  prefetchCache(artistCacheKey(name), '/artists', { params: { name }, maxAgeMs: 5 * 60000 })

export const PLAYLIST_PAGE_SIZE = 20
export const playlistCacheKey = (id) => `playlist:${id}`
export const prefetchPlaylist = (id) =>
  prefetchCache(playlistCacheKey(id), `/playlists/${id}`, {
    params: { skip: 0, limit: PLAYLIST_PAGE_SIZE },
    select: (response) => ({
      playlist: response.data,
      total: Number(response.headers['x-total-count']) || response.data.tracks.length,
    }),
  })
