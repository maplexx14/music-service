import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { transform } from 'esbuild'
import { PerspectiveCamera, Vector3 } from 'three'
import { cdMotionRegion } from '../src/utils/cdMotionRegion.js'
import { createCdFrameCadence } from '../src/utils/cdFrameCadence.js'
import * as skipMotion from '../src/utils/cdSkipMotion.js'
import * as projection from '../src/utils/cdProjection.js'
import { createCdAnimationClock } from '../src/utils/cdAnimationClock.js'
import { CD_SOFTWARE_ANGLES, CD_SOFTWARE_FRAME_COUNT, CD_SOFTWARE_FRAME_BYTES,
  cdSoftwareFrameSize, cdSoftwareFramePixels, cdSoftwareFrameEdges, createCdSoftwareSkip,
  sampleCdSoftwareSkip, nearestCdSoftwareFrame, cdSoftwareStoredRegion, cdSoftwareLayoutRegion } from '../src/utils/cdSoftwareFrames.js'

test('both skip directions share ordered poses, including the exact resting frame', () => {
  assert.equal(CD_SOFTWARE_ANGLES.length, CD_SOFTWARE_FRAME_COUNT)
  assert.equal(CD_SOFTWARE_ANGLES[nearestCdSoftwareFrame(0)], 0)
  for (let i = 0; i < CD_SOFTWARE_FRAME_COUNT; i++) {
    assert.ok(Math.abs(CD_SOFTWARE_ANGLES[i] + CD_SOFTWARE_ANGLES.at(-1 - i)) < 1e-12)
    if (i) assert.ok(CD_SOFTWARE_ANGLES[i] > CD_SOFTWARE_ANGLES[i - 1])
    assert.equal(nearestCdSoftwareFrame(CD_SOFTWARE_ANGLES[i]), i)
  }
  assert.equal(nearestCdSoftwareFrame(-10), 0)
  assert.equal(nearestCdSoftwareFrame(10), CD_SOFTWARE_FRAME_COUNT - 1)
})

test('decoded frames and working buffers fit the pixel budget across screen sizes', () => {
  for (const [width, height] of [[300, 500], [700, 700], [1400, 900], [4000, 2160], [50, 1000]]) {
    const size = cdSoftwareFrameSize(width, height)
    assert.ok(size.width > 0 && size.height > 0)
    assert.ok(Math.max(size.width, size.height) <= 512)
    assert.ok(size.width * size.height * 4 * (CD_SOFTWARE_FRAME_COUNT + 3) <= CD_SOFTWARE_FRAME_BYTES)
    assert.ok(Math.abs(size.width / size.height - width / height) < 0.02)
  }
})

test('the cached turn retains the 3D reaction amplitude and returns to rest', () => {
  const next = createCdSoftwareSkip('next'), previous = createCdSoftwareSkip('previous')
  assert.ok(Math.abs(sampleCdSoftwareSkip(next, 1000 / 14).angle - 0.28) < 1e-12)
  assert.ok(Math.abs(sampleCdSoftwareSkip(previous, 1000 / 14).angle + 0.28) < 1e-12)
  assert.deepEqual(sampleCdSoftwareSkip(next, next.duration), { angle: 0, velocity: 0 })
  assert.equal(createCdSoftwareSkip('play'), null)
})

test('a reversed or repeated skip carries its current position and velocity', () => {
  const next = createCdSoftwareSkip('next'), current = sampleCdSoftwareSkip(next, 120)
  const repeated = createCdSoftwareSkip('next', next, 120), reversed = createCdSoftwareSkip('previous', next, 120)
  assert.equal(sampleCdSoftwareSkip(repeated, 0).angle, current.angle)
  assert.equal(sampleCdSoftwareSkip(reversed, 0).angle, current.angle)
  assert.ok(repeated.velocity > current.velocity)
  assert.ok(reversed.velocity < current.velocity)
})

test('rapid skips stay inside the prepared poses and never produce nonfinite values', () => {
  let motion = createCdSoftwareSkip('next')
  for (let i = 0; i < 50; i++) {
    motion = createCdSoftwareSkip(i % 5 ? 'next' : 'previous', motion, 20)
    for (let time = 0; time < motion.duration; time += 8) {
      const { angle, velocity } = sampleCdSoftwareSkip(motion, time)
      assert.ok(Number.isFinite(angle) && Number.isFinite(velocity))
      assert.ok(Math.abs(angle) <= 0.5)
    }
  }
})

