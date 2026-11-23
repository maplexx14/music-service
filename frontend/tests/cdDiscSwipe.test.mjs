import assert from 'node:assert/strict'
import test from 'node:test'
import { createCdDiscSwipe } from '../src/utils/cdDiscSwipe.js'
import { cdDiscSwipeRelease } from '../src/utils/cdDiscSwipeMotion.js'

function environment(scale = 1) {
  globalThis.getComputedStyle = element => ({ transform: 'none', translate: element.style.translate || '0px' })
  const overlay = { offsetWidth: 512, style: {},
    getBoundingClientRect: () => ({ left: 200 + (parseFloat(overlay.style.translate) || 0) * scale, width: 200 }),
    append(node) { node.parentElement = this },
  }
  const records = [-1, 1].map(slot => {
    const parent = { insertBefore(node) { node.parentElement = this } }
    const node = { parentElement: parent, style: { cssText: `slot:${slot}` },
      querySelector: () => ({}),
      getBoundingClientRect: () => ({ left: 200 + slot * 240, width: 200 }),
      cloneNode() { throw new Error('Swipe must borrow the real queue record') },
    }
    return { dataset: { queueSlot: String(slot), queueRecord: String(slot) }, parent, node,
      querySelector: () => node.parentElement === parent ? node : null }
  })
  const swipe = createCdDiscSwipe(overlay, { querySelectorAll: () => records })
  return { swipe, overlay, records }
}

test('a drag moves the current and neighboring real records on one translated plane', () => {
  const { swipe, overlay, records } = environment()
  swipe.update(-80)
  assert.equal(overlay.style.translate, '-80px 0px 2px')
  for (const { node } of records) assert.equal(node.parentElement, overlay)
  assert.equal(swipe.incomingFor('1'), records[1].node)
  assert.equal(swipe.placementFor('1').parent, records[1].parent)
  const positions = records.map(({ node }) => node.style.transform)
  swipe.update(-110)
  swipe.setReleaseVelocity(-1.2)
  assert.deepEqual(swipe.release(1), { element: overlay, from: -110, to: -240, velocity: -1.2,
    incomingFrom: records[1].node.style.transform, incomingTo: `translateX(${240 / 200 * 512}px)` })
  assert.deepEqual(records.map(({ node }) => node.style.transform), positions, 'Only the common plane moves')
  assert.equal(overlay.style.translate, '-110px 0px 2px')
  assert.equal(swipe.prepare(), -110 / 200 * 512)
  assert.equal(overlay.style.translate, '')
  for (const { node, parent, dataset } of records) {
    assert.equal(node.parentElement, parent)
    assert.equal(node.style.cssText, `slot:${dataset.queueSlot}`)
  }
  assert.equal(swipe.incomingFor('1'), undefined)
})

test('perspective uses finger pixels for dragging and the same coordinates for arrival', () => {
  const { swipe, overlay } = environment(1.08)
  swipe.update(-85)
  assert.ok(Math.abs(swipe.visibleOffset() + 85) < 1e-8)
  assert.ok(Math.abs(parseFloat(overlay.style.translate) * 1.08 + 85) < 1e-8)
  swipe.setReleaseVelocity(-1.2)
  const release = swipe.release(1)
  assert.ok(Math.abs(release.from * 1.08 + 85) < 1e-8)
  assert.ok(Math.abs(release.to * 1.08 + 240) < 1e-8)
  assert.ok(Math.abs(release.velocity * 1.08 + 1.2) < 1e-8)
})

test('release keeps the finger velocity and settles monotonically without bouncing', () => {
  for (const sign of [-1, 1]) {
    const from = sign * 80, to = sign * 260, velocity = sign * 1.2
    const options = cdDiscSwipeRelease(from, to, velocity)
    const [, y1, , y2] = options.easing.slice(13, -1).split(',').map(Number)
    assert.ok(Math.abs((to - from) * 3 * y1 / options.duration - velocity) < 1e-8)
    assert.equal(y2, 1, 'The final velocity is zero')
    let previous = 0
    for (let frame = 0; frame <= 120; frame++) {
      const t = frame / 120
      const progress = 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t * t + t ** 3
      assert.ok(progress >= previous && progress <= 1)
      previous = progress
    }
    assert.ok(options.duration <= 340)
  }
})

test('cancelling or reversing the swipe restores every borrowed queue record', () => {
  const { swipe, overlay, records } = environment()
  swipe.update(-40)
  swipe.update(60)
  assert.equal(overlay.style.translate, '60px 0px 2px')
  swipe.clear()
  swipe.clear()
  assert.equal(swipe.offset(), 0)
  for (const { node, parent } of records) assert.equal(node.parentElement, parent)
})
