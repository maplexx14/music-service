import { cubicBezier } from 'motion'
import { cdAnimationClock } from './cdAnimationClock.js'

const curves = {
  linear: value => value,
  ease: cubicBezier(0.25, 0.1, 0.25, 1),
  'ease-in': cubicBezier(0.42, 0, 1, 1),
  'ease-out': cubicBezier(0, 0, 0.58, 1),
  'ease-in-out': cubicBezier(0.42, 0, 0.58, 1),
}
const defaultCurve = cubicBezier(0.23, 1, 0.32, 1)
const curve = value => {
  const values = /cubic-bezier\(([^)]+)\)/.exec(value || '')?.[1].split(',').map(Number)
  return values?.length === 4 && values.every(Number.isFinite) ? cubicBezier(...values) : curves[value] || defaultCurve
}

// One navigation phase drives the capsule and the deck's existing turn.
// Read the capsule's CSS transition timing, including its release velocity.
export function createTrackCarouselMotion({ clock = cdAnimationClock, now = () => performance.now() } = {}) {
  const listeners = new Set()
  let controllers = 0, releaseFrame = null
  let snapshot = { phase: 0, angle: 0, active: false }
  const cancelFrame = () => { releaseFrame?.(); releaseFrame = null }
  const publish = (phase, active) => {
    phase = Math.max(-1, Math.min(1, Number.isFinite(phase) ? phase : 0))
    const angle = Math.abs(phase) < 1e-9 || Math.abs(phase) > 1 - 1e-9 ? 0 : Math.sin(phase * Math.PI) * 0.28
    snapshot = { phase, angle, active }
    for (const listener of listeners) listener(snapshot)
  }
  const stop = () => { cancelFrame(); publish(0, false) }
  return {
    connect() {
      controllers++
      let connected = true
      return () => {
        if (!connected) return
        connected = false
        if (--controllers === 0) stop()
      }
    },
    isConnected: () => controllers > 0,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      listener(snapshot)
      return () => listeners.delete(listener)
    },
    drag(phase) { cancelFrame(); publish(phase, true) },
    settle(strip, { from, to = 0, span, duration, arrivalDirection = 0 }) {
      cancelFrame()
      if (!(span > 0)) { stop(); return }
      const start = arrivalDirection ? arrivalDirection - from / span : -from / span
      const end = arrivalDirection || -to / span
      if (!duration || from === to) { publish(end, false); return }
      const transition = strip.getAnimations?.().find(animation => animation.transitionProperty === 'transform')
      const keyframeCurve = curve(transition?.effect?.getKeyframes?.()[0]?.easing || 'linear')
      const fallbackCurve = curve(strip.style.transition)
      const startedAt = now()
      publish(start, true)
      releaseFrame = clock.subscribe(at => {
        const elapsed = at - startedAt
        const timing = transition?.effect?.getComputedTiming?.()
        const progress = transition?.playState === 'finished' ? 1 : timing?.progress
        const fraction = progress == null ? fallbackCurve(Math.max(0, Math.min(1, elapsed / duration))) : keyframeCurve(progress)
        const finished = progress === 1 || progress == null && elapsed >= duration
        publish(finished ? end : start + (end - start) * fraction, !finished)
        if (finished) cancelFrame()
      })
    },
    stop,
  }
}

export const trackCarouselMotion = createTrackCarouselMotion()
