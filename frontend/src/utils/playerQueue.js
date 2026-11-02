export function trackKeys(track) {
  if (!track) return []
  const keys = []
  const dbId = track.db_id ?? (typeof track.id === 'number' ? track.id : null)
  if (dbId != null) keys.push(`local:${dbId}`)
  if (track.source && track.external_id) keys.push(`${track.source}:${track.external_id}`)
  if (typeof track.id === 'string') keys.push(track.id)
  return [...new Set(keys)]
}

export function isDislikedTrack(state, track) {
  const dbId = track?.db_id ?? (typeof track?.id === 'number' ? track.id : null)
  return (dbId != null && state.dislikedTrackIds?.includes(dbId)) ||
    trackKeys(track).some((key) => state.dislikedTrackKeys?.includes(key))
}

// Preview and navigation use the same eligible positions, including shuffle.
export function queueStep(state, direction = 1, offset = 1) {
  const { queue, currentIndex, isShuffle, shuffledOrder, currentShuffleIndex } = state
  const shuffled = isShuffle && shuffledOrder.length > 0
  const order = shuffled ? shuffledOrder : queue.map((_, i) => i)
  let position = shuffled ? currentShuffleIndex : currentIndex
  while ((position += direction) >= 0 && position < order.length) {
    const index = order[position]
    if (!queue[index] || isDislikedTrack(state, queue[index])) continue
    if (--offset === 0) return { index, shuffleIndex: shuffled ? position : -1 }
  }
  return null
}
