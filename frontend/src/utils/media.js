const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000/api'
const API_ORIGIN = API_BASE.replace(/\/api\/?$/, '')

export const resolveCoverUrl = (coverUrl) => {
  if (!coverUrl) return null
  if (coverUrl.startsWith('http')) return coverUrl
  if (coverUrl.startsWith('/')) return `${API_ORIGIN}${coverUrl}`
  return `${API_ORIGIN}/${coverUrl}`
}