test('readback reverses rows and restores transparent edges without darkening them', () => {
  const bottomUp = new Uint8Array([10, 20, 30, 255, 64, 32, 16, 128, 0, 0, 0, 0, 255, 127, 32, 255])
  const result = new Uint8ClampedArray(bottomUp.length)
  cdSoftwareFramePixels(bottomUp, result, 2, 2)
  assert.deepEqual(Array.from(result), [0, 0, 0, 0, 255, 127, 32, 255, 10, 20, 30, 255, 128, 64, 32, 128])
})

test('stored framing follows the same camera projection at different layout sizes', () => {
  const region = { x: 120, y: 20, width: 540, height: 580 }
  const stored = cdSoftwareStoredRegion(region, 900, 600)
  const restored = cdSoftwareLayoutRegion(stored, 900, 600)
  for (const name of Object.keys(region)) assert.ok(Math.abs(restored[name] - region[name]) < 1e-10)
  const resized = cdSoftwareLayoutRegion(stored, 1400, 900)
  assert.equal(resized.width, 810)
  assert.equal(resized.height, 870)
  assert.ok(Math.abs(resized.x - 205) < 1e-10)
  assert.equal(resized.y, 30)
})

test('silhouette smoothing preserves solid detail and avoids dark transparent fringes', () => {
  const pixels = new Uint8ClampedArray(7 * 7 * 4)
  for (let y = 0; y < 7; y++) for (let x = 3; x < 7; x++) {
    pixels.set([180, 90, 45, 255], (y * 7 + x) * 4)
  }
  pixels.set([20, 40, 60, 255], (3 * 7 + 5) * 4)
  cdSoftwareFrameEdges(pixels, 7, 7)
  const pixel = (x, y) => Array.from(pixels.slice((y * 7 + x) * 4, (y * 7 + x + 1) * 4))
  assert.deepEqual(pixel(5, 3), [20, 40, 60, 255])
  assert.deepEqual(pixel(1, 3), [0, 0, 0, 0])
  assert.deepEqual(pixel(2, 3).slice(0, 3), [180, 90, 45])
  assert.ok(pixel(2, 3)[3] > 0 && pixel(2, 3)[3] < 32)
  assert.ok(pixel(3, 3)[3] > 223 && pixel(3, 3)[3] < 255)
})

const source = await readFile(new URL('../src/utils/cdSoftwareFrames.js', import.meta.url), 'utf8')
const { code } = await transform(source, { format: 'cjs', target: 'es2020' })
const script = new vm.Script(`(function(module,exports,require){${code}\n})`)
const flush = () => new Promise(setImmediate)

