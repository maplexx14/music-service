import assert from 'node:assert/strict'
import test from 'node:test'
import { createDiscSpin, discSpinAnimationDegrees, DISC_REVOLUTION_SECONDS } from '../src/utils/discSpin.js'

const TAU = Math.PI * 2
const speed = TAU / (DISC_REVOLUTION_SECONDS * 1000)

test('a new motor accelerates smoothly and reaches constant speed without losing its angle on audio ticks', () => {
  let at = 0
  const spin = createDiscSpin({ now: () => at, rampMs: 480 })
  spin.sync({ currentTrack: { id: 'new' }, isPlaying: true, currentTime: 0 })
  at = 120
  const first = spin.angle()
  at = 240
  const second = spin.angle()
  assert.ok(first > 0 && second > first * 2)
  spin.sync({ currentTrack: { id: 'new' }, isPlaying: true, currentTime: 0.24 })
  assert.ok(Math.abs(spin.angle() - second) < 1e-10)
  at = 480
  assert.ok(Math.abs(spin.angle() - 240 * speed) < 1e-10)
  assert.equal(spin.rampRemainingMs(), 0)
  at = 580
  assert.ok(Math.abs(spin.angle() - 340 * speed) < 1e-10)
})

test('pausing midway through motor acceleration freezes its angle and remaining ramp', () => {
  let at = 0
  const spin = createDiscSpin({ now: () => at, rampMs: 480 })
  const state = { currentTrack: { id: 'new' }, isPlaying: true, currentTime: 0 }
  spin.sync(state)
  at = 240
  spin.sync({ ...state, isPlaying: false })
  const angle = spin.angle()
  at = 1240
  assert.equal(spin.angle(), angle)
  assert.equal(spin.rampRemainingMs(), 240)
  spin.sync(state)
  at = 1480
  assert.ok(Math.abs(spin.angle() - 240 * speed) < 1e-10)
})

test('GPU composition samples the native acceleration frames instead of the paused steady animation', () => {
  const ramp = { currentTime: 240, cdSpinDuration: 480,
    cdSpinFrames: [{ transform: 'rotate(0rad)' }, { transform: 'rotate(0.1rad)' }, { transform: 'rotate(0.4rad)' }] }
  assert.ok(Math.abs(discSpinAnimationDegrees(ramp) - 0.1 * 180 / Math.PI) < 1e-10)
  ramp.currentTime = 360
  assert.ok(Math.abs(discSpinAnimationDegrees(ramp) - 0.25 * 180 / Math.PI) < 1e-10)
  assert.equal(discSpinAnimationDegrees({ currentTime: 7500 }), 180)
})
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`)
function setup(duration = 240) {
  let at = 0
  const spin = createDiscSpin({ now: () => at })
  let state = { currentTrack: { id: 'a', duration }, duration, currentTime: 0, isPlaying: true }
  spin.sync(state)
  return {
    spin, advance: (ms) => { at += ms },
    sync(update = {}) { state = { ...state, ...update }; spin.sync(state) },
  }
}

test('the disc completes a revolution in 15 seconds regardless of track length', () => {
  for (const duration of [90, 240, 600]) {
    const scene = setup(duration)
    for (let second = 1; second <= 15; second++) {
      scene.advance(1000)
      scene.sync({ currentTime: second })
      close(scene.spin.angle(), second * 1000 * speed)
    }
    close(scene.spin.angle(), TAU)
  }
})

test('a visual handoff resets its phase even while the audio track stays the same', () => {
  const scene = setup()
  scene.advance(700)
  scene.spin.setEnabled(false)
  scene.spin.reset()
  scene.advance(300)
  close(scene.spin.angle(), 0)
  scene.spin.setEnabled(true)
  close(scene.spin.angle(), 0)
  scene.advance(50)
  close(scene.spin.angle(), 50 * speed)
})

test('late audio updates, seeking and duration corrections never snap the rotating artwork', () => {
  const scene = setup()
  scene.advance(600)
  const before = scene.spin.angle()
  scene.sync({ currentTime: 0.2, duration: 300 })
  close(scene.spin.angle(), before)
  scene.sync({ currentTime: 120 })
  close(scene.spin.angle(), before)
  scene.advance(400)
  close(scene.spin.angle(), 1000 * speed)
})

test('pause and environment changes freeze the visible angle and resume without a jump', () => {
  const scene = setup()
  scene.advance(500)
  scene.sync({ isPlaying: false })
  scene.advance(2000)
  close(scene.spin.angle(), 500 * speed)
  scene.sync({ isPlaying: true })
  scene.advance(300)
  scene.spin.setEnabled(false)
  const held = scene.spin.angle()
  scene.advance(2000)
  scene.sync({ currentTime: 3 })
  close(scene.spin.angle(), held)
  scene.spin.setEnabled(true)
  close(scene.spin.angle(), held)
  scene.advance(200)
  close(scene.spin.angle(), held + 200 * speed)
})

test('buffering stops rotation at the deadline and fresh audio resumes from that same angle', () => {
  const scene = setup()
  assert.equal(scene.spin.remainingMs(), 3000)
  scene.advance(1000)
  assert.equal(scene.spin.remainingMs(), 2000)
  scene.advance(2000)
  close(scene.spin.angle(), 3000 * speed)
  assert.equal(scene.spin.isAnimating(), false)
  assert.equal(scene.spin.remainingMs(), 0)
  scene.sync({ currentTime: 1 })
  close(scene.spin.angle(), 3000 * speed)
  assert.equal(scene.spin.isAnimating(), true)
  assert.equal(scene.spin.remainingMs(), 3000)
  scene.advance(200)
  close(scene.spin.angle(), 3200 * speed)
})

test('a late one-second audio tick does not briefly freeze normal playback', () => {
  const scene = setup()
  scene.advance(1800)
  close(scene.spin.angle(), 1800 * speed)
  assert.equal(scene.spin.isAnimating(), true)
  scene.sync({ currentTime: 1.8 })
  scene.advance(1200)
  close(scene.spin.angle(), 3000 * speed)
})

test('dragging picks up the visible angle, follows the pointer and resumes smoothly after seeking', () => {
  const scene = setup()
  scene.advance(500)
  const before = scene.spin.angle()
  scene.spin.hold(0.25)
  close(scene.spin.angle(), before)
  scene.spin.turn(0.35)
  close(scene.spin.angle(), before + TAU * 0.1)
  scene.advance(1000)
  scene.sync({ currentTime: 84 })
  close(scene.spin.angle(), before + TAU * 0.1)
  assert.equal(scene.spin.isAnimating(), false)
  scene.spin.release()
  close(scene.spin.angle(), before + TAU * 0.1)
  scene.advance(200)
  close(scene.spin.angle(), before + TAU * 0.1 + 200 * speed)
})

test('switching tracks clears the previous rotation and any active gesture', () => {
  const scene = setup()
  scene.advance(500)
  scene.spin.hold(0.25)
  scene.spin.turn(0.7)
  scene.sync({ currentTrack: { id: 'b' }, currentTime: 0 })
  close(scene.spin.angle(), 0)
  assert.equal(scene.spin.isAnimating(), true)
  scene.advance(200)
  close(scene.spin.angle(), 200 * speed)
})
