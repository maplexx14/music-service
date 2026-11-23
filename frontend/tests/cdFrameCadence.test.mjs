import assert from 'node:assert/strict'
import test from 'node:test'
import { createCdFrameCadence } from '../src/utils/cdFrameCadence.js'

const refreshRates = [60, 75, 90, 120, 144, 165, 240]

for (const hz of refreshRates) {
  test(`motion renders every ${hz} Hz refresh regardless of the playback budget`, () => {
    for (const fps of [24, 60]) {
      const clock = createCdFrameCadence()
      // Enter motion after the resting limiter has already set a deadline.
      clock.shouldRender(0, fps)
      for (let index = 1; index <= hz * 2; index++) {
        assert.equal(clock.shouldRender(index * 1000 / hz, fps, false, true), true)
      }
    }
  })
}

test('playback retains its 24/30/60 fps budget at each refresh rate', () => {
  for (const hz of refreshRates) {
    for (const fps of [24, 30, 60]) {
      const clock = createCdFrameCadence()
      let frames = 0
      for (let index = 0; index < hz * 4; index++) {
        if (clock.shouldRender(index * 1000 / hz, fps)) frames++
      }
      assert.ok(Math.abs(frames - fps * 4) <= 1, `${hz} Hz / ${fps} fps drew ${frames} frames`)
    }
  }
})

test('immediate state changes render next refresh and motion leaves no playback catch-up burst', () => {
  const clock = createCdFrameCadence(), step = 1000 / 144
  clock.shouldRender(0, 24)
  assert.equal(clock.shouldRender(step, 24), false)
  assert.equal(clock.shouldRender(step, 24, true), true)
  for (let index = 2; index <= 288; index++) {
    assert.equal(clock.shouldRender(index * step, 24, false, true), true)
  }
  assert.equal(clock.shouldRender(289 * step, 24), true)
  for (let index = 290; index < 295; index++) assert.equal(clock.shouldRender(index * step, 24), false)
  assert.equal(clock.shouldRender(295 * step, 24), true)
})

test('a delayed motion frame and its following refresh both render', () => {
  const clock = createCdFrameCadence(), step = 1000 / 144
  for (let index = 0; index <= 20; index++) clock.shouldRender(index * step, 60, false, true)
  assert.equal(clock.shouldRender(26 * step, 60, false, true), true)
  assert.equal(clock.shouldRender(27 * step, 60, false, true), true)
})