function environment({ holdReadback = false, contextAvailable = true, captureDelay = 0, smooth = false, frameRate, frameStore = { get: async () => null, put: async () => {} } } = {}) {
  let at = 0, sequence = 0, enabled = true, restCount = 0, renderCount = 0, readyCount = 0
  const timers = new Map(), animationFrames = new Map(), targets = [], bitmaps = [], draws = [], readbacks = [], poses = [], drawnBitmaps = []
  const output = { style: {}, width: 0, height: 0, removed: false,
    setAttribute() {}, remove() { this.removed = true },
    getContext: () => contextAvailable ? { clearRect() {}, drawImage(bitmap) { draws.push(at); drawnBitmaps.push(bitmap) } } : null }
  let firstCanvas = true
  const gl = { PIXEL_PACK_BUFFER: 1, PIXEL_PACK_BUFFER_BINDING: 2, buffer: null,
    getParameter() { return this.buffer }, bindBuffer(target, buffer) { this.buffer = buffer } }
  const surface = { clientWidth: 200, clientHeight: 200, offsetLeft: 12, style: {}, after() {} }
  const renderer = { capabilities: { maxSamples: 2 }, target: null,
    getContext: () => gl,
    getRenderTarget() { return this.target }, setRenderTarget(target) { this.target = target },
    render(scene, camera) { renderCount++; this.angle = camera.userData.angle },
    readRenderTargetPixels(target, x, y, width, height, pixels) {
      assert.equal(gl.buffer, null, 'Synchronous readback cannot run with a pixel-pack buffer bound')
      at += captureDelay
      for (let i = 0; i < pixels.length; i += 4) { pixels[i] = Math.round((this.angle + 0.5) * 100); pixels[i + 3] = 255 }
    },
    readRenderTargetPixelsAsync(...args) {
      gl.buffer = null
      this.readRenderTargetPixels(...args)
      if (holdReadback) gl.buffer = 'pending readback'
      return holdReadback ? new Promise(resolve => readbacks.push(() => { gl.buffer = null; resolve() })) : Promise.resolve()
    } }
  const globals = {
    document: { createElement: type => {
      if (firstCanvas) { firstCanvas = false; return output }
      const canvas = { getContext: () => ({ putImageData(data) { canvas.pixels = Array.from(data.data.slice(0, 4)) } }),
        toBlob(callback) { callback({ width: canvas.width, height: canvas.height, pixels: canvas.pixels, size: 4 }) } }
      return canvas
    } }, performance: { now: () => at },
    window: { setTimeout(callback) { const id = ++sequence; timers.set(id, callback); return id } },
    clearTimeout: id => timers.delete(id),
    requestAnimationFrame(callback) { const id = ++sequence; animationFrames.set(id, callback); return id },
    cancelAnimationFrame: id => animationFrames.delete(id),
    ImageData: class { constructor(width, height) { this.width = width; this.height = height; this.data = new Uint8ClampedArray(width * height * 4) } },
    createImageBitmap: async (data, x, y, width, height) => { const bitmap = { width: width ?? data.width, height: height ?? data.height, pixels: data.pixels || Array.from(data.data.slice(0, 4)), closed: 0, close() { this.closed++ } }; bitmaps.push(bitmap); return bitmap },
  }
  const module = { exports: {} }
  script.runInContext(vm.createContext(globals))(module, module.exports, name => {
    if (name === 'three') return { SRGBColorSpace: 'srgb', WebGLRenderTarget: class {
      constructor() { this.disposed = 0; targets.push(this) }
      dispose() { this.disposed++ }
    } }
    if (name === './cdMotionRegion.js') return { cdMotionRegion }
    if (name === './cdFrameCadence.js') return { createCdFrameCadence }
    if (name === './cdSoftwareFrameStore.js') return { cdSoftwareFrameStore: frameStore }
    if (name === './cdSkipMotion.js') return skipMotion
    if (name === './cdProjection.js') return projection
    throw new Error(`Unexpected import ${name}`)
  })
  const api = module.exports.createCdSoftwareFrames({ surface, renderer, scene: {},
    motionClock: smooth ? createCdAnimationClock({ requestFrame: globals.requestAnimationFrame, cancelFrame: globals.cancelAnimationFrame }) : undefined,
    frameRate,
    captureFrameQuad: smooth ? camera => [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 }].map(point => ({ x: point.x + camera.userData.angle * 10, y: point.y })) : undefined,
    enabled: () => enabled, points: () => [new Vector3(-1, -1, 0), new Vector3(1, 1, 0)],
    captureCamera: angle => { const camera = new PerspectiveCamera(45, 1, 0.1, 100); camera.userData.angle = angle; camera.position.z = 5; camera.updateMatrixWorld(); return camera },
    captureOverlays: camera => ({ angle: camera.userData.angle }), onPose(pose) { poses.push(pose) }, onRest() { restCount++ }, onReady() { readyCount++ } })
  return { api, output, surface, targets, bitmaps, timers, animationFrames, draws, readbacks, poses, drawnBitmaps, gl,
    get renders() { return renderCount }, get rests() { return restCount }, get readyCount() { return readyCount },
    setEnabled(value) { enabled = value },
    async prepareOne() {
      const [id, callback] = timers.entries().next().value
      timers.delete(id); callback(); await flush()
    },
    tick(time) {
      at = time
      const callbacks = [...animationFrames.values()]
      animationFrames.clear()
      callbacks.forEach(callback => callback(at))
    },
  }
}

