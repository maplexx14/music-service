import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDeviceTilt } from '../src/utils/deviceTilt.js'

const rad = degrees => degrees * Math.PI / 180
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is near ${expected}`)
const sample = (beta = 0, gamma = 0, alpha = 0) => ({ alpha, beta, gamma })

test('the initial phone pose is neutral, regardless of how it is held', () => {
  const tilt = createDeviceTilt()
  assert.deepEqual(tilt.sample(sample(73, -18, 245)), { theta: 0, phi: 0 })
  near(tilt.sample(sample(73, -18, 245)).theta, 0)
  near(tilt.sample(sample(73, -18, 245)).phi, 0)
})

test('relative phone tilt maps to the camera with bounded sensitivity', () => {
  const tilt = createDeviceTilt()
  tilt.sample(sample())
  near(tilt.sample(sample(0, 10)).theta, rad(-5.5))
  near(tilt.sample(sample(10, 0)).phi, rad(4))
  near(tilt.sample(sample(0, 80)).theta, rad(-12))
  near(tilt.sample(sample(80, 0)).phi, rad(8))
})

test('crossing the upright pose stays continuous', () => {
  const tilt = createDeviceTilt()
  tilt.sample(sample(89, 0, 35))
  near(tilt.sample(sample(91, 0, 35)).phi, rad(0.8))
  near(tilt.sample(sample(91, 0, 35)).theta, 0)
})

test('heading wrap does not turn a two-degree movement into a full revolution', () => {
  const tilt = createDeviceTilt()
  tilt.sample(sample(65, 8, 359))
  const result = tilt.sample(sample(65, 8, 1))
  assert.ok(Math.abs(result.theta) < rad(2))
  assert.ok(Math.abs(result.phi) < rad(2))
})

test('landscape maps the phone axes to the rotated screen', () => {
  const tilt = createDeviceTilt()
  tilt.sample(sample(), 90)
  const result = tilt.sample(sample(0, 10), 90)
  near(result.theta, 0)
  near(result.phi, rad(-4))
  assert.deepEqual(tilt.sample(sample(0, 10), -90), { theta: 0, phi: 0 })
})

test('invalid sensor readings never establish or replace calibration', () => {
  const tilt = createDeviceTilt()
  assert.equal(tilt.sample({ beta: null, gamma: 0 }), null)
  assert.equal(tilt.sample({ beta: 0, gamma: NaN }), null)
  assert.equal(tilt.sample({ beta: Infinity, gamma: 0 }), null)
  assert.deepEqual(tilt.sample(sample(30, 20)), { theta: 0, phi: 0 })
  tilt.reset()
  assert.deepEqual(tilt.sample(sample(70, -10)), { theta: 0, phi: 0 })
})

test('iOS permission is requested synchronously once and shared across mounts', async t => {
  const previous = globalThis.window
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous })
  let calls = 0
  let grant
  globalThis.window = { isSecureContext: true, DeviceOrientationEvent: { requestPermission() { calls++; return new Promise(resolve => { grant = resolve }) } } }
  const permission = await import('../src/utils/deviceTilt.js?permission-grant')
  assert.equal(permission.deviceTiltPermission(), 'prompt')
  const first = permission.requestDeviceTiltPermission()
  assert.equal(calls, 1, 'Request occurs within the current user gesture')
  const second = permission.requestDeviceTiltPermission()
  assert.equal(calls, 1, 'Concurrent requests share the system prompt')
  grant('granted')
  assert.equal(await first, 'granted')
  assert.equal(await second, 'granted')
  assert.equal(permission.deviceTiltPermission(), 'granted')
  assert.equal(await permission.requestDeviceTiltPermission(), 'granted')
  assert.equal(calls, 1)
})

test('unavailable sensors and denied permissions are handled without repeated prompts', async t => {
  const previous = globalThis.window
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous })
  globalThis.window = { isSecureContext: false, DeviceOrientationEvent: {} }
  const permission = await import('../src/utils/deviceTilt.js?permission-deny')
  assert.equal(permission.deviceTiltPermission(), 'unavailable')
  assert.equal(await permission.requestDeviceTiltPermission(), 'unavailable')
  let calls = 0
  globalThis.window = { isSecureContext: true, DeviceOrientationEvent: { requestPermission: () => { calls++; return Promise.resolve('denied') } } }
  assert.equal(await permission.requestDeviceTiltPermission(), 'denied')
  assert.equal(await permission.requestDeviceTiltPermission(), 'denied')
  assert.equal(calls, 1)
})
