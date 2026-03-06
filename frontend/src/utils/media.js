const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000/api'
const API_ORIGIN = API_BASE.replace(/\/api\/?$/, '')
const CDN_URL = import.meta.env.VITE_CDN_URL

export const resolveCoverUrl = (coverUrl) => {
  if (!coverUrl) return null
  if (coverUrl.startsWith('http')) return coverUrl

  if (CDN_URL) {
    return `${CDN_URL}${coverUrl.startsWith('/') ? '' : '/'}${coverUrl}`
  }

  if (coverUrl.startsWith('/')) return `${API_ORIGIN}${coverUrl}`
  return `${API_ORIGIN}/${coverUrl}`
}

export const resolveTrackUrl = (track) => {
  if (!track) return undefined

  if (track.file_path?.startsWith('http')) {
    return track.file_path
  }

  if (track.file_path) {
    if (CDN_URL) {
      return `${CDN_URL}${track.file_path.startsWith('/') ? '' : '/'}${track.file_path}`
    }
    return `${API_ORIGIN}${track.file_path.startsWith('/') ? '' : '/'}${track.file_path}`
  }

  // Fallback if file_path is somehow missing but track.id is present
  if (track.id) {
    return `${API_BASE}/tracks/${track.id}/stream`
  }

  return undefined
}
