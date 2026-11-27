import assert from 'node:assert/strict'
import test from 'node:test'
import { createCdDiscExchange, CD_DISC_EXCHANGE_DURATION } from '../src/utils/cdDiscExchange.js'
import { parkCdDiscRecord, subscribeCdDiscRecord, takeCdDiscRecord } from '../src/utils/cdDiscRecords.js'

test('an existing queue slot receives the original departed canvas without waiting for an artwork update', () => {
  const canvas = {}, key = 'test:departed'
  let received
  const unsubscribe = subscribeCdDiscRecord(key, () => { received = takeCdDiscRecord(key) })
  parkCdDiscRecord(key, { canvas })
  assert.equal(received.canvas, canvas)
  assert.equal(takeCdDiscRecord(key), undefined)
  unsubscribe()
  received = null
  parkCdDiscRecord(key, { canvas })
  assert.equal(received, null)
  assert.equal(takeCdDiscRecord(key).canvas, canvas)
})

function environment() {
  const animations = [], events = [], alignments = [], ghosts = new Set()
  let allowed = true
  globalThis.document = { timeline: { currentTime: 1200 }, createElement: () => ({ style: {} }) }
  globalThis.getComputedStyle = () => ({ transform: 'rotate(42deg)' })
  const canvas = { style: {}, width: 512, height: 512, cloneNode() { throw new Error('Do not clone a departing disc') } }
  const node = () => ({
    append() {}, remove() { ghosts.delete(this) },
    animate(frames, options) {
      const animation = { frames, options, cancel() { this.cancelled = true } }
      animations.push(animation)
      return animation
    },
  })
  const layer = { ...node(), cloneNode: node, parentElement: { append(ghost) { ghosts.add(ghost) } } }
  const exchange = createCdDiscExchange({
    canvas, layer, canAnimate: () => allowed,
    align: () => new Promise(resolve => alignments.push(resolve)),
    paint: image => events.push(['paint', image]),
    onHold: held => events.push(['hold', held]),
    onSlide: sliding => events.push(['slide', sliding]),
    onChange() {},
  })
  return { exchange, animations, events, ghosts, alignments, disable() { allowed = false; exchange.sync() } }
}

test('the old artwork stays still until alignment and decoding both finish, then both discs move together', async () => {
  const env = environment()
  env.exchange.begin(1)
  env.exchange.setArtwork('new')
  assert.deepEqual(env.events, [['hold', true]])
  assert.equal(env.animations.length, 0)
  env.alignments[0]()
  await Promise.resolve()
  const [outgoing, incoming] = env.animations
  assert.equal(outgoing.startTime, incoming.startTime)
  assert.equal(incoming.options.duration, CD_DISC_EXCHANGE_DURATION)
  assert.equal(outgoing.frames.at(-1).transform, 'translateX(-120%)')
  assert.equal(incoming.frames[0].transform, 'translateX(120%)')
  assert.deepEqual(env.events.slice(1), [['slide', true], ['paint', 'new']])
  incoming.onfinish()
  assert.equal(env.ghosts.size, 0)
  assert.ok(env.animations.every(animation => animation.cancelled))
  assert.deepEqual(env.events.slice(-2), [['hold', false], ['slide', false]])
})

test('alignment can finish before decoding without clearing the old print', async () => {
  const env = environment()
  env.exchange.begin(-1)
  env.alignments[0]()
  await Promise.resolve()
  assert.equal(env.animations.length, 0)
  assert.deepEqual(env.events, [['hold', true]])
  env.exchange.setArtwork('previous')
  assert.equal(env.animations[0].frames.at(-1).transform, 'translateX(120%)')
  assert.equal(env.animations[1].frames[0].transform, 'translateX(-120%)')
  env.exchange.dispose()
})

test('a late cover from another visual track cannot start the next queued disc motion', async () => {
  const env = environment()
  env.exchange.begin(1, null, undefined, 'latest')
  env.alignments[0]()
  await Promise.resolve()
  env.exchange.setArtwork('old-cover', 'previous')
  env.exchange.failArtwork('previous')
  assert.equal(env.animations.length, 0)
  env.exchange.setArtwork('latest-cover', 'latest')
  assert.equal(env.animations.length, 2)
  assert.ok(env.events.some(([event, image]) => event === 'paint' && image === 'latest-cover'))
  env.exchange.dispose()
})