test('a carousel drives prepared poses directly without another spring, renderer or frame loop', async () => {
  const env = environment({ smooth: true })
  assert.equal(env.api.present(0.1), false)
  assert.equal(env.renders, 0)
  assert.equal(env.targets.length, 0)
  env.api.warm('pose')
  while (!env.api.status().ready) await env.prepareOne()
  const renders = env.renders, targets = env.targets.length
  for (const angle of [0, 0.1, 0.28, 0.12, -0.1, -0.28, 0]) {
    assert.equal(env.api.present(angle), true)
    assert.equal(env.poses.at(-1).angle, angle)
    assert.equal(env.animationFrames.size, 0)
  }
  assert.equal(env.renders, renders)
  assert.equal(env.targets.length, targets)
  env.api.stop()
  assert.equal(env.api.camera, null)
  assert.equal(env.surface.style.visibility, '')
  assert.equal(env.rests, 1)
  env.api.dispose()
})

test('a completed cache wakes deferred playback once without a readiness polling loop', async () => {
  const env = environment()
  env.api.warm('pose')
  assert.equal(env.readyCount, 0)
  while (!env.api.status().ready) await env.prepareOne()
  assert.equal(env.readyCount, 1)
  env.api.warm('pose')
  assert.equal(env.timers.size, 0)
  assert.equal(env.readyCount, 1)
})

test('a track skip continues from the visible playback camera instead of snapping to rest', async () => {
  const env = environment({ smooth: true })
  env.api.warm('pose')
  while (!env.api.status().ready) await env.prepareOne()
  env.api.present(0.14)
  assert.equal(env.api.play('next'), true)
  assert.equal(env.poses.at(-1).angle, 0.14)
  env.tick(16)
  assert.ok(env.poses.at(-1).angle > 0.14)
})

test('a software carousel follows the first refresh even when its initial pose was placed between frames', async () => {
  const env = environment({ smooth: true, frameRate: 60 })
  env.api.warm('pose')
  while (!env.api.status().ready) await env.prepareOne()
  const renders = env.renders, targets = env.targets.length
  env.api.present(0)
  env.tick(3)
  env.api.present(0)
  env.tick(6)
  env.api.present(0.076)
  assert.equal(env.poses.at(-1).angle, 0.076)
  env.tick(12)
  env.api.present(0.14)
  assert.equal(env.poses.at(-1).angle, 0.076, 'Subsequent frames retain the software composition budget')
  env.tick(23)
  env.api.present(0.2)
  assert.equal(env.poses.at(-1).angle, 0.2)
  assert.equal(env.renders, renders)
  assert.equal(env.targets.length, targets)
  assert.equal(env.animationFrames.size, 0)
  env.api.stop()
  env.tick(25)
  env.api.present(0)
  env.tick(31)
  env.api.present(-0.076)
  assert.equal(env.poses.at(-1).angle, -0.076, 'The next skip also starts on its first refresh')
  env.api.dispose()
})

test('direct carousel poses keep the software composition budget on a 120 Hz clock', async () => {
  const env = environment({ smooth: true, frameRate: 60 })
  env.api.warm('pose')
  while (!env.api.status().ready) await env.prepareOne()
  const renders = env.renders
  for (let frame = 0; frame <= 72; frame++) {
    env.tick(frame * 1000 / 120)
    assert.equal(env.api.present(0.28 * Math.sin(frame / 72 * Math.PI)), true)
  }
  assert.ok(env.poses.length >= 35 && env.poses.length <= 37)
  assert.equal(env.renders, renders)
  assert.equal(env.animationFrames.size, 0)
  env.api.stop()
  env.api.dispose()
})

for (const hz of [60, 120, 144]) test(`smooth cached turns follow every ${hz} Hz refresh without adding bitmap copies`, async () => {
  const env = environment({ smooth: true })
  env.api.warm('pose')
  while (!env.api.status().ready) await env.prepareOne()
  const renders = env.renders
  env.api.play('next')
  for (let frame = 1; frame <= Math.floor(hz * 0.6); frame++) env.tick(frame * 1000 / hz)
  assert.equal(env.poses.length, Math.floor(hz * 0.6) + 1)
  assert.ok(env.draws.length < env.poses.length, 'Repeated camera poses update their transform without copying the bitmap')
  assert.notEqual(env.output.style.transform, 'none')
  assert.equal(env.renders, renders)
  const expected = sampleCdSoftwareSkip(createCdSoftwareSkip('next'), Math.floor(hz * 0.6) * 1000 / hz).angle
  assert.ok(Math.abs(env.poses.at(-1).angle - expected) < 1e-10)
  env.tick(700)
  assert.equal(env.animationFrames.size, 0)
  assert.equal(env.api.status().playing, false)
  env.api.dispose()
})

