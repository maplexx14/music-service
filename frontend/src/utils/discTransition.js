import { trackKeys } from './playerQueue'

function sameTrack(a, b) {
  const keys = trackKeys(a)
  return keys.length > 0 && trackKeys(b).some((key) => keys.includes(key))
}

// Use playback order, rather than database IDs, so shuffle and skipped dislikes
// preserve the direction. Metadata materialization is not a track change.
export function discNavigationDirection(previous, current) {
  if (!previous?.currentTrack || !current?.currentTrack ||
      sameTrack(previous.currentTrack, current.currentTrack)) return 0

  const shuffled = previous.isShuffle && previous.shuffledOrder.length > 0
  const order = shuffled ? previous.shuffledOrder : previous.queue.map((_, index) => index)
  const from = shuffled ? previous.currentShuffleIndex : previous.currentIndex
  const to = order.findIndex((index) => sameTrack(previous.queue[index], current.currentTrack))
  return from >= 0 && to >= 0 ? Math.sign(to - from) : 0
}
