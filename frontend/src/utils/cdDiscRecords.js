import { queueStep } from './playerQueue.js'

// A queue slot adopts the canvas that just left the deck. Keep its pixels and
// rotation intact instead of repainting a second representation of that CD.
const records = new Map()
const listeners = new Map()

export function subscribeCdDiscRecord(key, callback) {
  if (!listeners.has(key)) listeners.set(key, new Set())
  const callbacks = listeners.get(key)
  callbacks.add(callback)
  return () => { callbacks.delete(callback); if (!callbacks.size) listeners.delete(key) }
}

export const cdDiscRecordKey = (track, index) => `${index}:${track?.source || 'local'}:${track?.external_id || track?.id}`

// Desktop keeps two records on either side of the player. Mobile also shows
// the current track in its separate queue.
export function cdQueueRecords(state, mobile) {
  const preview = state.flowPreview || state.flowPreload
  const directions = mobile ? [-1, 0, 1] : [-2, -1, 1, 2]
  return directions.flatMap(direction => {
    let index = direction
    let track = direction >= 0 ? preview?.tracks?.[index] : null
    if (state.currentTrack) {
      index = direction === 0
        ? state.currentIndex
        : queueStep(state, Math.sign(direction), Math.abs(direction))?.index
      track = direction === 0 ? state.currentTrack : state.queue[index]
    }
    return track ? [{ track, direction, key: cdDiscRecordKey(track, index) }] : []
  })
}

export function parkCdDiscRecord(key, record) {
  records.get(key)?.settle?.()
  records.set(key, record)
  for (const callback of listeners.get(key) || []) callback()
  while (records.size > 16) {
    const oldest = records.keys().next().value
    records.get(oldest)?.settle?.()
    records.delete(oldest)
  }
}

export function takeCdDiscRecord(key) {
  const record = records.get(key)
  records.delete(key)
  return record
}