for (const hz of [60, 120, 144, 240]) test(`software turns respect 60 fps on a ${hz} Hz shared clock`, async () => {
  const env = environment({ smooth: true, frameRate: 60 })
  env.api.warm('pose')
  while (!env.api.status().ready) await env.prepareOne()
  const renders = env.renders
  env.api.play('next')
  for (let frame = 1; frame <= Math.floor(hz * 0.6); frame++) env.tick(frame * 1000 / hz)
  assert.ok(env.poses.length >= 35 && env.poses.length <= 37, `${env.poses.length} poses exceeded the software budget`)
  assert.equal(env.renders, renders)
  const previous = env.poses.at(-1).angle
  env.api.play('previous')
  assert.ok(Math.abs(env.poses.at(-1).angle - previous) < 0.001, 'Reversing keeps the current pose')
  env.tick(620)
  env.tick(1260)
  assert.equal(env.api.status().playing, false, 'Frame limiting does not extend the motion')
  assert.equal(env.animationFrames.size, 0)
  env.api.dispose()
})

test('smooth reversals keep the visible pose and suspension releases the display clock', async () => {
  const env = environment({ smooth: true })
  env.api.warm('pose')
  while (!env.api.status().ready) await env.prepareOne()
  env.api.play('next')
  env.tick(120)
  const angle = env.poses.at(-1).angle
  env.api.play('previous')
  assert.equal(env.poses.at(-1).angle, angle)
  assert.equal(env.animationFrames.size, 1)
  env.api.suspend()
  assert.equal(env.animationFrames.size, 0)
  assert.equal(env.api.status().playing, false)
  const poses = env.poses.length
  env.tick(150)
  assert.equal(env.poses.length, poses)
  env.api.dispose()
})

test('replacing a pose during async readback retires its buffers after completion', async () => {
  const env = environment({ holdReadback: true })
  env.api.warm('original')
  await env.prepareOne()
  env.api.warm('new appearance')
  assert.equal(env.targets[0].disposed, 0, 'The outstanding readback still owns its target')
  env.readbacks.shift()()
  await flush()
  assert.equal(env.targets[0].disposed, 1)
  assert.equal(env.api.status().prepared, 0, 'An obsolete frame cannot enter the new cache')
  assert.equal(env.bitmaps.length, 0)
  assert.equal(env.timers.size, 1, 'Preparation resumes with the new appearance')
  await env.prepareOne()
  env.api.dispose()
  assert.equal(env.targets[1].disposed, 0)
  env.readbacks.shift()()
  await flush()
  assert.equal(env.targets[1].disposed, 1)
  assert.equal(env.timers.size, 0)
  assert.equal(env.api.play('next'), false)
  assert.equal(env.output.removed, true)
})

for (const hz of [60, 75, 90, 120, 144, 165]) {
  test(`cached skips and reversals at ${hz} Hz copy bitmaps without rendering or rebuilding frames`, async () => {
    const env = environment()
    env.api.warm('pose')
    for (let i = 0; i < CD_SOFTWARE_FRAME_COUNT; i++) await env.prepareOne()
    assert.equal(env.api.status().ready, true)
    assert.equal(env.targets[0].disposed, 1)
    const renders = env.renders
    assert.equal(env.api.play('next'), true)
    // Restarting frequently exercises the cadence over the moving part of
    // the spring, before identical near-rest poses stop requiring copies.
    for (let i = 1; i <= hz; i++) {
      env.tick(i * 1000 / hz)
      if (i % Math.round(hz / 10) === 0) env.api.play(i % 2 ? 'previous' : 'next')
    }
    assert.ok(env.draws.length >= 25 && env.draws.length <= 45, `Unexpected number of bitmap copies: ${env.draws.length}`)
    assert.equal(env.renders, renders)
    assert.equal(env.bitmaps.length, CD_SOFTWARE_FRAME_COUNT)
    env.setEnabled(false)
    env.tick(1100)
    assert.equal(env.output.style.display, 'none')
    assert.equal(env.surface.style.visibility, '')
    assert.equal(env.animationFrames.size, 0)
    assert.equal(env.rests, 1)
    env.api.dispose()
    assert.ok(env.bitmaps.every(bitmap => bitmap.closed === 1))
  })
}