test('rapid navigation ignores stale alignment completion and removes interrupted discs', async () => {
  const env = environment()
  env.exchange.begin(1)
  env.exchange.setArtwork('first')
  env.exchange.begin(-1)
  env.exchange.setArtwork('latest')
  env.alignments[0]()
  await Promise.resolve()
  assert.equal(env.animations.length, 0)
  env.alignments[1]()
  await Promise.resolve()
  assert.equal(env.animations.length, 2)
  const queuedFinish = env.animations[1].onfinish
  env.exchange.begin(1)
  queuedFinish()
  assert.equal(env.ghosts.size, 0)
  assert.deepEqual(env.events.at(-1), ['hold', true])
  env.exchange.dispose()
})

test('the existing queue record moves into the player without an incoming clone or a second visible source', async () => {
  globalThis.document = { timeline: { currentTime: 1200 } }
  globalThis.getComputedStyle = () => ({ transform: 'none' })
  const animations = [], painted = [], normalized = [], children = new Set()
  let resolveAlignment, released = false, parked, held = false, sliding = false
  const animate = function (frames) {
    const animation = { element: this, frames, cancel() { this.cancelled = true } }
    animations.push(animation)
    return animation
  }
  const parent = { insertBefore(node) { children.delete(node); node.parentElement = this } }
  const arrivingCanvas = { style: {}, classList: { add() {}, remove() {} } }
  let nextCanvas = arrivingCanvas
  const departingCanvas = { style: {}, classList: { add() {} }, width: 512, height: 512, cloneNode() { throw new Error('The departing disc must remain the same canvas') } }
  const incoming = {
    style: { cssText: '', visibility: '' }, parentElement: parent,
    getBoundingClientRect: () => ({ left: 600, top: 700, width: 200, height: 200 }),
    animate,
    querySelector: () => nextCanvas,
    cloneNode() { throw new Error('The incoming queue record must not be cloned') },
  }
  const outgoing = { style: { visibility: '', cssText: '' }, parentElement: parent, replaceChildren(canvas) { this.canvas = canvas }, getBoundingClientRect: () => ({ left: 0, top: 700, width: 200, height: 200 }) }
  const layer = {
    style: { visibility: '' }, animate, append() {},
    parentElement: {
      offsetWidth: 512,
      getBoundingClientRect: () => ({ left: 200, top: 100, width: 400, height: 400 }),
      append(node) { children.add(node) },
    },
    cloneNode: () => ({ classList: { add() {} }, append(node) { this.canvas = node; node.parentElement = this }, animate, remove() { this.removed = true } }),
  }
  const exchange = createCdDiscExchange({
    canvas: departingCanvas, layer,
    paint: (image, target) => target ? normalized.push({ image, target }) : painted.push(image), canAnimate: () => true,
    align: () => new Promise(resolve => { resolveAlignment = resolve }),
    onHold(value) { held = value }, onSlide(value) { sliding = value }, onChange() {},
  })
  exchange.begin(1, { incoming, parent, outgoing, style: '', outgoingVisibility: '', horizontal: true,
    prepare: () => -80,
    // While an old queue commit is pending, its slot metadata can list the
    // same incoming/previous elements again among the farther records.
    extras: [{ node: incoming, targetSlot: 1 }, { node: outgoing, targetSlot: -3 }, { node: incoming, targetSlot: 1 }],
    outgoingOpacity: 0.82, outgoingFilter: 'brightness(0.88)',
    park(record) { parked = record }, release() { released = true } })
  exchange.setArtwork('next')
  resolveAlignment()
  await Promise.resolve()
  assert.equal(animations[1].element, incoming)
  assert.equal(animations[0].element.canvas, departingCanvas)
  assert.equal(layer.style.visibility, 'hidden')
  assert.equal(outgoing.parentElement, animations[2].element, 'The previous disc also moves with the belt')
  assert.deepEqual(painted, [], 'The playback canvas does not create another incoming record during the transfer')
  assert.deepEqual(normalized, [{ image: 'next', target: arrivingCanvas }])
  assert.equal(arrivingCanvas.width, 512, 'The record has its installed dimensions before travelling')
  assert.equal(arrivingCanvas.height, 512)
  assert.equal(animations[1].frames[0].opacity, 1)
  assert.equal(animations[0].frames.at(-1).opacity, 0.82)
  assert.equal(animations[0].frames.at(-1).filter, 'brightness(0.88)')
  assert.equal(animations.length, 3)
  assert.equal(animations[0].element.parentElement, animations[2].element)
  assert.equal(animations[1].element.parentElement, animations[2].element)
  assert.equal(animations[0].frames.at(-1).transform, undefined)
  assert.equal(animations[1].frames[0].transform, undefined)
  assert.match(animations[2].frames.at(-1).transform, /^translateX\(/)
  assert.equal(animations[2].frames[0].transform, 'translateX(-80px)', 'The belt continues from the swipe offset without returning to center')
  animations[0].onfinish()
  assert.equal(parked, undefined, 'Finishing a fade cannot move or settle a disc before the shared belt completes')
  assert.equal(released, false)
  assert.deepEqual(painted, [])
  animations[2].onfinish()
  assert.equal(outgoing.canvas, departingCanvas)
  assert.equal(outgoing.parentElement, parent)
  assert.equal(parked.canvas, departingCanvas, 'The queue receives the same canvas that left the player')
  assert.deepEqual(painted, ['next'])
  assert.equal(incoming.parentElement, parent)
  assert.equal(released, true)
  assert.equal(layer.style.visibility, '')
  assert.equal(outgoing.style.visibility, '')
  // At the first queue item the previous slot does not exist until React
  // renders it. Retain the completed belt pose throughout that handoff.
  nextCanvas = { style: {}, classList: { add() {}, remove() {} } }
  let delayedRecord
  exchange.begin(1, { incoming, parent, outgoing: null, style: '', horizontal: true,
    park(record) { delayedRecord = record }, release() {} })
  exchange.setArtwork('later')
  resolveAlignment()
  await Promise.resolve()
  const delayedBelt = animations[5]
  delayedBelt.onfinish()
  assert.equal(held, true, 'Playback stays held while the departed canvas still belongs to the chassis')
  assert.equal(sliding, true, 'The chassis retains its exchange geometry until the queue adopts the canvas')
  assert.equal(delayedBelt.cancelled, undefined, 'The belt must retain its final position while the previous slot is being mounted')
  assert.equal(delayedBelt.element.removed, undefined)
  delayedRecord.place({ replaceChildren() {} })
  assert.equal(held, false)
  assert.equal(sliding, false)
  assert.equal(delayedRecord.canvas, arrivingCanvas)
  assert.equal(delayedBelt.cancelled, true)
  assert.equal(delayedBelt.element.removed, true)
  nextCanvas = { style: {}, classList: { add() {}, remove() {} } }
  exchange.begin(1, { incoming, parent, outgoing: null, style: '', horizontal: true,
    park() {}, release() {} })
  exchange.setArtwork('unclaimed')
  resolveAlignment()
  await Promise.resolve()
  const unclaimedBelt = animations[8]
  unclaimedBelt.onfinish()
  assert.equal(unclaimedBelt.element.removed, undefined)
  exchange.settleQueueHandoffs()
  assert.equal(unclaimedBelt.cancelled, true, 'Once queue slots have committed, an unclaimed old belt cannot remain on screen')
  assert.equal(unclaimedBelt.element.removed, true)
  exchange.begin(-1)
  assert.equal(unclaimedBelt.cancelled, true, 'A later shift cannot retain an unclaimed old belt')
  exchange.dispose()

  // A following rapid skip can use the prepared queue print before its hero
  // cover resolves. It must also retain acceleration requested while waiting.
  let copied = 0
  globalThis.document.createElement = () => ({ getContext: () => ({ drawImage() { copied++ } }) })
  nextCanvas = { width: 512, height: 512, dataset: { cdArtworkReady: 'true', cdTrackId: 'queued-next' },
    style: {}, classList: { add() {}, remove() {}, contains: () => false }, getContext: () => ({ drawImage() { copied++ } }) }
  const quick = createCdDiscExchange({ canvas: arrivingCanvas, layer,
    canAnimate: () => true, align: () => Promise.resolve(),
    paint() { throw new Error('The ready queue print must not wait for a hero cover') },
    onCanvas() {}, onHold() {}, onSlide() {}, onChange() {} })
  const start = animations.length
  quick.begin(1, { incoming, parent, style: '', horizontal: true, swipe: () => null, park() {} })
  quick.expedite()
  await Promise.resolve()
  assert.equal(animations.length, start + 3)
  assert.ok(copied >= 2, 'Reuse and normalize the actual queue artwork before moving')
  assert.ok(440 / animations.at(-1).playbackRate <= 80)
  animations.at(-1).onfinish()
  quick.settleQueueHandoffs()
  quick.dispose()
  assert.equal(unclaimedBelt.element.removed, true)
})

test('hidden or reduced motion settles artwork and releases playback without leaving ghosts', async () => {
  const env = environment()
  env.exchange.begin(1)
  env.exchange.setArtwork(null)
  env.disable()
  env.alignments[0]()
  await Promise.resolve()
  assert.equal(env.animations.length, 0)
  assert.equal(env.ghosts.size, 0)
  assert.ok(env.events.some(([event, image]) => event === 'paint' && image === null))
  assert.deepEqual(env.events.slice(-2), [['hold', false], ['slide', false]])
})

test('swipe release samples the aligned plane before moving without reparenting or waiting for hero artwork', async () => {
  const animations = [], draws = []
  const context = { drawImage: (...args) => draws.push(args) }
  globalThis.document = { timeline: { currentTime: 10 }, createElement: () => ({ getContext: () => context }) }
  globalThis.getComputedStyle = () => ({ transform: 'rotate(42deg)' })
  const animate = function (frames, options) {
    const animation = { element: this, frames, options, effect: { getTiming: () => options }, currentTime: 0, playbackRate: 1, cancel() {} }
    animations.push(animation)
    return animation
  }
  const overlay = { animate, style: { translate: '-80px 0px 2px' } }
  const original = { width: 512, height: 512, style: {}, classList: { add() {} }, remove() {} }
  const arriving = { width: 512, height: 512, style: {}, getContext: () => context,
    classList: { contains: () => false, remove() {} } }
  const incoming = { parentElement: overlay, animate, querySelector: () => arriving }
  let installed, departed, resolveAlignment, sampled = false, prepared = false, completed = false
  const layer = { parentElement: overlay, append: node => { installed = node },
    cloneNode() { throw new Error('Do not rebuild the finger-driven belt at release') } }
  const exchange = createCdDiscExchange({
    canvas: original, layer, canAnimate: () => true, align: () => new Promise(resolve => { resolveAlignment = resolve }),
    paint() { throw new Error('Preserve the existing queue pixels until the hero artwork is ready') },
    onCanvas() {}, onHold() {}, onSlide() {}, onChange() {},
  })
  exchange.begin(1, { incoming, swipe: () => { sampled = true; return { element: overlay, from: -80, to: -240, velocity: -1.2 } },
    prepare() { prepared = true; overlay.style.translate = '' }, park: record => { departed = record },
  }, () => { completed = true })
  assert.equal(sampled, false, 'Read the final projection after the chassis aligns')
  assert.equal(animations.length, 0)
  exchange.expedite()
  resolveAlignment()
  await Promise.resolve()
  assert.equal(sampled, true)
  assert.equal(animations.length, 2, 'Start before the higher resolution artwork loads')
  assert.equal(animations[0].element, overlay)
  assert.equal(incoming.parentElement, overlay)
  assert.equal(prepared, false)
  assert.equal(animations[0].frames[0].translate, '-80px 0px 2px')
  assert.equal(animations[0].frames[1].translate, '-240px 0px 2px')
  for (const animation of animations) assert.ok(animation.options.duration / animation.playbackRate <= 80,
    'An urgent swipe keeps its short deadline even when it was queued before alignment finished')
  animations[0].onfinish()
  assert.equal(installed, arriving)
  assert.equal(departed.canvas, original)
  assert.equal(prepared, true)
  assert.equal(completed, true)
  assert.equal(draws.length, 2, 'Normalize the padded queue bitmap only after the animation finishes')
  exchange.dispose()
})
