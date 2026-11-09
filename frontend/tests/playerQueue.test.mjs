import assert from 'node:assert/strict'
import test from 'node:test'
import { isDislikedTrack, queueStep, trackKeys } from '../src/utils/playerQueue.js'
import { getTrackDbId } from '../src/utils/identifiers.js'
import { uuid } from './helpers/identifiers.mjs'

function state(shuffle = false) {
  return {
    queue: [{ id: uuid(1) }, { id: 'ytmusic:blocked', source: 'ytmusic', external_id: 'blocked' }, { id: uuid(3) }, { id: uuid(4) }],
    currentIndex: 0, isShuffle: shuffle, shuffledOrder: [0, 1, 3, 2], currentShuffleIndex: 0,
    dislikedTrackIds: [], dislikedTrackKeys: ['ytmusic:blocked'],
  }
}

test('UUID database identities remain distinct from provider IDs and numeric legacy IDs', () => {
  assert.equal(getTrackDbId({ id: uuid(1), source: 'local' }), uuid(1))
  assert.equal(getTrackDbId({ id: 'soundcloud:123', db_id: uuid(2) }), uuid(2))
  assert.equal(getTrackDbId({ id: 'soundcloud:123' }), null)
  assert.equal(getTrackDbId({ id: 123 }), null)
  assert.equal(getTrackDbId({ id: 'invalid', db_id: 123 }), null)
  assert.deepEqual(trackKeys({ id: 'soundcloud:123', db_id: uuid(2), source: 'soundcloud', external_id: '123' }),
    [`local:${uuid(2)}`, 'soundcloud:123'])
})

test('preview and navigation skip a disliked external track and its materialized alias', () => {
  const queue = state()
  assert.deepEqual(queueStep(queue), { index: 2, shuffleIndex: -1 })
  assert.deepEqual(queueStep(queue, 1, 2), { index: 3, shuffleIndex: -1 })
  assert.equal(isDislikedTrack(queue, { id: uuid(99), source: 'ytmusic', external_id: 'blocked' }), true)
  queue.currentIndex = 2
  assert.deepEqual(queueStep(queue, -1), { index: 0, shuffleIndex: -1 })
})

test('shuffle preserves its order while skipping dislikes', () => {
  const queue = state(true)
  assert.deepEqual(queueStep(queue), { index: 3, shuffleIndex: 2 })
  queue.currentShuffleIndex = 2
  assert.deepEqual(queueStep(queue, -1), { index: 0, shuffleIndex: 0 })
})

test('a queue containing only disliked upcoming tracks ends and undo restores eligibility', () => {
  const queue = state()
  queue.dislikedTrackIds = [uuid(3), uuid(4)]
  assert.equal(queueStep(queue), null)
  queue.dislikedTrackKeys = []
  assert.deepEqual(queueStep(queue), { index: 1, shuffleIndex: -1 })
})
