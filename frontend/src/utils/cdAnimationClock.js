// All player surfaces sample the same refresh timestamp. Follow the display
// frequency so 60/120/144 Hz screens retain smooth, synchronized motion.
export function createCdAnimationClock({ requestFrame = callback => requestAnimationFrame(callback), cancelFrame = id => cancelAnimationFrame(id) } = {}) {
  const callbacks = new Set()
  let frame = 0
  const schedule = () => { if (!frame && callbacks.size) frame = requestFrame(tick) }
  const tick = at => {
    frame = 0
    for (const callback of [...callbacks]) if (callbacks.has(callback)) callback(at)
    schedule()
  }
  return {
    subscribe(callback) {
      callbacks.add(callback)
      schedule()
      return () => {
        callbacks.delete(callback)
        if (!callbacks.size) { cancelFrame(frame); frame = 0 }
      }
    },
  }
}

export const cdAnimationClock = createCdAnimationClock()
