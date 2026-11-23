// Match the release velocity and arrive with zero velocity on one timeline.
export function cdDiscSwipeRelease(from, to, velocity = 0) {
  const distance = to - from
  if (Math.abs(distance) < 0.5) return { duration: 1, easing: 'linear', fill: 'both' }
  const speed = Math.max(0, velocity * Math.sign(distance))
  const duration = Math.max(180, Math.min(340, Math.abs(distance) / Math.max(0.65, speed) * 0.8))
  const slope = Math.min(3, speed * duration / Math.abs(distance))
  return { duration, easing: `cubic-bezier(${1 / 3}, ${slope / 3}, ${2 / 3}, 1)`, fill: 'both' }
}
