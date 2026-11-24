const SLOP = 10
// Lighter response: a shorter drag or a gentler flick is enough to change disc.
const DISTANCE = 44
const FLICK_DISTANCE = 20
const VELOCITY_WINDOW = 80

export function createCdTrackSwipe(event) {
  return {
    x: event.clientX, y: event.clientY, axis: null, dx: 0,
    samples: [{ x: event.clientX, time: event.timeStamp }],
  }
}

export function updateCdTrackSwipe(swipe, event) {
  const dx = event.clientX - swipe.x
  const dy = event.clientY - swipe.y
  if (!swipe.axis && Math.max(Math.abs(dx), Math.abs(dy)) > SLOP) {
    swipe.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
  }
  swipe.dx = dx
  swipe.samples.push({ x: event.clientX, time: event.timeStamp })
  while (swipe.samples.length > 2 && event.timeStamp - swipe.samples[0].time > VELOCITY_WINDOW) swipe.samples.shift()
}

export function cdTrackSwipeVelocity(swipe, event) {
  if (!swipe) return 0
  const first = swipe.samples[0]
  const last = swipe.samples.at(-1)
  const elapsed = event.timeStamp - first.time
  return elapsed > 0 && event.timeStamp - last.time < 100 ? (event.clientX - first.x) / elapsed : 0
}

export function cdTrackSwipeDirection(swipe, event) {
  if (!swipe || event.type !== 'pointerup') return 0
  const dx = event.clientX - swipe.x
  const dy = event.clientY - swipe.y
  const axis = swipe.axis || (Math.abs(dx) > Math.abs(dy) ? 'x' : 'y')
  if (axis !== 'x') return 0
  const velocity = cdTrackSwipeVelocity(swipe, event)
  const flick = Math.abs(dx) > FLICK_DISTANCE && Math.abs(velocity) > 0.35 && Math.sign(velocity) === Math.sign(dx)
  return Math.abs(dx) >= DISTANCE || flick ? dx < 0 ? 1 : -1 : 0
}
