// App-shell SW: кэширует только каркас (index.html, хэшированные ассеты,
// шрифты, иконки, сплэши) для мгновенного старта PWA и офлайн-заглушки.
//
// ГЛАВНОЕ ПРАВИЛО: аудио и API не перехватываем ВООБЩЕ. Прошлый аудио-SW
// ломал Range-запросы (пересобранный в SW Request теряет forbidden header
// names, плюс WebKit bug 189337) — см. комментарий в src/main.jsx. Любой
// запрос, который не попал в кэш-кандидаты, проходит насквозь к сети.
//
// Стратегии:
//   * навигация (HTML) — network-first с кэш-фолбэком: свежий деплой виден
//     сразу, офлайн — каркас из кэша;
//   * /assets/* — cache-first (имена хэшированы, immutable);
//   * прочая статика (шрифты, иконки, сплэши, манифест) — stale-while-
//     revalidate: отдаём из кэша мгновенно, фоном обновляем.

const CACHE_VERSION = 'bolt-shell-v1'
const PRECACHE = ['/', '/manifest.webmanifest']

const ASSET_CACHE_RE = /^\/assets\//
const STATIC_CACHE_RE = /^\/(fonts|apple-splash-|icon-|favicon-|apple-touch-icon|logoBolt|config\.js)/

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE))
      .catch(() => {}),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

function isCacheableAsset(url) {
  if (url.origin !== self.location.origin) return false
  return ASSET_CACHE_RE.test(url.pathname) || STATIC_CACHE_RE.test(url.pathname)
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)

  // Аудио/стримы/API — прозрачный passthrough. Сюда же попадают
  // кросс-доменные stream_url провайдеров: их резолв на бэке, кэш в SW
  // вреден (протухающие CDN-ссылки).
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/music_files/') || url.pathname.startsWith('/cover_files/')) return
  if (request.destination === 'audio' || request.destination === 'video' || request.destination === 'media') return
  if (request.headers.get('range')) return

  // Навигация: network-first, кэш-фолбэк для офлайна.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          caches.open(CACHE_VERSION).then((cache) => cache.put('/', copy)).catch(() => {})
          return response
        })
        .catch(() => caches.match('/').then((cached) => cached || Response.error())),
    )
    return
  }

  if (!isCacheableAsset(url)) return

  // Хэшированные ассеты — cache-first.
  if (ASSET_CACHE_RE.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone()
              caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy)).catch(() => {})
            }
            return response
          }),
      ),
    )
    return
  }

  // Прочая статика — stale-while-revalidate.
  event.respondWith(
    caches.match(request).then((cached) => {
      const refresh = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone()
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy)).catch(() => {})
          }
          return response
        })
        .catch(() => cached)
      return cached || refresh
    }),
  )
})
