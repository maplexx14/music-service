import { CD_SKIP_MAX_ANGLE, cdVolumeSkipKeyframes, createCdSoftwareSkip } from './cdSkipMotion.js'

export const CD_PLAYBACK_MOTION_PERIOD = 18000
export const CD_PLAYBACK_MOTION_ANGLE = 20
export const CD_PLAYBACK_MOTION_LEFT_ANGLE = 12
export const CD_PLAYBACK_MOTION_PITCH = 14

function playbackYaw(offset) {
  const wave = Math.sin(offset * Math.PI * 2)
  const midpoint = (CD_PLAYBACK_MOTION_ANGLE + CD_PLAYBACK_MOTION_LEFT_ANGLE) / 2
  const bias = (CD_PLAYBACK_MOTION_ANGLE - CD_PLAYBACK_MOTION_LEFT_ANGLE) / 2
  // A smooth asymmetric curve keeps velocity continuous through neutral.
  return wave * (midpoint + bias * wave)
}

export function cdPlaybackMotionKeyframes(perspective = 1100) {
  return Array.from({ length: 121 }, (_, index) => {
    const offset = index / 120
    const yaw = index === 120 ? 0 : playbackYaw(offset)
    const pitch = index === 120 ? 0 : Math.sin(offset * Math.PI * 4) * CD_PLAYBACK_MOTION_PITCH
    const roll = index === 120 ? 0 : -Math.sin(offset * Math.PI * 2) * 1.2
    return {
      offset,
      transform: 'perspective(' + perspective + 'px) rotateY(' + yaw.toFixed(5) + 'deg) rotateX(' + pitch.toFixed(5) + 'deg) rotateZ(' + roll.toFixed(5) + 'deg)',
    }
  })
}

export function cdPlaybackTransformAt(elapsed, perspective = 1100) {
  const phase = ((elapsed / CD_PLAYBACK_MOTION_PERIOD) % 1 + 1) % 1 * 120
  const index = Math.floor(phase), mix = phase - index
  const angles = offset => offset === 1 ? [0, 0, 0] : [playbackYaw(offset),
    Math.sin(offset * Math.PI * 4) * CD_PLAYBACK_MOTION_PITCH,
    -Math.sin(offset * Math.PI * 2) * 1.2]
  const start = angles(index / 120), end = angles((index + 1) / 120)
  const [yaw, pitch, roll] = start.map((value, axis) => {
    const a = Number(value.toFixed(5)), b = Number(end[axis].toFixed(5))
    return a + (b - a) * mix
  })
  return `perspective(${perspective}px) rotateY(${yaw}deg) rotateX(${pitch}deg) rotateZ(${roll}deg)`
}

