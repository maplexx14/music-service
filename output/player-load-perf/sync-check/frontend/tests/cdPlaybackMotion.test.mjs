import assert from 'node:assert/strict'
import test from 'node:test'
import { createCdPlaybackMotion, cdPlaybackMotionKeyframes, cdPlaybackTransformAt, CD_PLAYBACK_MOTION_PERIOD, CD_PLAYBACK_MOTION_ANGLE, CD_PLAYBACK_MOTION_LEFT_ANGLE, CD_PLAYBACK_MOTION_PITCH } from '../src/utils/cdPlaybackMotion.js'

function environment(options = {}) {
  let at = 0, deadline = 1500, allowed = true, sequence = 0
  const timers = new Map(), animations = []
  const element = { animate(keyframes, options) {
    const animation = { keyframes, options, currentTime: 0, playState: 'running', plays: 0,
      effect: { setKeyframes(frames) { animation.keyframes = frames } },
      get startTime() { return this.playState === 'running' ? at - this.currentTime : null },
      set startTime(value) { this.currentTime = at - value },
      play() { this.playState = 'running'; this.plays++ },
      pause() { this.playState = 'paused' },
      cancel() { this.playState = 'idle' },
    }
    animations.push(animation)
    return animation
  } }
  const motion = createCdPlaybackMotion({
    ...options,
    element, canRun: () => allowed && at < deadline, remaining: () => deadline - at,
    schedule(callback, delay) {
      const id = ++sequence
      timers.set(id, { callback, at: at + delay })
      return id
    },
    cancel: id => timers.delete(id),
  })
  const step = target => {
    for (const animation of animations) if (animation.playState === 'running') animation.currentTime += target - at
    at = target
  }
  return {
    motion, timers, animations,
    beat() { deadline = at + 1500; motion.sync() },
    allow(value) { allowed = value; motion.sync() },
    advanceTo(target) {
      while (timers.size) {
        const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
        if (timer.at > target) break
        timers.delete(id)
        step(timer.at)
        timer.callback()
      }
      step(target)
    },
  }
}

test('disc seating holds the chassis still and resumes playback only after the landing ends', () => {
  let completions = 0
  const env = environment({ onSeatEnd: () => completions++ })
  env.motion.setEnabled(true)
  assert.equal(env.motion.seat(), true)
  const seat = env.animations.at(-1)
  assert.equal(seat.id, 'cd-player-disc-seat')
  assert.equal(seat.options.duration, 180)
  assert.equal(seat.options.composite, 'add')
  assert.equal(env.motion.status().running, false)
  env.beat()
  assert.equal(env.motion.status().running, false)
  seat.onfinish()
  assert.equal(env.motion.status().seating, false)
  assert.equal(env.motion.status().running, true)
  assert.equal(completions, 1)
})

test('a repeated skip cancels the old seating reaction and ignores a stale completion', () => {
  const env = environment()
  env.motion.setEnabled(true)
  env.motion.seat()
  const old = env.animations.at(-1), finish = old.onfinish
  env.motion.reset(true)
  env.motion.seat()
  finish()
  assert.equal(old.playState, 'idle')
  assert.equal(env.motion.status().seating, true)
  env.motion.dispose()
  assert.equal(env.animations.at(-1).playState, 'idle')
})

test('reduced motion prevents the seating effect', () => {
  const env = environment({ canAlign: () => false })
  assert.equal(env.motion.seat(), false)
  assert.equal(env.animations.length, 0)
})

