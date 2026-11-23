// Only explicit local downloads use this handler; online streams pass through.
async function offlineResponse(request) {
  const cache = await caches.open('bolt-offline-v1')
  const response = await cache.match(request.url)
  if (!response) return new Response('Download unavailable', { status: 404 })
  const range = request.headers.get('range')
  if (!range) {
    const headers = new Headers(response.headers)
    headers.set('Accept-Ranges', 'bytes')
    return new Response(response.body, { headers })
  }
  const blob = await response.blob()
  const match = /^bytes=(\d*)-(\d*)$/.exec(range)
  const headers = new Headers(response.headers)
  headers.set('Accept-Ranges', 'bytes')
  const invalid = () => {
    headers.set('Content-Range', `bytes */${blob.size}`)
    headers.set('Content-Length', '0')
    return new Response(null, { status: 416, headers })
  }
  if (!match || (!match[1] && !match[2])) return invalid()
  const start = match[1] ? Number(match[1]) : Math.max(0, blob.size - Number(match[2]))
  const end = match[1] && match[2] ? Math.min(Number(match[2]), blob.size - 1) : blob.size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= blob.size) return invalid()
  headers.set('Content-Range', `bytes ${start}-${end}/${blob.size}`)
  headers.set('Content-Length', String(end - start + 1))
  return new Response(blob.slice(start, end + 1, blob.type), { status: 206, headers })
}
