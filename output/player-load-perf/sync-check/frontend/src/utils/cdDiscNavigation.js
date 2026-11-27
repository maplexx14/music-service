import { queueStep } from './playerQueue.js'

const identity = track => track && `${track.source || 'local'}:${track.external_id || track.id}`

// Audio can advance several tracks during one visual shift. Walk the visible
// queue toward the latest selection, reusing its real adjacent records.
export function createCdDiscNavigation({ initial, move, apply, expedite = () => {},
  schedule = callback => requestAnimationFrame(callback), cancel = id => cancelAnimationFrame(id) }) {
  let visible = initial, desired = initial, moving = false, frame = null, disposed = false, version = 0, urgent = false
  const drain = () => {
    frame = null
    if (disposed || moving) return
    if (identity(visible.currentTrack) === identity(desired.currentTrack)) {
      visible = desired
      urgent = false
      apply(visible)
      return
    }
    const queue = desired.queue || []
    const index = queue.findIndex(track => identity(track) === identity(visible.currentTrack))
    const shuffled = desired.isShuffle && desired.shuffledOrder?.length > 0
    const position = shuffled ? desired.shuffledOrder.indexOf(index) : index
    const target = shuffled ? desired.currentShuffleIndex : desired.currentIndex
    const direction = position >= 0 ? Math.sign(target - position) || 1 : 1
    const step = position >= 0 ? queueStep({ ...desired, currentIndex: index, currentShuffleIndex: position }, direction) : null
    const next = step ? { ...desired, currentIndex: step.index, currentShuffleIndex: step.shuffleIndex,
      currentTrack: queue[step.index] } : desired
    const previous = index >= 0 ? { ...desired, currentIndex: index, currentShuffleIndex: position,
      currentTrack: visible.currentTrack } : visible
    const currentVersion = ++version
    let completed = false
    moving = true
    const started = move(direction, previous, next, () => {
      if (disposed || completed || currentVersion !== version) return
      completed = true
      moving = false
      visible = next
      apply(visible)
      // React places the next neighboring record before we read its position.
      frame = schedule(drain)
    })
    if (started === false && moving && currentVersion === version) {
      moving = false
      frame = schedule(drain)
      return
    }
    if (urgent && moving) expedite()
  }
  return {
    request(next) {
      if (disposed) return
      desired = next
      if (moving) { urgent = true; expedite(); return }
      if (frame === null) drain()
    },
    reset(next) {
      if (disposed) return
      version++
      if (frame !== null) cancel(frame)
      frame = null
      moving = false
      urgent = false
      visible = desired = next
      apply(next)
    },
    isBusy: () => moving || frame !== null || identity(visible.currentTrack) !== identity(desired.currentTrack),
    dispose() { disposed = true; version++; if (frame !== null) cancel(frame); frame = null },
  }
}
