// Match the release velocity and return from a small overshoot on one timeline.
export function cdDiscSwipeRelease(from, to, velocity = 0) {
  const distance = to - from
  if (Math.abs(distance) < 0.5) return { duration: 1, easing: 'linear', fill: 'both' }
  const speed = Math.max(0, velocity * Math.sign(distance))
  // Longer than before, and the end control point is above 1: the disc
  // settles past its rest position for a moment, then comes back, like a
  // weighted record instead of a stop.
  const duration = Math.max(200, Math.min(420, Math.abs(distance) / Math.max(0.65, speed) * 0.9))
  const slope = Math.min(3, speed * duration / Math.abs(distance))
  return { duration, easing: `cubic-bezier(${1 / 3}, ${slope / 3}, ${2 / 3}, 1.12)`, fill: 'both' }
}
