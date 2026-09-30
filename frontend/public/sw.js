// App-shell SW: кэширует только каркас (index.html, хэшированные ассеты,
// шрифты, иконки, сплэши) для мгновенного старта PWA и офлайн-заглушки.
//
// ГЛАВНОЕ ПРАВИЛО: аудио и API не перехватываем ВООБЩЕ (единственное
// исключение — обложки cover-proxy, см. COVER_CACHE). Прошлый аудио-SW
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

// Версию бампаем при смене состава кэшируемого каркаса: activate удаляет все
// кэши с другими именами. v2 — чтобы выселить два мастер-PNG по 331 КБ
// (favicon-64.png и apple-touch-icon.png), которые index.html больше не
// запрашивает: сами по себе они безвредны, но занимают квоту Cache Storage,
// а на iOS она самая тесная из всех платформ.
const CACHE_VERSION = 'bolt-shell-v2'
const PRECACHE = ['/', '/manifest.webmanifest']

// Обложки внешних треков (/api/tracks/cover-proxy) — отдельный кэш, cache-first.
// HTTP-кэш WebKit в standalone-PWA на iOS выселяется агрессивно: после
// сворачивания или перезапуска приложения обложки рекомендаций и истории
// качались заново, хотя ответ помечен max-age=86400. URL обложки иммутабелен
// (размер и качество зашиты в параметр url), поэтому ревалидация не нужна.
// Отдельное имя — чтобы бамп CACHE_VERSION каркаса не выбрасывал обложки.
// Потолок по числу записей: карточная обложка ~20-60 КБ, 400 штук — ~15 МБ,
// в тесную квоту Cache Storage на iOS укладывается.
const COVER_CACHE = 'bolt-covers-v1'
const COVER_CACHE_LIMIT = 400
const COVER_PATH = '/api/tracks/cover-proxy'
const KEEP_CACHES = new Set([CACHE_VERSION, COVER_CACHE])

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
      .then((keys) => Promise.all(keys.filter((k) => !KEEP_CACHES.has(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

function isCacheableAsset(url) {
  if (url.origin !== self.location.origin) return false
  return ASSET_CACHE_RE.test(url.pathname) || STATIC_CACHE_RE.test(url.pathname)
}

// Cache.keys() идёт в порядке вставки — выселяем самые старые записи.
function trimCoverCache(cache) {
  return cache.keys().then((keys) => {
    const excess = keys.length - COVER_CACHE_LIMIT
    if (excess <= 0) return undefined
    return Promise.all(keys.slice(0, excess).map((key) => cache.delete(key)))
  })
}

function coverResponse(event, request) {
  return caches.open(COVER_CACHE).then((cache) =>
    // ignoreVary: <img> (no-cors) и извлечение цвета (CORS) делят одну запись.
    cache.match(request.url, { ignoreVary: true }).then((cached) => {
      if (cached) return cached
      return fetch(request).then((response) => {
        const type = response.headers.get('content-type') || ''
        // Только полноценная картинка: ошибка CDN или заглушка не должны
        // закрепиться в кэше навсегда (у бэка на них короткий негативный TTL).
        if (response.ok && response.type === 'basic' && type.startsWith('image/')) {
          const copy = response.clone()
          event.waitUntil(
            cache
              .put(request.url, copy)
              .then(() => trimCoverCache(cache))
              .catch(() => {}),
          )
        }
        return response
      })
    }),
  )
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)

  if (url.origin === self.location.origin && url.pathname === COVER_PATH) {
    event.respondWith(coverResponse(event, request).catch(() => fetch(request)))
    return
  }

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
