const OMEGA = 14
const DURATION = 650
export const CD_SKIP_MAX_ANGLE = 0.5
export const CD_SKIP_PEAK_MS = 1000 / OMEGA

export function sampleCdSoftwareSkip(motion, time = 0) {
  if (!motion || time >= DURATION) return { angle: 0, velocity: 0 }
  const seconds = Math.max(0, time) / 1000
  const coefficient = motion.velocity + OMEGA * motion.angle
  const decay = Math.exp(-OMEGA * seconds)
  return {
    angle: Math.max(-CD_SKIP_MAX_ANGLE, Math.min(CD_SKIP_MAX_ANGLE, (motion.angle + coefficient * seconds) * decay)),
    velocity: (motion.velocity - OMEGA * coefficient * seconds) * decay,
  }
}

export function createCdSoftwareSkip(action, previous = null, time = 0) {
  if (action !== 'next' && action !== 'previous') return null
  const { angle, velocity } = sampleCdSoftwareSkip(previous, time)
  const direction = action === 'next' ? 1 : -1
  const headroom = Math.max(0, 1 - angle * direction / CD_SKIP_MAX_ANGLE)
  const limit = CD_SKIP_MAX_ANGLE * Math.E * OMEGA
  return { angle, velocity: Math.max(-limit, Math.min(limit, velocity + direction * 0.28 * Math.E * OMEGA * headroom)), duration: DURATION }
}

// Reuse the original physical turn with affine CSS camera poses. The shared
// playback layer supplies the lens once, so all chassis surfaces keep depth.
export function cdVolumeSkipKeyframes(motion, transform) {
  return Array.from({ length: 61 }, (_, index) => {
    const offset = index / 60
    return { offset, transform: transform(sampleCdSoftwareSkip(motion, offset * motion.duration).angle) }
  })
}

