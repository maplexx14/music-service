const READY_COVERS_MAX = 300
const readyCovers = new Set()
const listeners = new Map()

export const isCoverReady = (url) => Boolean(url) && readyCovers.has(url)

// All artwork consumers publish readiness only after decoding succeeds.
export function markCoverReady(url) {
  if (!url || readyCovers.has(url)) return
  readyCovers.add(url)
  if (readyCovers.size > READY_COVERS_MAX) readyCovers.delete(readyCovers.values().next().value)
  for (const listener of listeners.get(url) || []) listener()
}

export function subscribeCoverReady(url, listener) {
  if (!url) return () => {}
  if (!listeners.has(url)) listeners.set(url, new Set())
  const subscribers = listeners.get(url)
  subscribers.add(listener)
  return () => {
    subscribers.delete(listener)
    if (!subscribers.size) listeners.delete(url)
  }
}

export async function rememberCoverImage(image) {
  const url = image.getAttribute('src')
  try {
    if (typeof image.decode === 'function') await image.decode()
    if (image.naturalWidth > 0 && image.getAttribute('src') === url) markCoverReady(url)
  } catch {
    // A failed or replaced image must not be reused as decoded artwork.
  }
}
