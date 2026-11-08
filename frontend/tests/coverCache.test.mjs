import assert from 'node:assert/strict'
import test from 'node:test'
import { isCoverReady, markCoverReady, rememberCoverImage, subscribeCoverReady } from '../src/utils/coverCache.js'

test('decoded artwork notifies its consumers once and unsubscribing removes observation', () => {
  let calls = 0
  const stop = subscribeCoverReady('/shared-cover.jpg', () => { calls++ })
  markCoverReady('/unrelated-cover.jpg')
  assert.equal(calls, 0)
  markCoverReady('/shared-cover.jpg')
  markCoverReady('/shared-cover.jpg')
  assert.equal(calls, 1)
  assert.equal(isCoverReady('/shared-cover.jpg'), true)
  stop()
  const cancel = subscribeCoverReady('/cancelled-cover.jpg', () => { calls++ })
  cancel()
  markCoverReady('/cancelled-cover.jpg')
  assert.equal(calls, 1)
})

test('a fullscreen image is reusable only after decoding succeeds', async () => {
  let decoded
  const image = {
    getAttribute: () => '/fullscreen-cover.jpg', naturalWidth: 800,
    decode: () => new Promise(resolve => { decoded = resolve }),
  }
  const pending = rememberCoverImage(image)
  assert.equal(isCoverReady('/fullscreen-cover.jpg'), false)
  decoded()
  await pending
  assert.equal(isCoverReady('/fullscreen-cover.jpg'), true)
})

test('failed decoding and source changes never publish false readiness', async () => {
  await rememberCoverImage({
    getAttribute: () => '/failed-cover.jpg', naturalWidth: 800,
    decode: () => Promise.reject(new Error('decode failed')),
  })
  assert.equal(isCoverReady('/failed-cover.jpg'), false)
  let src = '/replaced-cover.jpg', decoded
  const pending = rememberCoverImage({
    getAttribute: () => src, naturalWidth: 800,
    decode: () => new Promise(resolve => { decoded = resolve }),
  })
  src = '/new-cover.jpg'
  decoded()
  await pending
  assert.equal(isCoverReady('/replaced-cover.jpg'), false)
  assert.equal(isCoverReady('/new-cover.jpg'), false)
})
