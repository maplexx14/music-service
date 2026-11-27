import { API_URL, SERVER_URL } from '../config'
import { isUuid } from '../utils/identifiers'

export function onlineTrackUrl(track) {
  if (!track) return undefined
  if (isUuid(track.id)) {
    const prefix = { soulseek: '/soulseek/stream/', ytmusic: '/ytdlp/stream/' }[track.source]
    if (prefix && track.external_id) return `${API_URL}${prefix}${track.external_id}`
    return `${API_URL}/tracks/${track.id}/stream`
  }
  if (track.stream_url) return track.stream_url
  if (track.id) return `${API_URL}/tracks/${track.id}/stream`
  if (track.file_path?.startsWith('http')) return track.file_path
  if (track.file_path) return `${SERVER_URL}${track.file_path.startsWith('/') ? '' : '/'}${track.file_path}`
  return undefined
}
