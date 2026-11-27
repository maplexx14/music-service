const OMEGA = 16
const DURATION = 560
const AXES = ['x', 'y', 'scale']
const LIMITS = { x: 60, y: 40, scale: 0.12 }
const IMPULSES = {
  shuffle: { x: 22, y: -12, scale: 0.045 },
  repeat: { y: -24, scale: 0.055 },
  volume: { x: 8, y: -8, scale: 0.035 },
  seek: { y: -14, scale: 0.045 },
}

export function sampleCdBodyMotion(motion, time = 0) {
  const position = { x: 0, y: 0, scale: 0 }
  const velocity = { x: 0, y: 0, scale: 0 }
  if (!motion || time >= motion.duration) return { position, velocity }
  const seconds = Math.max(0, time) / 1000
  const decay = Math.exp(-OMEGA * seconds)
  for (const axis of AXES) {
    const from = motion.position[axis]
    const speed = motion.velocity[axis]
    const coefficient = speed + OMEGA * from
    position[axis] = (from + coefficient * seconds) * decay
    velocity[axis] = (speed - OMEGA * coefficient * seconds) * decay
  }
  return { position, velocity }
}

export function createCdBodyMotion(action, previous = null, time = 0) {
  const impulse = IMPULSES[action]
  if (!impulse) return null
  const { position, velocity } = sampleCdBodyMotion(previous, time)
  for (const axis of AXES) {
    const limit = LIMITS[axis] * Math.E * OMEGA
    const kick = (impulse[axis] || 0) * Math.E * OMEGA
    const headroom = Math.max(0, 1 - position[axis] * Math.sign(kick) / LIMITS[axis])
    velocity[axis] = Math.max(-limit, Math.min(limit,
      velocity[axis] + kick * headroom))
  }
  return { position, velocity, duration: DURATION }
}

export function cdBodyKeyframes(motion) {
  // Precompute the physical curve once. WAAPI interpolates these frames on
  // the compositor, retaining velocity without a JS loop or layout reads.
  return Array.from({ length: 51 }, (_, index) => {
    const offset = index / 50
    const { position } = sampleCdBodyMotion(motion, offset * motion.duration)
    return {
      offset,
      transform: `translate(${position.x}px, ${position.y}px) scale(${1 + position.scale})`,
    }
  })
}
