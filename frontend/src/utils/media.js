import { SERVER_URL } from '../config'
import defaultCover from '../assets/default-cover.svg'

export const resolveCoverUrl = (coverUrl) => {
  if (!coverUrl) return null
  if (coverUrl.startsWith('http')) return coverUrl
  if (coverUrl.startsWith('/')) return `${SERVER_URL}${coverUrl}`
  return `${SERVER_URL}/${coverUrl}`
}

// Fallback to the default cover when a track/playlist image fails to load
// (broken URL, 404, etc.). Guarded to avoid an infinite loop if the default
// itself ever fails.
export const handleCoverError = (e) => {
  if (e.currentTarget.src.endsWith(defaultCover)) return
  e.currentTarget.src = defaultCover
}
