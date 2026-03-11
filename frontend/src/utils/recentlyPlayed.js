export const WINDOW_HOURS_DEFAULT = 48

export const normalizeLastPlayed = (track) => {
  if (!track) return null
  const raw = track.last_played || track.lastPlayedAt || track.lastPlayed || track.last_played_at
  if (!raw) return null
  const ts = typeof raw === 'string' ? Date.parse(raw) : raw
  return Number.isFinite(ts) ? ts : null
}

export const filterRecentTracks = (tracks, nowMs = Date.now(), windowHours = WINDOW_HOURS_DEFAULT) => {
  const cutoff = nowMs - windowHours * 60 * 60 * 1000
  return tracks.filter((track) => {
    const lastPlayed = normalizeLastPlayed(track)
    return lastPlayed !== null && lastPlayed >= cutoff
  })
}

export const sortRecentTracks = (tracks) => {
  return [...tracks].sort((a, b) => {
    const aTime = normalizeLastPlayed(a) || 0
    const bTime = normalizeLastPlayed(b) || 0
    return bTime - aTime
  })
}

export const formatTimeAgo = (lastPlayedMs, nowMs = Date.now()) => {
  if (!Number.isFinite(lastPlayedMs)) return 'Слушали недавно'
  const diffMs = Math.max(0, nowMs - lastPlayedMs)
  const minutes = Math.floor(diffMs / 60000)
  if (minutes < 1) return 'Слушали только что'
  if (minutes < 60) return `Слушали ${minutes} ${minutes === 1 ? 'минуту' : minutes < 5 ? 'минуты' : 'минут'} назад`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Слушали ${hours} ${hours === 1 ? 'час' : hours < 5 ? 'часа' : 'часов'} назад`
  const days = Math.floor(hours / 24)
  return `Слушали ${days} ${days === 1 ? 'день' : days < 5 ? 'дня' : 'дней'} назад`
}

export const buildRecentPlaylist = (tracks, nowMs = Date.now(), windowHours = WINDOW_HOURS_DEFAULT) => {
  return sortRecentTracks(filterRecentTracks(tracks, nowMs, windowHours))
}
