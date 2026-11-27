import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../src/utils/cdDeckScene.js', import.meta.url), 'utf8')
const body = source.match(/    beginDiscExchange\(\) {([\s\S]*?)\n    },\n    expediteDiscExchange/)[1]

function environment({ mobile = false, rotated = false, reduced = false } = {}) {
  const resets = [], waiters = new Set()
  let finishMotion
  const aligned = new Promise(resolve => { finishMotion = resolve })
  const context = {
    mobile, discExchanging: false, carouselActive: false, carouselCamera: null,
    softwareRendering: false, powerSave: false, reduced: { matches: reduced },
    view: { theta: rotated ? 0.3 : 0, phi: Math.PI / 2 },
    initialView: { theta: 0, phi: Math.PI / 2 }, viewMotion: null,
    viewAlignmentWaiters: waiters, canRender: () => true,
    stopReaction() {}, restoreCarousel() {}, softwareFrames: { stop() {} },
    playbackMotion: { reset: (...args) => resets.push(args), whenAligned: () => aligned },
    resetView() { context.viewMotion = {} }, snapView() {}, updateDiscOverlay() {},
    invalidate() {}, syncPlaybackMotion() {},
  }
  const begin = vm.runInNewContext(`(function() {${body}})`, context)
  return { begin, resets, finishMotion, context, finishView() { for (const resolve of waiters) resolve(); waiters.clear() } }
}

test('desktop exchange returns the held playback pose to neutral before releasing the disc', async () => {
  const env = environment()
  let released = false
  const completion = env.begin().then(() => { released = true })
  assert.deepEqual(env.resets, [[false, 220]])
  assert.equal(env.context.discExchanging, true)
  await Promise.resolve()
  assert.equal(released, false)
  env.finishMotion()
  await completion
  assert.equal(released, true)
})

test('a manually rotated desktop waits for both its camera and native tilt to settle', async () => {
  const env = environment({ rotated: true })
  let released = false
  const completion = env.begin().then(() => { released = true })
  env.finishMotion()
  await Promise.resolve()
  assert.equal(released, false)
  env.finishView()
  await completion
  assert.equal(released, true)
})

test('mobile exchange preserves its existing gesture pose', async () => {
  const env = environment({ mobile: true })
  const completion = env.begin()
  assert.deepEqual(env.resets, [])
  env.finishMotion()
  await completion
})

test('reduced motion requests immediate desktop alignment', async () => {
  const env = environment({ reduced: true })
  const completion = env.begin()
  assert.deepEqual(env.resets, [[true, 220]])
  env.finishMotion()
  await completion
})