test('suspending during preparation leaves no hidden warmup timers', async () => {
  const env = environment({ holdReadback: true })
  env.api.warm('pose')
  await env.prepareOne()
  env.setEnabled(false)
  env.api.suspend()
  env.readbacks.shift()()
  await flush()
  assert.equal(env.timers.size, 0)
  env.setEnabled(true)
  env.api.warm('pose')
  assert.equal(env.timers.size, 1)
  env.api.dispose()
})

test('early skips queue the latest direction without rendering, reading or allocating on input', async () => {
  const env = environment()
  env.api.warm('pose')
  assert.equal(env.api.play('next'), true)
  assert.equal(env.api.play('previous'), true)
  assert.equal(env.api.status().pending, 'previous')
  assert.equal(env.api.status().playing, false)
  assert.equal(env.renders, 0)
  assert.equal(env.targets.length, 0)
  assert.equal(env.animationFrames.size, 0)
  assert.equal(env.output.style.display, 'none')
  for (let i = 0; i < CD_SOFTWARE_FRAME_COUNT; i++) await env.prepareOne()
  assert.equal(env.api.status().playing, true)
  assert.equal(env.api.status().pending, null)
  const renders = env.renders
  env.tick(70)
  assert.ok(env.poses.at(-1).angle < -0.25)
  assert.equal(env.renders, renders)
  env.tick(660)
  assert.equal(env.rests, 1)
  env.api.dispose()
})

test('an early skip leaves the outstanding async preparation intact', async () => {
  const env = environment({ holdReadback: true })
  env.api.warm('pose')
  await env.prepareOne()
  const renders = env.renders
  assert.equal(env.api.play('next'), true)
  assert.equal(env.renders, renders)
  assert.equal(env.api.status().prepared, 0)
  env.readbacks.shift()()
  await flush()
  assert.equal(env.api.status().prepared, 1)
  assert.equal(env.bitmaps.length, 1)
  assert.equal(env.targets[0].disposed, 0)
  env.api.dispose()
  assert.equal(env.targets[0].disposed, 1)
})

test('a live fallback declines unprepared frames without replaying the action later', async () => {
  const env = environment()
  env.api.warm('pose')
  assert.equal(env.api.play('next'), true)
  assert.equal(env.api.play('previous', { waitForReady: false }), false)
  assert.equal(env.api.status().pending, null)
  assert.equal(env.renders, 0)
  assert.equal(env.targets.length, 0)
  assert.equal(env.timers.size, 1, 'Declining a turn preserves idle preparation')
  assert.equal(env.animationFrames.size, 0)
  for (let i = 0; i < CD_SOFTWARE_FRAME_COUNT; i++) await env.prepareOne()
  assert.equal(env.api.status().ready, true)
  assert.equal(env.api.status().playing, false, 'The fallback must not replay when pixels arrive')
  const renders = env.renders
  assert.equal(env.api.play('previous', { waitForReady: false }), true)
  env.tick(70)
  assert.ok(env.poses.at(-1).angle < -0.25)
  assert.equal(env.renders, renders, 'A later ready turn still copies cached pixels')
  env.api.dispose()
})

test('changing appearance prepares the original turn without using an input-time fallback', async () => {
  const env = environment()
  env.api.warm('original')
  for (let i = 0; i < CD_SOFTWARE_FRAME_COUNT; i++) await env.prepareOne()
  env.api.play('next'); env.tick(70)
  const originalPeak = env.poses.at(-1)
  env.api.stop()
  env.api.warm('changed appearance')
  const renders = env.renders
  assert.equal(env.api.status().ready, false)
  assert.equal(env.api.play('next'), true)
  assert.equal(env.renders, renders)
  for (let i = 0; i < CD_SOFTWARE_FRAME_COUNT; i++) await env.prepareOne()
  env.tick(140)
  assert.deepEqual(env.poses.at(-1), originalPeak)
  assert.equal(env.api.status().failure, null)
  env.api.dispose()
})

