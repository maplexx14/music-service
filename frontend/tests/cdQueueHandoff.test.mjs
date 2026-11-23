import assert from 'node:assert/strict'
import test from 'node:test'
import { returnCdQueueRecord, settleCdQueueRecord, isCdQueueFrameReady } from '../src/utils/cdQueueHandoff.js'

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
