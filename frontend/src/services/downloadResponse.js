// Media playback can leave a partial or conditional response in the HTTP
// cache. Downloads need a complete body and verify the range independently.
export async function validateDownloadResponse(response) {
  if (![200, 206].includes(response.status)) {
    let detail = ''
    if ((response.headers.get('content-type') || '').includes('application/json')) {
      try { const body = await response.json(); if (typeof body.detail === 'string') detail = body.detail } catch { /* Invalid error body. */ }
    }
    throw new Error(`${detail || 'Не удалось получить аудиофайл'} (HTTP ${response.status})`)
  }
  const type = response.headers.get('content-type') || ''
  if (!/^(audio\/|video\/|application\/octet-stream)/i.test(type)) throw new Error('Сервер вернул страницу или данные вместо аудиофайла')
  const range = response.headers.get('content-range')
  if (response.status === 206 || range) {
    const match = /^bytes 0-(\d+)\/(\d+)$/.exec(range || '')
    const end = Number(match?.[1]), total = Number(match?.[2])
    if (!match || !Number.isSafeInteger(total) || total <= 0 || end !== total - 1) throw new Error('Сервер отдал только часть аудиофайла. Попробуйте скачать ещё раз')
    return { type, total }
  }
  return { type, total: Number(response.headers.get('content-length')) || 0 }
}
