import assert from 'node:assert/strict'
import test from 'node:test'
import { isDislikedTrack, queueStep } from '../src/utils/playerQueue.js'

function state(shuffle = false) {
  return {
    queue: [{ id: 1 }, { id: 'ytmusic:blocked', source: 'ytmusic', external_id: 'blocked' }, { id: 3 }, { id: 4 }],
    currentIndex: 0, isShuffle: shuffle, shuffledOrder: [0, 1, 3, 2], currentShuffleIndex: 0,
    dislikedTrackIds: [], dislikedTrackKeys: ['ytmusic:blocked'],
  }
}

test('preview and navigation skip a disliked external track and its materialized alias', () => {
  const queue = state()
  assert.deepEqual(queueStep(queue), { index: 2, shuffleIndex: -1 })
  assert.deepEqual(queueStep(queue, 1, 2), { index: 3, shuffleIndex: -1 })
  assert.equal(isDislikedTrack(queue, { id: 99, source: 'ytmusic', external_id: 'blocked' }), true)
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
  queue.dislikedTrackIds = [3, 4]
  assert.equal(queueStep(queue), null)
  queue.dislikedTrackKeys = []
  assert.deepEqual(queueStep(queue), { index: 1, shuffleIndex: -1 })
})
