const TAU = Math.PI * 2
export const DISC_REVOLUTION_SECONDS = 15
export const SOFTWARE_DISC_FPS = 60

// GPU composition samples the same native ramp as the DOM canvas.
export function discSpinAnimationDegrees(animation) {
  const frames = animation?.cdSpinFrames
  if (!frames?.length) return ((animation?.currentTime || 0) / (DISC_REVOLUTION_SECONDS * 1000)) * 360
  const phase = Math.max(0, Math.min(1, (animation.currentTime || 0) / animation.cdSpinDuration)) * (frames.length - 1)
  const index = Math.floor(phase), next = Math.min(index + 1, frames.length - 1)
  const start = parseFloat(frames[index].transform.slice(7))
  const end = parseFloat(frames[next].transform.slice(7))
  return (start + (end - start) * (phase - index)) * 180 / Math.PI
}

// Visual rotation has its own clock. Audio position updates refresh the stall
// deadline, but never rewind the picture or change its speed with track length.
export function createDiscSpin({ now = () => performance.now(), secondsPerTurn = DISC_REVOLUTION_SECONDS, stallMs = 3000, rampMs = 0 } = {}) {
  const speed = TAU / (secondsPerTurn * 1000)
  let anchor = 0
  let anchoredAt = now()
  let deadline = anchoredAt
  let enabled = true
  let playing = false
  let track = null
  let playbackTime = null
  let drag = null
  let runningMs = 0
  const travel = elapsed => {
    if (!(rampMs > 0)) return elapsed
    if (elapsed >= rampMs) return elapsed - rampMs / 2
    const phase = elapsed / rampMs
    return rampMs * (phase ** 3 - phase ** 4 / 2)
  }
  const elapsed = at => enabled && playing && track !== null && !drag
    ? Math.max(0, Math.min(at, deadline) - anchoredAt) : 0

  const angle = (at = now()) => drag ? drag.angle : anchor +
    (travel(runningMs + elapsed(at)) - travel(runningMs)) * speed
  const freeze = (at = now()) => { anchor = angle(at); runningMs += elapsed(at); anchoredAt = at }

  return {
    angle,
    rampRemainingMs: (at = now()) => Math.max(0, rampMs - runningMs - elapsed(at)),
    isAnimating: (at = now()) => enabled && playing && track !== null && !drag && at < deadline,
    remainingMs: (at = now()) => enabled && playing && track !== null && !drag ? Math.max(0, deadline - at) : 0,
    sync(state) {
      const at = now()
      freeze(at)
      const nextTrack = state.currentTrack?.id ?? state.currentTrack ?? null
      const changed = nextTrack !== track
      if (changed) { anchor = 0; drag = null; runningMs = 0 }
      const time = state.currentTime || 0
      if (changed || time !== playbackTime || (state.isPlaying && !playing)) deadline = at + stallMs
      track = nextTrack
      playbackTime = time
      playing = Boolean(state.isPlaying)
    },
    setEnabled(value) {
      if (value === enabled) return
      freeze()
      enabled = value
    },
    reset() {
      anchor = 0
      anchoredAt = now()
      drag = null
      runningMs = 0
    },
    hold(progress) {
      freeze()
      drag = { base: progress, start: anchor, angle: anchor }
    },
    turn(progress) {
      if (!drag) this.hold(progress)
      drag.angle = drag.start + (progress - drag.base) * TAU
    },
    release() {
      if (!drag) return
      anchor = drag.angle
      anchoredAt = now()
      drag = null
    },
  }
}
