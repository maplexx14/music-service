import assert from 'node:assert/strict'
import test from 'node:test'
import { createCdAnimationClock } from '../src/utils/cdAnimationClock.js'

function environment() {
  let sequence = 0
  const frames = new Map()
  const clock = createCdAnimationClock({ requestFrame: callback => { const id = ++sequence; frames.set(id, callback); return id }, cancelFrame: id => frames.delete(id) })
  return { clock, frames, tick(at) { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(at)) } }
}
for (const hz of [60, 75, 90, 120, 144, 165]) test(`all player surfaces sample every refresh together on a ${hz} Hz display`, () => {
  const env = environment(), body = [], disc = [], queue = []
  const stopBody = env.clock.subscribe(at => body.push(at))
  const stopDisc = env.clock.subscribe(at => disc.push(at))
  const stopQueue = env.clock.subscribe(at => queue.push(at))
  assert.equal(env.frames.size, 1, 'Only one browser callback is scheduled')
  for (let frame = 0; frame <= hz * 2; frame++) env.tick(frame * 1000 / hz)
  assert.equal(body.length, hz * 2 + 1)
  assert.deepEqual(body, disc)
  assert.deepEqual(body, queue)
  stopBody(); stopDisc(); stopQueue()
  assert.equal(env.frames.size, 0, 'A paused or hidden player leaves no frame loop')
})
test('a stopped surface cannot update later in the same frame or revive a cancelled loop', () => {
  const env = environment(), calls = []
  let stopSecond
  const stopFirst = env.clock.subscribe(() => { calls.push('first'); stopSecond() })
  stopSecond = env.clock.subscribe(() => calls.push('second'))
  env.tick(0)
  assert.deepEqual(calls, ['first'])
  stopFirst()
  env.tick(100)
  assert.equal(calls.length, 1)
  const stopNew = env.clock.subscribe(() => calls.push('new'))
  env.tick(105)
  assert.deepEqual(calls, ['first', 'new'])
  stopNew()
  assert.equal(env.frames.size, 0)
})
