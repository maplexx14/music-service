// Единственная задача этого SW: подставлять заголовок tuna-skip-browser-warning
// к запросам за аудиопотоками. <audio src="..."> не умеет слать кастомные
// заголовки, поэтому раньше плеер сначала целиком скачивал файл через fetch()
// и только потом отдавал его <audio> как blob — трек не начинал играть, пока
// не докачается целиком. С этим SW браузер стримит файл напрямую по src с
// нативными Range-запросами (перемотка/старт почти мгновенные), а заголовок
// добавляется прозрачно на уровне сети.
const STREAM_PATTERN = /\/api\/(tracks\/\d+\/stream|ytdlp\/stream\/|soundcloud\/stream\/|soulseek\/stream\/)/

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (!STREAM_PATTERN.test(new URL(request.url).pathname)) return

  const headers = new Headers(request.headers)
  headers.set('tuna-skip-browser-warning', '1')
  headers.set('ngrok-skip-browser-warning', '1')

  event.respondWith(
    fetch(new Request(request, { headers })).catch(() => fetch(request)),
  )
})
