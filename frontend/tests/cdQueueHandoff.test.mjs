import assert from 'node:assert/strict'
import test from 'node:test'
import { returnCdQueueRecord, settleCdQueueRecord, isCdQueueFrameReady } from '../src/utils/cdQueueHandoff.js'
import { cdQueueRecords } from '../src/utils/cdDiscRecords.js'

test('disliking the current track keeps the preceding eligible disc in the previous slot', () => {
  const queue = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id }))
  const before = { queue, currentIndex: 2, currentTrack: queue[2] }
  const after = { ...before, currentIndex: 3, currentTrack: queue[3], dislikedTrackKeys: ['c'] }
  for (const mobile of [false, true]) {
    const previous = cdQueueRecords(before, mobile).find(record => record.direction === -1)
    const records = cdQueueRecords(after, mobile)
    assert.equal(previous.track.id, 'b')
    assert.equal(records.find(record => record.direction === -1).key, previous.key)
    assert.equal(records.some(record => record.track.id === 'c'), false)
    assert.equal(records.find(record => record.direction === 1).track.id, 'e')
  }
})

test('a present disc is not ready for another shift until the entire queue has committed its slots', () => {
  let pending = false
  const queue = { dataset: { cdQueuePosition: '0' }, querySelector: () => pending ? {} : null }
  const record = { dataset: { queueSlot: '2' }, querySelector: () => ({}) }
  assert.equal(isCdQueueFrameReady(queue, 1, record, 1), false)
  queue.dataset.cdQueuePosition = '1'
  assert.equal(isCdQueueFrameReady(queue, 1, record, 1), false)
  record.dataset.queueSlot = '1'
  pending = true
  assert.equal(isCdQueueFrameReady(queue, 1, record, 1), false)
  pending = false
  assert.equal(isCdQueueFrameReady(queue, 1, record, 1), true)
})

test('a farther disc retains its completed screen position until its new keyed queue slot commits', () => {
  const node = {
    dataset: {}, style: { transform: '', transition: '' }, moving: true,
    getBoundingClientRect() { return { left: this.moving ? 400 : 800, top: 100, width: 300, height: 300 } },
  }
  const parent = { insertBefore(child) { child.moving = false } }
  returnCdQueueRecord({ node, parent, style: '', targetSlot: 1 })
  assert.equal(node.style.transform, 'translate(-400px, 0px) scale(1)')
  assert.equal(node.style.transition, 'none')
  node.moving = true
  returnCdQueueRecord({ node, parent, style: '', targetSlot: 1 })
  assert.equal(node.dataset.cdQueueOriginalTransform, '', 'A repeated handoff never saves a temporary offset as the resting transform')
  settleCdQueueRecord(node, 2)
  assert.equal(node.style.transform, 'translate(-400px, 0px) scale(1)', 'An old slot must not clear the completed position')
  settleCdQueueRecord(node, 1)
  assert.equal(node.style.transform, '')
  assert.equal(node.style.transition, '')
  assert.equal(node.dataset.cdQueueTargetSlot, undefined)
})

test('a disc leaving the queue returns without blocking the next handoff', () => {
  const node = { dataset: {}, style: { cssText: 'transform: translateX(50px)' } }
  const parent = { insertBefore(child) { this.child = child } }
  returnCdQueueRecord({ node, parent, style: '' })
  assert.equal(parent.child, node)
  assert.equal(node.style.cssText, '')
  assert.equal(node.dataset.cdQueueTargetSlot, undefined)
})
