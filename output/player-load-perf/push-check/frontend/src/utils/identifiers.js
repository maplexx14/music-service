const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

// Provider items keep their source-prefixed ID after materialization.
export function getTrackDbId(track) {
  if (isUuid(track?.db_id)) return track.db_id
  return isUuid(track?.id) ? track.id : null
}