test('slow preparation cannot consume the visible spring duration', async () => {
  const env = environment({ captureDelay: 400 })
  env.api.warm('pose')
  env.api.play('next')
  for (let i = 0; i < CD_SOFTWARE_FRAME_COUNT; i++) await env.prepareOne()
  const renders = env.renders
  env.tick(CD_SOFTWARE_FRAME_COUNT * 400 + 34)
  const expected = sampleCdSoftwareSkip(createCdSoftwareSkip('next'), 34)
  assert.equal(env.poses.at(-1).angle, CD_SOFTWARE_ANGLES[nearestCdSoftwareFrame(expected.angle)])
  assert.ok(env.poses.at(-1).angle > 0.2)
  assert.equal(env.renders, renders)
  env.api.dispose()
})

test('a delayed first refresh still shows the original peak', async () => {
  const env = environment()
  env.api.warm('pose')
  for (let i = 0; i < CD_SOFTWARE_FRAME_COUNT; i++) await env.prepareOne()
  assert.equal(env.api.play('next'), true)
  env.tick(800)
  assert.ok(env.poses.at(-1).angle > 0.25)
  assert.equal(env.api.status().playing, true)
  env.tick(1500)
  assert.equal(env.api.status().playing, false)
  env.api.dispose()
})

test('suspending cancels an early action so it cannot replay on returning to the screen', async () => {
  const env = environment()
  env.api.warm('pose')
  env.api.play('next')
  env.api.suspend()
  assert.equal(env.api.status().pending, null)
  env.api.warm('pose')
  for (let i = 0; i < CD_SOFTWARE_FRAME_COUNT; i++) await env.prepareOne()
  assert.equal(env.api.status().playing, false)
  assert.equal(env.animationFrames.size, 0)
  env.api.dispose()
})

test('reopening reuses compressed original pixels without WebGL targets, renders or readback', async () => {
  const records = new Map()
  const frameStore = { get: async key => records.get(key), put: async (key, blobs) => { records.set(key, { blobs }) } }
  const first = environment({ frameStore })
  first.api.warm('pose')
  for (let i = 0; i < CD_SOFTWARE_FRAME_COUNT; i++) await first.prepareOne()
  assert.ok(records.has('pose'))
  first.api.play('next')
  for (const time of [34, 70, 140, 280, 420]) first.tick(time)
  const pixels = first.drawnBitmaps.map(bitmap => bitmap.pixels)
  first.api.dispose()
  const reopened = environment({ frameStore })
  reopened.api.warm('pose')
  reopened.api.play('next')
  await reopened.prepareOne()
  assert.equal(reopened.api.status().ready, true)
  assert.equal(reopened.api.status().playing, true)
  assert.equal(reopened.renders, 0)
  assert.equal(reopened.targets.length, 0)
  for (const time of [34, 70, 140, 280, 420]) reopened.tick(time)
  assert.deepEqual(reopened.drawnBitmaps.map(bitmap => bitmap.pixels), pixels)
  reopened.api.dispose()
})

test('unavailable or corrupt persistent storage falls back to idle preparation', async () => {
  for (const frameStore of [
    { get: async () => { throw new Error('storage denied') }, put: async () => { throw new Error('quota') } },
    { get: async () => ({ blobs: Array.from({ length: CD_SOFTWARE_FRAME_COUNT }, () => ({ width: 1, height: 1, pixels: [0, 0, 0, 0] })) }), put: async () => {} },
  ]) {
    const env = environment({ frameStore })
    env.api.warm('pose')
    for (let i = 0; i < CD_SOFTWARE_FRAME_COUNT; i++) await env.prepareOne()
    assert.equal(env.api.status().ready, true)
    assert.equal(env.api.status().failure, null)
    assert.equal(env.renders, CD_SOFTWARE_FRAME_COUNT)
    env.api.dispose()
    assert.ok(env.bitmaps.every(bitmap => bitmap.closed === 1))
  }
})

