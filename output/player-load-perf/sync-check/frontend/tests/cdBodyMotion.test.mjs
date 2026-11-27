import assert from 'node:assert/strict'
import test from 'node:test'
import { createCdBodyMotion, sampleCdBodyMotion, cdBodyKeyframes } from '../src/utils/cdBodyMotion.js'

test('control feedback has a visible peak and returns to its exact resting pose', () => {
  const next = createCdBodyMotion('shuffle')
  assert.ok(sampleCdBodyMotion(next, 65).position.x > 20)
  assert.ok(sampleCdBodyMotion(createCdBodyMotion('repeat'), 65).position.y < -20)
  assert.deepEqual(sampleCdBodyMotion(next, next.duration), {
    position: { x: 0, y: 0, scale: 0 }, velocity: { x: 0, y: 0, scale: 0 },
  })
})

test('interrupting motion preserves its visible position and carries its velocity into the next action', () => {
  const next = createCdBodyMotion('shuffle')
  const before = sampleCdBodyMotion(next, 120)
  const repeated = createCdBodyMotion('repeat', next, 120)
  assert.deepEqual(sampleCdBodyMotion(repeated, 0).position, before.position)
  assert.equal(repeated.velocity.x, before.velocity.x)
  assert.ok(repeated.velocity.y < before.velocity.y)
})

test('rapid control feedback stays bounded and its compositor frames remain finite', () => {
  let motion = createCdBodyMotion('shuffle')
  for (let index = 0; index < 30; index++) motion = createCdBodyMotion('shuffle', motion, 35)
  const frames = cdBodyKeyframes(motion)
  assert.equal(frames[0].offset, 0)
  assert.equal(frames.at(-1).offset, 1)
  assert.equal(frames.at(-1).transform, 'translate(0px, 0px) scale(1)')
  for (let time = 0; time <= motion.duration; time += 8) {
    const { position } = sampleCdBodyMotion(motion, time)
    assert.ok(Math.abs(position.x) < 100)
    assert.ok(1 + position.scale > 0.9 && 1 + position.scale < 1.25)
    assert.ok(Object.values(position).every(Number.isFinite))
  }
})

test('finished or unknown actions cannot revive stale motion', () => {
  const finished = createCdBodyMotion('shuffle')
  const resumed = createCdBodyMotion('repeat', finished, finished.duration + 100)
  assert.deepEqual(resumed.position, { x: 0, y: 0, scale: 0 })
  assert.equal(createCdBodyMotion('unknown'), null)
  assert.equal(createCdBodyMotion('play'), null, 'Playback must never pulse the chassis')
  assert.equal(createCdBodyMotion('pause'), null, 'Pausing must never pulse the chassis')
  assert.equal(createCdBodyMotion('next'), null, 'Skips must never use the old translation')
  assert.equal(createCdBodyMotion('previous'), null, 'Skips must never use the old translation')
})

