import { SERVER_URL } from '../config'

export const resolveCoverUrl = (coverUrl) => {
  if (!coverUrl) return null
  if (coverUrl.startsWith('http')) return coverUrl
  if (coverUrl.startsWith('/')) return `${SERVER_URL}${coverUrl}`
  return `${SERVER_URL}/${coverUrl}`
}