test('a shipped atlas provides the first turn without any WebGL preparation', async () => {
  const atlas = { pixels: [80, 80, 80, 255] }
  const frameStore = { get: async () => ({
    size: { width: 40, height: 50 }, region: { x: -0.2, y: -0.3, width: 0.4, height: 0.6 },
    blobs: Array(CD_SOFTWARE_FRAME_COUNT).fill(atlas),
    rectangles: Array.from({ length: CD_SOFTWARE_FRAME_COUNT }, (_, i) => ({ x: i * 40, y: 0, width: 40, height: 50 })),
  }) }
  const env = environment({ frameStore })
  env.api.warm('pose')
  env.api.play('next')
  await env.prepareOne()
  assert.equal(env.api.status().ready, true)
  assert.equal(env.renders, 0)
  assert.equal(env.targets.length, 0)
  assert.equal(env.output.width, 40)
  assert.equal(env.output.height, 50)
  assert.equal(env.output.style.left, '72px')
  assert.equal(env.bitmaps.length, CD_SOFTWARE_FRAME_COUNT + 1, 'The atlas is decoded once before creating its slices')
  assert.equal(env.bitmaps[0].closed, 1, 'The full atlas is released after slicing')
  env.tick(70)
  assert.ok(env.poses.at(-1).angle > 0.25)
  assert.equal(env.renders, 0)
  env.api.dispose()
})

test('resizing with the same physical camera reuses the stored chassis and refreshes overlay geometry', async () => {
  const records = new Map()
  const frameStore = { get: async key => records.get(key), put: async (key, blobs, geometry) => { records.set(key, { blobs, ...geometry }) } }
  const env = environment({ frameStore })
  env.api.warm('pose')
  for (let i = 0; i < CD_SOFTWARE_FRAME_COUNT; i++) await env.prepareOne()
  env.api.play('next')
  const before = Number.parseFloat(env.output.style.left)
  const renders = env.renders
  env.surface.clientWidth = 400
  env.api.warm('pose')
  assert.equal(env.api.status().ready, false)
  assert.equal(env.api.status().playing, false)
  env.api.play('next')
  await env.prepareOne()
  assert.equal(env.api.status().ready, true)
  assert.equal(env.renders, renders)
  assert.equal(env.targets.length, 1, 'A resized cached camera needs no new WebGL target')
  assert.ok(Math.abs(Number.parseFloat(env.output.style.left) - before - 100) < 1e-10)
  env.api.dispose()
  assert.ok(env.bitmaps.every(bitmap => bitmap.closed === 1))
})

test('hiding during a storage lookup stops decoding and resumes the saved poses without rendering', async () => {
  let complete, lookups = 0
  const record = { size: { width: 40, height: 50 }, region: { x: -0.2, y: -0.3, width: 0.4, height: 0.6 },
    blobs: Array.from({ length: CD_SOFTWARE_FRAME_COUNT }, () => ({ width: 40, height: 50, pixels: [80, 80, 80, 255] })) }
  const frameStore = { get: () => ++lookups === 1 ? new Promise(resolve => { complete = resolve }) : Promise.resolve(record) }
  const env = environment({ frameStore })
  env.api.warm('pose')
  await env.prepareOne()
  env.setEnabled(false)
  env.api.suspend()
  complete(record)
  await flush()
  assert.equal(env.bitmaps.length, 0)
  assert.equal(env.renders, 0)
  assert.equal(env.timers.size, 0)
  env.setEnabled(true)
  env.api.warm('pose')
  await env.prepareOne()
  assert.equal(env.api.status().ready, true)
  assert.equal(env.renders, 0)
  assert.equal(env.targets.length, 0)
  env.api.dispose()
})

test('unavailable 2D contexts and hidden layout do not allocate a frame cache', () => {
  for (const options of [{ contextAvailable: false }, {}]) {
    const env = environment(options)
    if (options.contextAvailable !== false) env.surface.clientWidth = 0
    env.api.warm('pose')
    assert.equal(env.timers.size, 0)
    assert.equal(env.api.play('next'), false)
    env.api.dispose()
  }
})