// One native perspective animation moves all surfaces of the 3D chassis.
// The only timer is the audio-stall deadline; no frame loop or pose readback.
export function createCdPlaybackMotion({ element, canRun, remaining, frameRate = 0, cadenceAnimation, perspective = () => 1100,
  canAlign = () => true, readTransform = () => getComputedStyle(element).transform,
  skipTransform, canSkip = () => true,
  onSeatEnd = () => {},
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancel = id => clearTimeout(id),
}) {
  let enabled = false, disposed = false, animation = null, timer = null, alignment = null
  let skipAnimation = null, skipMotion = null, carouselAnimation = null, actionPerspective = 0
  let seating = null
  let needsAlignment = true
  let appliedPerspective = 0
  let alignmentDuration = 420
  const alignmentWaiters = new Set()
  const cancelAlignment = () => {
    if (!alignment) return
    alignment.onfinish = null
    alignment.cancel()
    alignment = null
    for (const resolve of alignmentWaiters) resolve()
    alignmentWaiters.clear()
  }
  const cancelSkip = () => {
    if (skipAnimation) { skipAnimation.onfinish = null; skipAnimation.cancel() }
    skipAnimation = skipMotion = null
  }
  const cancelCarousel = () => { carouselAnimation?.cancel(); carouselAnimation = null }
  const cancelSeating = () => {
    if (seating) { seating.onfinish = null; seating.cancel() }
    seating = null
  }
  const cancelActions = () => { cancelSkip(); cancelCarousel(); cancelSeating() }
  const sync = () => {
    if (timer !== null) cancel(timer)
    timer = null
    if (disposed) return
    const distance = perspective()
    if ((skipAnimation || carouselAnimation) && (!canAlign() || !canSkip() || distance !== actionPerspective)) cancelActions()
    if (animation && distance !== appliedPerspective) {
      animation.effect.setKeyframes(cdPlaybackMotionKeyframes(distance))
      appliedPerspective = distance
    }
    if (alignment && !canAlign()) cancelAlignment()
    if (seating && !canAlign()) cancelSeating()
    if (alignment || seating || !enabled || !canRun()) { animation?.pause(); needsAlignment = true; return }
    if (!animation) {
      if (typeof element?.animate !== 'function') return
      animation = element.animate(cdPlaybackMotionKeyframes(distance), {
        duration: CD_PLAYBACK_MOTION_PERIOD, iterations: Infinity,
        easing: frameRate > 0 ? `steps(${Math.max(1, Math.round(CD_PLAYBACK_MOTION_PERIOD * frameRate / 1000))}, end)` : 'linear',
      })
      animation.id = 'cd-player-playback-tilt'
      appliedPerspective = distance
      animation.pause()
    }
    if (animation.playState !== 'running') animation.play()
    if (frameRate > 0 && needsAlignment && Number.isFinite(animation.startTime)) {
      const cadence = cadenceAnimation?.()
      if (cadence?.playState === 'running' && Number.isFinite(cadence.startTime)) {
        const interval = 1000 / frameRate
        // Align update boundaries once per resume so the compositor can
        // present the disc and chassis in the same bounded frame.
        animation.startTime = cadence.startTime + Math.round((animation.startTime - cadence.startTime) / interval) * interval
        needsAlignment = false
      }
    }
    const delay = remaining?.()
    if (Number.isFinite(delay)) timer = schedule(sync, Math.max(20, delay + 1))
  }
  return {
    setElement(next) {
      if (!next || next === element) return
      for (const current of [animation, skipAnimation, carouselAnimation, alignment, seating]) if (current?.effect) current.effect.target = next
      element = next
    },
    setEnabled(value) { enabled = Boolean(value); sync() },
    sync,
    skip(action) {
      if (disposed || alignment || !canAlign() || !canSkip() || typeof skipTransform !== 'function' || typeof element?.animate !== 'function') return false
      const timeScale = 1100 / 650
      const motion = createCdSoftwareSkip(action, skipMotion, (skipAnimation?.currentTime || 0) / timeScale)
      if (!motion) return false
      cancelActions()
      skipMotion = motion
      skipAnimation = element.animate(cdVolumeSkipKeyframes(motion, skipTransform), {
        duration: motion.duration * timeScale, easing: 'linear', fill: 'both', composite: 'add',
      })
      skipAnimation.id = 'cd-player-track-skip'
      actionPerspective = perspective()
      const current = skipAnimation
      skipAnimation.onfinish = () => {
        if (skipAnimation === current) { cancelSkip(); needsAlignment = true; sync() }
      }
      sync()
      return true
    },
    setCarouselAngle(angle, moving = true) {
      if (!moving) { cancelCarousel(); sync(); return true }
      if (disposed || alignment || !Number.isFinite(angle) || !canAlign() || !canSkip() || typeof skipTransform !== 'function' || typeof element?.animate !== 'function') return false
      if (!carouselAnimation) {
        cancelSkip()
        const frames = Array.from({ length: 121 }, (_, index) => ({
          offset: index / 120, transform: skipTransform((index / 60 - 1) * CD_SKIP_MAX_ANGLE),
        }))
        carouselAnimation = element.animate(frames, { duration: 1000, easing: 'linear', fill: 'both', composite: 'add' })
        carouselAnimation.id = 'cd-player-carousel-turn'
        carouselAnimation.pause()
        actionPerspective = perspective()
      }
      carouselAnimation.currentTime = (Math.max(-CD_SKIP_MAX_ANGLE, Math.min(CD_SKIP_MAX_ANGLE, angle)) / CD_SKIP_MAX_ANGLE + 1) * 500
      return true
    },
    cancelActions,
    seat() {
      if (disposed || alignment || !canAlign() || typeof element?.animate !== 'function') return false
      cancelActions()
      seating = element.animate([
        { transform: 'translateZ(0px) scale(1)' },
        { offset: 0.42, transform: 'translateZ(-1.5px) scale(0.998)' },
        { transform: 'translateZ(0px) scale(1)' },
      ], { duration: 180, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)', composite: 'add' })
      seating.id = 'cd-player-disc-seat'
      const current = seating
      seating.onfinish = () => {
        if (seating !== current || disposed) return
        cancelSeating()
        sync()
        onSeatEnd()
      }
      sync()
      return true
    },
    whenAligned() {
      return alignment ? new Promise(resolve => alignmentWaiters.add(resolve)) : Promise.resolve()
    },
    expediteAlignment() {
      if (!alignment) return
      const rate = Math.max(alignment.playbackRate || 1, (alignmentDuration - (alignment.currentTime || 0)) / 80)
      if (alignment.updatePlaybackRate) alignment.updatePlaybackRate(rate)
      else alignment.playbackRate = rate
    },
    reset(immediate = true, duration = 420) {
      if (disposed) return
      // Capture once at gesture start. The compositor returns the chassis to
      // neutral while the existing seek camera turns to its frontal view.
      const from = (animation || skipAnimation || carouselAnimation || alignment) && !immediate && canAlign() ? readTransform() : null
      cancelActions()
      cancelAlignment()
      if (animation) { animation.pause(); animation.currentTime = 0 }
      if (from && from !== 'none') {
        alignmentDuration = duration
        alignment = element.animate([
          { transform: from }, { transform: cdPlaybackMotionKeyframes(perspective())[0].transform },
        ], { duration, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'both' })
        alignment.id = 'cd-player-seek-align'
        const current = alignment
        alignment.onfinish = () => {
          if (alignment !== current || disposed) return
          cancelAlignment()
          sync()
        }
      }
      sync()
    },
    status() {
      const elapsed = animation?.currentTime || 0
      return { running: animation?.playState === 'running', aligning: Boolean(alignment), seating: Boolean(seating),
        skipping: Boolean(skipAnimation), carousel: Boolean(carouselAnimation),
        angle: playbackYaw(elapsed / CD_PLAYBACK_MOTION_PERIOD),
        pitch: Math.sin(elapsed / CD_PLAYBACK_MOTION_PERIOD * Math.PI * 4) * CD_PLAYBACK_MOTION_PITCH, elapsed }
    },
    transform() {
      // Matching transform lists interpolate their angles in WAAPI. Sample
      // that same curve without synchronously resolving the whole page's CSS.
      if (frameRate || alignment || skipAnimation || carouselAnimation || seating) return null
      return cdPlaybackTransformAt(animation?.currentTime || 0, appliedPerspective || perspective())
    },
    dispose() {
      disposed = true
      if (timer !== null) cancel(timer)
      timer = null
      cancelActions()
      cancelAlignment()
      animation?.cancel()
    },
  }
}
