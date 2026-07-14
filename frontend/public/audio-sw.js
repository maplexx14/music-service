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

  if (!STREAM_PATTERN.test(new URL(request.url).pathname)) {
    return
  }

  event.respondWith(
    (async () => {
      try {
        const headers = new Headers(request.headers)

        headers.set('tuna-skip-browser-warning', '1')
        headers.set('ngrok-skip-browser-warning', '1')

        // Сохраняем Range и остальные параметры media-запроса.
        // Для cross-origin/no-cors потока пользовательские заголовки могут
        // быть запрещены, поэтому в таком случае повторяем исходный запрос.
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