test('the chassis follows a closed figure eight with visible horizontal and vertical perspective', () => {
  const frames = cdPlaybackMotionKeyframes()
  assert.equal(frames.length, 121)
  assert.equal(frames[0].transform, frames.at(-1).transform)
  assert.equal(frames[0].offset, 0)
  assert.equal(frames.at(-1).offset, 1)
  assert.ok(frames.every(frame => /^perspective\(1100px\) rotateY\(-?[\d.]+deg\) rotateX\(-?[\d.]+deg\) rotateZ\(-?[\d.]+deg\)$/.test(frame.transform)))
  const rotations = frames.map(frame => Number(frame.transform.match(/rotateY\(([^d]+)/)[1]))
  assert.ok(Math.max(...rotations) <= CD_PLAYBACK_MOTION_ANGLE)
  assert.ok(Math.min(...rotations) >= -CD_PLAYBACK_MOTION_LEFT_ANGLE)
  assert.ok(Math.max(...rotations) >= 19 && Math.min(...rotations) <= -11)
  const pitches = frames.map(frame => Number(frame.transform.match(/rotateX\(([^d]+)/)[1]))
  assert.ok(Math.max(...pitches) > 13.5 && Math.min(...pitches) < -13.5)
  assert.ok(pitches.every(pitch => Math.abs(pitch) <= CD_PLAYBACK_MOTION_PITCH))
  for (let i = 1; i < rotations.length; i++) assert.ok(Math.abs(rotations[i] - rotations[i - 1]) < 1.37)
})

test('audio ticks reuse one native animation and one deadline timer without restarting its phase', () => {
  const env = environment()
  assert.equal(env.animations.length, 0)
  env.motion.setEnabled(true)
  env.advanceTo(1000)
  env.beat()
  env.advanceTo(1400)
  assert.equal(env.animations.length, 1)
  assert.equal(env.animations[0].plays, 1)
  assert.equal(env.animations[0].currentTime, 1400)
  assert.equal(env.animations[0].options.easing, 'linear')
  assert.equal(env.timers.size, 1)
})

test('renderer fallback retargets motion without restarting playback or an active skip', () => {
  const env = environment({ skipTransform: angle => 'rotateY(' + angle + 'rad)' })
  env.motion.setEnabled(true)
  env.advanceTo(700)
  env.motion.skip('next')
  const before = env.motion.status(), timers = env.timers.size
  const target = {}
  env.motion.setElement(target)
  assert.deepEqual(env.motion.status(), before)
  assert.equal(env.timers.size, timers)
  assert.ok(env.animations.every(animation => animation.effect.target === target))
  env.motion.dispose()
  assert.ok(env.animations.every(animation => animation.playState === 'idle'))
})

test('swapping between the GPU projection and CSS shell preserves the held tilt and resumes its phase', () => {
  const env = environment()
  env.motion.setEnabled(true)
  env.advanceTo(900)
  env.motion.setEnabled(false)
  const held = env.motion.status(), transform = env.motion.transform()
  assert.ok(Math.abs(held.angle) > 1)
  const shell = {}, gpu = {}
  env.motion.setElement(shell)
  env.motion.sync()
  env.advanceTo(1200)
  assert.equal(env.motion.transform(), transform)
  assert.equal(env.motion.status().elapsed, held.elapsed)
  assert.equal(env.animations[0].effect.target, shell)
  env.motion.setElement(gpu)
  env.motion.setEnabled(true)
  assert.equal(env.motion.status().elapsed, held.elapsed)
  assert.equal(env.animations[0].effect.target, gpu)
  env.beat()
  env.advanceTo(1250)
  assert.equal(env.motion.status().elapsed, held.elapsed + 50)
  assert.equal(env.animations.length, 1)
})

test('native track skips preserve playback phase and carry their pose through a reversed skip', () => {
  const env = environment({ skipTransform: angle => 'rotateY(' + angle + 'rad)' })
  env.motion.setEnabled(true)
  env.advanceTo(700)
  assert.equal(env.motion.skip('next'), true)
  const first = env.animations[1]
  assert.equal(first.options.composite, 'add')
  assert.equal(first.options.duration, 1100)
  env.advanceTo(820)
  assert.equal(env.motion.skip('previous'), true)
  const reversed = env.animations[2]
  const firstAngle = Number(reversed.keyframes[0].transform.match(/rotateY\(([^r]+)/)[1])
  assert.ok(firstAngle > 0.27 && firstAngle < 0.29, 'Reversing retains the visible peak rather than snapping to neutral')
  assert.equal(first.playState, 'idle')
  assert.equal(env.animations[0].plays, 1)
  assert.equal(env.motion.status().elapsed, 820)
  assert.equal(env.timers.size, 1)
  env.advanceTo(1420)
  reversed.onfinish()
  assert.equal(env.motion.status().skipping, false)
  assert.equal(env.motion.status().elapsed, 1420)
  assert.equal(env.animations[0].plays, 1)
})

test('seeking cancels a paused player skip and aligns its current visible pose', () => {
  const from = 'rotateY(-12deg)'
  const env = environment({ skipTransform: angle => 'rotateY(' + angle + 'rad)', readTransform: () => from })
  assert.equal(env.motion.skip('next'), true)
  assert.equal(env.motion.status().running, false)
  assert.equal(env.timers.size, 0)
  env.motion.reset(false)
  assert.equal(env.animations[0].playState, 'idle')
  assert.equal(env.animations[1].keyframes[0].transform, from)
  assert.equal(env.motion.status().skipping, false)
  assert.equal(env.motion.status().aligning, true)
  assert.equal(env.timers.size, 0)
})

test('finishing a software skip realigns the new disc cadence once without a frame loop', () => {
  const cadence = { startTime: -7, playState: 'running' }
  let reads = 0
  const env = environment({ frameRate: 30, skipTransform: angle => 'rotateY(' + angle + 'rad)',
    cadenceAnimation: () => { reads++; return cadence } })
  env.motion.setEnabled(true)
  env.advanceTo(700)
  env.motion.skip('next')
  cadence.startTime = -11
  env.advanceTo(1350)
  const elapsed = env.motion.status().elapsed
  env.animations[1].onfinish()
  assert.equal(reads, 2)
  assert.ok(Math.abs(env.motion.status().elapsed - elapsed) <= 1000 / 60)
  assert.equal(env.animations[0].startTime, -11)
  assert.equal(env.animations[0].plays, 1)
  assert.equal(env.timers.size, 1)
})

test('a carousel reuses one paused native pose and returns to the preserved playback phase', () => {
  const env = environment({ skipTransform: angle => 'rotateY(' + angle + 'rad)' })
  env.motion.setEnabled(true)
  env.advanceTo(700)
  env.allow(false)
  assert.equal(env.motion.setCarouselAngle(0), true)
  const carousel = env.animations[1]
  assert.equal(carousel.playState, 'paused')
  assert.equal(carousel.options.composite, 'add')
  assert.equal(carousel.currentTime, 500)
  env.motion.setCarouselAngle(0.28)
  assert.ok(Math.abs(carousel.currentTime - 780) < 1e-8)
  env.motion.setCarouselAngle(-0.28)
  assert.ok(Math.abs(carousel.currentTime - 220) < 1e-8)
  assert.equal(env.animations.length, 2)
  assert.equal(env.timers.size, 0)
  env.motion.setCarouselAngle(0, false)
  env.allow(true)
  assert.equal(carousel.playState, 'idle')
  assert.equal(env.motion.status().elapsed, 700)
  assert.equal(env.motion.status().carousel, false)
})

test('changing the volume presentation cancels native skips and disposal ignores queued completion', () => {
  let visible = true
  const env = environment({ skipTransform: angle => 'rotateY(' + angle + 'rad)', canSkip: () => visible })
  env.motion.setEnabled(true)
  assert.equal(env.motion.skip('next'), true)
  visible = false
  env.motion.sync()
  assert.equal(env.animations[1].playState, 'idle')
  assert.equal(env.motion.skip('previous'), false)
  visible = true
  env.motion.skip('previous')
  const queuedFinish = env.animations[2].onfinish
  env.motion.dispose()
  queuedFinish()
  assert.ok(env.animations.every(animation => animation.playState === 'idle'))
  assert.equal(env.timers.size, 0)
})

test('CPU-only motion shares the disc cadence without rendering or adding a frame timer', () => {
  const env = environment({ frameRate: 30 })
  env.motion.setEnabled(true)
  env.advanceTo(1400)
  assert.equal(env.animations[0].options.easing, `steps(${CD_PLAYBACK_MOTION_PERIOD * 30 / 1000}, end)`)
  assert.equal(env.animations[0].plays, 1)
  assert.equal(env.timers.size, 1)
})

test('60Hz hardware motion shares the 30Hz disc phase without restarting on audio ticks', () => {
  const cadence = { startTime: -7, playState: 'running' }
  let reads = 0
  const env = environment({ frameRate: 60, cadenceAnimation: () => { reads++; return cadence } })
  env.motion.setEnabled(true)
  assert.equal(env.animations[0].options.easing, `steps(${CD_PLAYBACK_MOTION_PERIOD * 60 / 1000}, end)`)
  assert.equal(env.animations[0].startTime, cadence.startTime)
  env.advanceTo(1000)
  env.beat()
  assert.equal(reads, 1)
  assert.equal(env.animations[0].plays, 1)
  assert.equal(env.animations.length, 1)
  assert.equal(env.timers.size, 1)
})

test('software animations share frame boundaries with only a sub-frame phase adjustment on resume', () => {
  const cadence = { startTime: -7, playState: 'running' }
  let reads = 0
  const env = environment({ frameRate: 30, cadenceAnimation: () => { reads++; return cadence } })
  env.motion.setEnabled(true)
  assert.equal(env.animations[0].startTime, -7)
  env.advanceTo(1000)
  env.beat()
  assert.equal(reads, 1)
  env.motion.setEnabled(false)
  const stopped = env.motion.status().elapsed
  env.advanceTo(30100)
  cadence.startTime = 30100 - 10
  env.beat()
  env.motion.setEnabled(true)
  assert.ok(Math.abs(env.motion.status().elapsed - stopped) <= 1000 / 60)
  assert.equal(reads, 2)
  assert.equal(env.timers.size, 1)
})

test('a resized camera updates the lens without restarting playback or changing its paused pose', () => {
  let perspective = 900
  const env = environment({ perspective: () => perspective })
  env.motion.setEnabled(true)
  env.advanceTo(1000)
  env.motion.setEnabled(false)
  perspective = 600
  env.motion.sync()
  assert.equal(env.animations.length, 1)
  assert.equal(env.animations[0].currentTime, 1000)
  assert.equal(env.animations[0].playState, 'paused')
  assert.ok(env.animations[0].keyframes.every(frame => frame.transform.startsWith('perspective(600px)')))
})

test('seeking smoothly aligns the visible pose and holds neutral until the gesture is released', () => {
  const from = 'perspective(900px) rotateY(12deg) rotateX(-8deg) rotateZ(0.5deg)'
  let reads = 0
  const env = environment({ readTransform: () => { reads++; return from } })
  env.motion.setEnabled(true)
  env.advanceTo(800)
  env.allow(false)
  env.motion.reset(false)
  const [tilt, alignment] = env.animations
  assert.equal(tilt.playState, 'paused')
  assert.equal(tilt.currentTime, 0)
  assert.equal(alignment.keyframes[0].transform, from)
  assert.equal(alignment.keyframes.at(-1).transform, 'perspective(1100px) rotateY(0.00000deg) rotateX(0.00000deg) rotateZ(0.00000deg)')
  assert.equal(alignment.options.duration, 420)
  assert.equal(env.motion.status().aligning, true)
  assert.equal(env.timers.size, 0)
  env.beat()
  assert.equal(reads, 1)
  assert.equal(env.animations.length, 2)
  env.advanceTo(1100)
  alignment.onfinish()
  assert.equal(alignment.playState, 'idle')
  assert.equal(env.motion.status().aligning, false)
  assert.equal(tilt.currentTime, 0)
  assert.equal(tilt.playState, 'paused')
  assert.equal(env.timers.size, 0)
  env.allow(true)
  env.advanceTo(1400)
  assert.equal(tilt.currentTime, 300)
  assert.equal(env.timers.size, 1)
})

test('disc exchange waits for native alignment completion before moving its records', async () => {
  const env = environment({ readTransform: () => 'rotateY(12deg)' })
  env.motion.setEnabled(true)
  env.advanceTo(700)
  env.allow(false)
  env.motion.reset(false)
  let aligned = false
  const wait = env.motion.whenAligned().then(() => { aligned = true })
  await Promise.resolve()
  assert.equal(aligned, false)
  env.animations[1].onfinish()
  await wait
  assert.equal(aligned, true)
  assert.equal(env.motion.status().elapsed, 0)
  assert.equal(env.motion.status().running, false)
})

test('rapid skipping accelerates an existing alignment without jumping or extending its deadline', () => {
  const env = environment({ readTransform: () => 'rotateY(12deg)' })
  env.motion.setEnabled(true)
  env.advanceTo(700)
  env.allow(false)
  env.motion.reset(false)
  env.advanceTo(760)
  const alignment = env.animations[1], time = alignment.currentTime
  env.motion.expediteAlignment()
  assert.equal(alignment.currentTime, time)
  assert.ok((420 - time) / alignment.playbackRate <= 80)
  const rate = alignment.playbackRate
  alignment.currentTime += 40
  env.motion.expediteAlignment()
  assert.equal(alignment.playbackRate, rate, 'More skips cannot slow an already accelerated alignment')
  env.motion.dispose()
})

test('a small disc-exchange tilt uses its shorter alignment duration when accelerated', () => {
  const env = environment({ readTransform: () => 'rotateY(1deg)' })
  env.motion.setEnabled(true)
  env.allow(false)
  env.motion.reset(false, 120)
  const alignment = env.animations[1]
  assert.equal(alignment.options.duration, 120)
  alignment.currentTime = 40
  env.motion.expediteAlignment()
  assert.equal(alignment.playbackRate, 1)
  assert.equal(alignment.currentTime, 40)
  env.motion.dispose()
})

test('a brief seek cannot restart playback before its alignment finishes', () => {
  const env = environment({ readTransform: () => 'rotateY(12deg)' })
  env.motion.setEnabled(true)
  env.advanceTo(700)
  env.allow(false)
  env.motion.reset(false)
  env.allow(true)
  assert.equal(env.motion.status().running, false)
  assert.equal(env.timers.size, 0)
  env.advanceTo(1000)
  env.animations[1].onfinish()
  assert.equal(env.motion.status().running, true)
  assert.equal(env.motion.status().elapsed, 0)
})

test('hidden screens and reduced motion settle an in-progress seek alignment without background work', () => {
  let transitionsAllowed = true, reads = 0
  const env = environment({ canAlign: () => transitionsAllowed, readTransform: () => { reads++; return 'rotateY(12deg)' } })
  env.motion.setEnabled(true)
  env.advanceTo(700)
  env.allow(false)
  env.motion.reset(false)
  const alignment = env.animations[1]
  transitionsAllowed = false
  env.motion.sync()
  assert.equal(alignment.playState, 'idle')
  assert.equal(env.motion.status().aligning, false)
  assert.equal(env.motion.status().elapsed, 0)
  assert.equal(env.timers.size, 0)
  env.motion.reset(false)
  assert.equal(reads, 1)
  assert.equal(env.animations.length, 2)
})

test('disposing during seek alignment cancels both animations and ignores a queued finish callback', () => {
  const env = environment({ readTransform: () => 'rotateY(12deg)' })
  env.motion.setEnabled(true)
  env.advanceTo(700)
  env.allow(false)
  env.motion.reset(false)
  const onfinish = env.animations[1].onfinish
  env.motion.dispose()
  onfinish()
  assert.ok(env.animations.every(animation => animation.playState === 'idle'))
  assert.equal(env.motion.status().aligning, false)
  assert.equal(env.timers.size, 0)
})

test('pause retains the exact image pose and uses no background timers', () => {
  const env = environment()
  env.motion.setEnabled(true)
  env.advanceTo(1000)
  env.motion.setEnabled(false)
  const stopped = env.motion.status()
  env.advanceTo(30000)
  assert.deepEqual(env.motion.status(), stopped)
  assert.equal(env.timers.size, 0)
  env.beat()
  env.motion.setEnabled(true)
  env.advanceTo(30100)
  assert.equal(env.animations[0].currentTime, 1100)
  assert.equal(env.animations.length, 1)
})

test('hidden screens and reduced motion pause the native clock immediately', () => {
  const env = environment()
  env.motion.setEnabled(true)
  env.advanceTo(700)
  env.allow(false)
  env.advanceTo(10000)
  assert.equal(env.motion.status().running, false)
  assert.equal(env.animations[0].currentTime, 700)
  assert.equal(env.timers.size, 0)
})

test('stalled audio stops at its deadline without a polling or rendering loop', () => {
  const env = environment()
  env.motion.setEnabled(true)
  env.advanceTo(10000)
  assert.equal(env.motion.status().running, false)
  assert.equal(env.animations[0].currentTime, 1501)
  assert.equal(env.timers.size, 0)
})

test('disposal cancels the image animation and cannot recreate its clock', () => {
  const env = environment()
  env.motion.setEnabled(true)
  env.motion.dispose()
  env.motion.setEnabled(true)
  env.motion.sync()
  assert.equal(env.animations.length, 1)
  assert.equal(env.animations[0].playState, 'idle')
  assert.equal(env.timers.size, 0)
})

test('GPU motion samples the same angle interpolation as native keyframes', () => {
  const frames = cdPlaybackMotionKeyframes(975)
  const values = transform => [...transform.matchAll(/rotate[XYZ]\(([^)]+)deg\)/g)].map(match => Number(match[1]))
  for (const phase of [0, 0.005, 0.127, 0.25, 0.499, 0.755, 0.999]) {
    const index = Math.floor(phase * 120), mix = phase * 120 - index
    const a = values(frames[index].transform), b = values(frames[index + 1].transform)
    const sampled = values(cdPlaybackTransformAt(phase * CD_PLAYBACK_MOTION_PERIOD, 975))
    sampled.forEach((value, axis) => assert.ok(Math.abs(value - (a[axis] + (b[axis] - a[axis]) * mix)) < 1e-10))
  }
  assert.equal(cdPlaybackTransformAt(CD_PLAYBACK_MOTION_PERIOD, 975), cdPlaybackTransformAt(0, 975))
})
