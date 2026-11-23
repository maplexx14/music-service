import assert from 'node:assert/strict'
import test from 'node:test'
import { createTrackCarouselMotion } from '../src/utils/trackCarouselMotion.js'
import { cubicBezier } from 'motion'

function environment({ css = true, easing = 'linear' } = {}) {
  let at = 0, progress = 0, sequence = 0
  const frames = new Map()
  const transition = { transitionProperty: 'transform', playState: 'running', effect: {
    getComputedTiming: () => ({ progress }), getKeyframes: () => [{ easing }],
  } }
  const strip = { style: { transition: 'transform 340ms cubic-bezier(0.23, 1, 0.32, 1)' }, getAnimations: () => css ? [transition] : [] }
  const motion = createTrackCarouselMotion({ now: () => at, clock: {
    subscribe(callback) { const id = ++sequence; frames.set(id, callback); return () => frames.delete(id) },
  } })
  return { motion, frames, strip, tick(time, fraction = time / 340) {
    at = time; progress = fraction
    for (const callback of [...frames.values()]) callback(at)
  } }
}

test('the dragged capsule and deck turn share one phase, including both directions and resistance', () => {
  const env = environment()
  for (const phase of [-0.5, -0.1, 0, 0.1, 0.5]) {
    env.motion.drag(phase)
    assert.equal(env.motion.getSnapshot().phase, phase)
    assert.ok(Math.abs(env.motion.getSnapshot().angle - 0.28 * Math.sin(phase * Math.PI)) < 1e-12)
  }
  assert.equal(env.frames.size, 0, 'Dragging does not start a second animation loop')
})

for (const hz of [60, 120, 144]) test(`a cancelled drag follows the actual CSS timing and returns together at ${hz} Hz`, () => {
  const env = environment()
  env.motion.drag(0.3)
  env.motion.settle(env.strip, { from: -120, span: 400, duration: 340 })
  for (let time = 0; time < 340; time += 1000 / hz) {
    const fraction = cubicBezier(0.23, 0.15, 0.32, 1)(time / 340)
    env.tick(time, fraction)
    assert.ok(Math.abs(env.motion.getSnapshot().phase - 0.3 * (1 - fraction)) < 1e-12)
  }
  env.tick(340, 1)
  assert.equal(env.motion.getSnapshot().angle, 0)
  assert.equal(env.motion.getSnapshot().active, false)
  assert.equal(env.frames.size, 0)
})

test('committing a swipe and rebasing the next capsule cannot replay the turn', () => {
  const env = environment()
  env.motion.settle(env.strip, { from: -120, to: -400, span: 400, duration: 340 })
  env.tick(170, 0.5)
  assert.ok(Math.abs(env.motion.getSnapshot().phase - 0.65) < 1e-12)
  env.tick(340, 1)
  env.motion.settle(env.strip, { from: 0, span: 400, duration: 0, arrivalDirection: 1 })
  assert.deepEqual(env.motion.getSnapshot(), { phase: 1, angle: 0, active: false })
  assert.equal(env.frames.size, 0)
})

test('button skips follow the incoming capsule in the same direction as swipes', () => {
  for (const dir of [-1, 1]) {
    const env = environment({ easing: 'cubic-bezier(0.23, 1, 0.32, 1)' })
    env.motion.settle(env.strip, { from: dir * 400, span: 400, duration: 340, arrivalDirection: dir })
    env.tick(100, 0.5)
    const fraction = cubicBezier(0.23, 1, 0.32, 1)(0.5)
    assert.ok(Math.abs(env.motion.getSnapshot().phase - dir * fraction) < 1e-12)
    assert.equal(Math.sign(env.motion.getSnapshot().angle), dir)
  }
})

test('interrupting a transition and disconnecting releases its clock and returns to rest', () => {
  const env = environment(), disconnect = env.motion.connect()
  env.motion.settle(env.strip, { from: -120, span: 400, duration: 340 })
  env.tick(100)
  env.motion.drag(-0.2)
  assert.equal(env.frames.size, 0)
  assert.equal(env.motion.getSnapshot().phase, -0.2)
  disconnect(); disconnect()
  assert.equal(env.motion.isConnected(), false)
  assert.deepEqual(env.motion.getSnapshot(), { phase: 0, angle: 0, active: false })
})

test('fallback timing and reduced motion finish without leaving a frame loop', () => {
  const env = environment({ css: false })
  env.motion.settle(env.strip, { from: -120, span: 400, duration: 340 })
  env.tick(170)
  assert.ok(env.motion.getSnapshot().phase > 0 && env.motion.getSnapshot().phase < 0.15)
  env.tick(340)
  assert.equal(env.frames.size, 0)
  env.motion.settle(env.strip, { from: -120, to: -400, span: 400, duration: 0 })
  assert.equal(env.motion.getSnapshot().angle, 0)
  assert.equal(env.frames.size, 0)
})
