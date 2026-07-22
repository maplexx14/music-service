// Единственная задача этого SW: подставлять заголовок tuna-skip-browser-warning
// к запросам за аудиопотоками. <audio src="..."> не умеет слать кастомные
// заголовки, поэтому раньше плеер сначала целиком скачивал файл через fetch()
// и только потом отдавал его <audio> как blob — трек не начинал играть, пока
// не докачается целиком. С этим SW браузер стримит файл напрямую по src с
// нативными Range-запросами (перемотка/старт почти мгновенные), а заголовок
// добавляется прозрачно на уровне сети.
const STREAM_PATTERN = /\/(stream|audio)(\/|$)/i

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  const { request } = event

  const url = new URL(request.url)
  if (!STREAM_PATTERN.test(url.pathname)) {
    return
  }

  // Кросс-орIGIN запросы Service Worker не может модифицировать —
  // fetch() внутри SW ломает CORS-контекст. Пропускаем: браузер
  // обработает запрос напрямую с правильными CORS-заголовками от сервера.
  if (url.origin !== self.location.origin) {
    return
  }

  event.respondWith(
    (async () => {

      try {
        const headers = new Headers(request.headers)
        headers.set('tuna-skip-browser-warning', '1')
        headers.set('ngrok-skip-browser-warning', '1')

        return await fetch(
          new Request(request, {
            headers,
            cache: 'no-store',
          }),
        )
      } catch {
        return fetch(request)
      }
    })(),
  )
})
