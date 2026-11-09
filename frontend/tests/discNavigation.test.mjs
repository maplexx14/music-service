import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../src/utils/discMotion.js', import.meta.url), 'utf8')

async function setup({ ready = false, settled = false } = {}) {
  const observers = [], ghosts = [], completions = []
  const artwork = {
    attributes: new Set([...(ready ? ['data-cover-ready'] : []), ...(settled ? ['data-cover-settled'] : [])]),
    hasAttribute(name) { return this.attributes.has(name) },
  }
  const slot = { style: { visibility: '', getPropertyValue: () => '1' } }
  function record() {
    const platter = { style: { transform: 'rotate(20deg)' } }
    return {
      style: { transform: '', transition: '' }, offsetWidth: 240,
      cloneNode: () => record(),
      closest: () => slot,
      querySelector: (name) => name === '.hero-disc' ? artwork : name === '.hero-disc-spin' ? platter : null,
      querySelectorAll: () => [],
    }
  }
  const liveRecord = record()
  const arc = { clientWidth: 390, append: (ghost) => ghosts.push(ghost) }
  function animate(frames, options) {
    let finish
    const finished = new Promise((resolve) => { finish = resolve })
    this.animation = {
      frames, options, finished, finish,
      effect: { progress: 0, getComputedTiming() { return { progress: this.progress } } },
      pause() { this.paused = true },
      play() { this.paused = false },
      cancel() { this.cancelled = true },
    }
    return this.animation
  }
  const context = vm.createContext({
    getComputedStyle: (node) => ({ transform: node.computedTransform || node.style?.transform || 'matrix(1, 0, 0, 1, -120, -120)' }),
    DOMMatrixReadOnly: class {
      constructor(transform) {
        const values = transform.match(/-?\d+(?:\.\d+)?/g).map(Number)
        this.m41 = values[4]
        this.m42 = values[5]
      }
    },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this) }
      observe(node) { this.node = node }
      disconnect() { this.disconnected = true }
    },
    document: {
      timeline: { currentTime: 500 },
      createElement() {
        return {
          style: {}, attributes: {},
          setAttribute(name, value) { this.attributes[name] = value },
          append(node) { this.record = node },
          querySelector() { return this.record },
          remove() { this.removed = true },
          animate,
        }
      },
    },
  })
  const module = new vm.SourceTextModule(source, { context })
  await module.link(() => {})
  await module.evaluate()
  return {
    artwork, slot, ghosts, observers, liveRecord, completions,
    start(options = {}) {
      return module.namespace.animateDiscNavigation(arc, liveRecord, {
        returning: true, key: 'local:1', onFinish: (motion) => completions.push(motion), ...options,
      })
    },
    update(...attributes) {
      for (const attribute of attributes) artwork.attributes.add(attribute)
      observers.at(-1)?.callback()
    },
    async finish() { ghosts.at(-1).animation.finish(); await Promise.resolve(); await Promise.resolve() },
    drumSlots(rows) {
      return new Map(rows.map(([key, x, ready = true]) => {
        const art = {
          hasAttribute: (name) => name === 'data-cover-ready' || name === 'data-cover-settled' ? ready : false,
        }
        function discRecord() {
          const copy = record()
          copy.querySelector = (name) => name === '.hero-disc' ? art : null
          copy.cloneNode = discRecord
          return copy
        }
        const disc = discRecord()
        const node = { style: { visibility: '' }, animate, querySelector: (name) => name === '.hero-disc' ? art : disc }
        return [key, { node, record: disc, x, desktopY: x ? 43 : 0, art,
          settle() { art.hasAttribute = () => true; observers.at(-1)?.callback() },
        }]
      }))
    },
    drum(previous, current, options = {}) {
      arc.clientWidth = 1000
      arc.clientHeight = 600
      arc.querySelector = () => liveRecord
      return module.namespace.animateDiscDrum(arc, previous, current, { direction: 1, ...options })
    },
    entrance(slots, onFinish) {
      arc.clientWidth = 1000
      arc.clientHeight = 600
      arc.querySelector = () => liveRecord
      return module.namespace.animateDiscDialEntrance(arc, slots, onFinish)
    },
  }
}

test('return waits for artwork and flies visibly from the right before revealing the live disc', async () => {
  const app = await setup()
  const motion = app.start()
  assert.equal(app.ghosts.length, 0)
  assert.equal(app.slot.style.visibility, 'hidden')
  app.update('data-cover-ready', 'data-cover-settled')
  const ghost = app.ghosts[0]
  assert.equal(ghost.animation.frames[0].transform, 'translateX(331px)')
  assert.equal(ghost.animation.frames[1].transform, 'translateX(0)')
  assert.equal(ghost.record.style.transform, 'translate(-50%, -50%) scale(1)')
  assert.equal(app.slot.style.visibility, 'hidden')
  await app.finish()
  assert.equal(app.slot.style.visibility, '')
  assert.equal(ghost.removed, true)
  assert.equal(app.completions[0], motion)
})

test('cached artwork starts returning immediately at the full current-disc size', async () => {
  const app = await setup({ ready: true, settled: true })
  app.start()
  assert.equal(app.observers.length, 0)
  assert.equal(app.ghosts.length, 1)
  assert.equal(app.ghosts[0].record.style.transform, 'translate(-50%, -50%) scale(1)')
  assert.equal(app.ghosts[0].attributes['aria-hidden'], 'true')
  assert.equal(app.ghosts[0].inert, true)
})

test('failed artwork releases the hidden slot without animating an empty copy', async () => {
  const app = await setup()
  const motion = app.start()
  app.update('data-cover-settled')
  assert.equal(app.ghosts.length, 0)
  assert.equal(app.slot.style.visibility, '')
  assert.equal(app.completions[0], motion)
  assert.equal(app.observers[0].disconnected, true)
})

test('a cancelled return cannot start later when its artwork finishes loading', async () => {
  const app = await setup()
  const motion = app.start()
  motion.cleanup()
  app.update('data-cover-ready', 'data-cover-settled')
  assert.equal(app.ghosts.length, 0)
  assert.equal(app.slot.style.visibility, '')
  assert.equal(app.completions.length, 1)
})

test('a fast backward return continues a departing disc from its current position', async () => {
  const app = await setup({ ready: true, settled: true })
  const forward = app.start({ returning: false })
  forward.ghost.computedTransform = 'matrix(1, 0, 0, 1, 150, 0)'
  app.start({ interrupted: forward })
  assert.equal(app.ghosts[0].removed, true)
  assert.equal(app.ghosts[1].animation.frames[0].transform, 'matrix(1, 0, 0, 1, 150, 0)')
  assert.equal(app.ghosts[1].animation.frames[1].transform, 'translateX(0)')
  await app.finish()
  assert.equal(app.slot.style.visibility, '')
})

test('desktop navigation moves both existing discs around the drum in one synchronized step', async () => {
  const app = await setup()
  const previous = app.drumSlots([['a', 0], ['b', 32], ['z', -32]])
  const current = app.drumSlots([['b', 0], ['c', 32], ['a', -32]])
  const motion = app.drum(previous, current)
  const first = motion.entries.get('a').animation
  const next = motion.entries.get('b').animation
  assert.equal(first.frames[0].transform, 'translate(0px, 0px)')
  assert.equal(first.frames.at(-1).transform, 'translate(-320px, 258px)')
  assert.equal(next.frames[0].transform, 'translate(320px, 258px)')
  assert.equal(next.frames.at(-1).transform, 'translate(0px, 0px)')
  assert.ok(next.frames.length > 2, 'travel follows a curved drum path')
  const incoming = motion.entries.get('c').animation.frames
  const outgoing = motion.entries.get('z').animation.frames
  assert.equal(incoming[0].transform, 'translate(0px, 418px)')
  assert.equal(outgoing.at(-1).transform, 'translate(0px, 418px)')
  const point = (frame) => frame.transform.slice(10, -1).split(', ').map(parseFloat)
  assert.ok(incoming.slice(0, 13).every((frame) => Math.abs(point(frame)[0]) < 0.001 && point(frame)[1] === 418), 'replacement waits at the hidden bottom')
  assert.ok(outgoing.slice(12).every((frame) => Math.abs(point(frame)[0]) < 0.001 && point(frame)[1] === 418), 'old record exits before the replacement arrives')
  assert.ok(outgoing.slice(1, 12).every((frame) => point(frame)[0] > -320 && point(frame)[0] < 0))
  assert.ok(incoming.slice(13, 24).every((frame) => point(frame)[0] > 0 && point(frame)[0] < 320))
  assert.ok([...motion.entries.values()].every(({ animation }) => animation.startTime === 500 && animation.options.duration === 350))
  motion.cleanup()
  assert.equal(app.ghosts[0].removed, true)
})

test('three retained desktop discs exchange all positions around a closed circle', async () => {
  const app = await setup()
  const previous = app.drumSlots([['a', 0], ['b', 32], ['c', -32]])
  const current = app.drumSlots([['b', 0], ['c', 32], ['a', -32]])
  const motion = app.drum(previous, current)
  const bottomPass = motion.entries.get('c').animation.frames
  assert.equal(bottomPass[0].transform, 'translate(-320px, 258px)')
  assert.equal(bottomPass.at(-1).transform, 'translate(320px, 258px)')
  const middle = bottomPass[12].transform.slice(10, -1).split(', ').map(parseFloat)
  assert.ok(Math.abs(middle[0]) < 0.001)
  assert.equal(middle[1], 418)
  assert.equal(app.ghosts.length, 0)
  motion.cleanup()
})

test('backward desktop navigation follows the same lower arc in reverse', async () => {
  const app = await setup()
  const previous = app.drumSlots([['b', 0], ['c', 32], ['a', -32]])
  const current = app.drumSlots([['a', 0], ['b', 32], ['z', -32]])
  const motion = app.drum(previous, current, { direction: -1 })
  assert.equal(motion.entries.get('a').animation.frames[0].transform, 'translate(-320px, 258px)')
  assert.equal(motion.entries.get('a').animation.frames.at(-1).transform, 'translate(0px, 0px)')
  assert.equal(motion.entries.get('c').animation.frames.at(-1).transform, 'translate(0px, 418px)')
  assert.equal(motion.entries.get('z').animation.frames[0].transform, 'translate(0px, 418px)')
  assert.equal(motion.entries.get('z').animation.frames.at(-1).transform, 'translate(-320px, 258px)')
  motion.cleanup()
})

test('a cold upcoming cover cannot delay a desktop skip and joins its existing timeline after decoding', async () => {
  const app = await setup()
  const previous = app.drumSlots([['a', 0], ['b', 32], ['z', -32]])
  const current = app.drumSlots([['b', 0], ['c', 32, false], ['a', -32]])
  const motion = app.drum(previous, current)
  assert.ok([...motion.entries.values()].every(({ animation }) => !animation.paused && animation.startTime === 500))
  assert.equal(current.get('c').node.style.visibility, 'hidden')
  const incoming = motion.entries.get('c').animation
  incoming.currentTime = 120
  current.get('c').settle()
  assert.equal(current.get('c').node.style.visibility, '')
  assert.equal(incoming.currentTime, 120, 'decoding must not restart the moving preview')
  assert.ok([...motion.entries.values()].every(({ animation }) => !animation.paused && animation.startTime === 500))
  motion.cleanup()
})

test('skipping to a cold selected cover still moves the previous record immediately', async () => {
  const app = await setup()
  const previous = app.drumSlots([['a', 0], ['b', 32, false]])
  const current = app.drumSlots([['b', 0, false], ['c', 32, false], ['a', -32]])
  const motion = app.drum(previous, current)
  assert.equal(motion.entries.get('a').animation.paused, false)
  assert.equal(motion.entries.get('a').animation.startTime, 500)
  assert.equal(motion.entries.get('b').animation.paused, false)
  assert.equal(current.get('b').node.style.visibility, 'hidden')
  current.get('b').settle()
  assert.equal(current.get('b').node.style.visibility, '')
  motion.cleanup()
})

test('desktop reversal resumes existing and returning discs from their rendered positions', async () => {
  const app = await setup()
  const initial = app.drumSlots([['a', 0], ['b', 32], ['z', -32]])
  const next = app.drumSlots([['b', 0], ['c', 32], ['a', -32]])
  const forward = app.drum(initial, next)
  forward.entries.get('a').node.computedTransform = 'matrix(1, 0, 0, 1, -150, 24)'
  forward.entries.get('z').node.computedTransform = 'matrix(1, 0, 0, 1, -450, 258)'
  for (const entry of forward.entries.values()) entry.animation.effect.progress = 0.25
  const backward = app.drum(next, initial, { direction: -1, interrupted: forward })
  assert.equal(backward.entries.get('a').animation.frames[0].transform, 'translate(-150px, 24px)')
  assert.equal(backward.entries.get('a').animation.frames.at(-1).transform, 'translate(0px, 0px)')
  assert.equal(backward.entries.get('z').animation.frames[0].transform, 'translate(-450px, 258px)')
  assert.equal(backward.entries.get('z').animation.frames.at(-1).transform, 'translate(-320px, 258px)')
  assert.equal(app.ghosts[0].removed, true)
  backward.cleanup()
})

test('a cancelled desktop skip cannot restart when pending artwork is decoded', async () => {
  const app = await setup()
  const previous = app.drumSlots([['a', 0], ['b', 32], ['z', -32]])
  const current = app.drumSlots([['b', 0], ['c', 32, false], ['a', -32]])
  const motion = app.drum(previous, current)
  const animations = [...motion.entries.values()].map(({ animation }) => animation)
  motion.cleanup()
  current.get('c').settle()
  assert.ok(animations.every((animation) => animation.cancelled))
  assert.equal(app.observers.at(-1).disconnected, true)
  assert.equal(current.get('c').node.style.visibility, '')
})

test('a moving disc removed by a second skip continues on the orbit without teleporting', async () => {
  const app = await setup()
  const initial = app.drumSlots([['a', 0], ['b', 32], ['z', -32]])
  const next = app.drumSlots([['b', 0], ['c', 32], ['a', -32]])
  const forward = app.drum(initial, next)
  const departing = forward.entries.get('a')
  departing.animation.effect.progress = 0.25
  const point = departing.pointAt(0.25)
  departing.node.isConnected = false
  const after = app.drumSlots([['c', 0], ['d', 32], ['b', -32]])
  const continued = app.drum(next, after, { interrupted: forward })
  assert.equal(continued.entries.get('a').animation.frames[0].transform, `translate(${point.x}px, ${point.y}px)`)
  assert.equal(continued.entries.get('a').record.style.transform, 'translate(-50%, -50%) scale(1)')
  continued.cleanup()
})

test('a disc already hidden at the bottom does not take an extra lap on reversal', async () => {
  const app = await setup()
  const initial = app.drumSlots([['a', 0], ['b', 32], ['z', -32]])
  const next = app.drumSlots([['b', 0], ['c', 32], ['a', -32]])
  const forward = app.drum(initial, next)
  const incoming = forward.entries.get('c')
  incoming.angleAt = () => Math.PI / 2 + Number.EPSILON
  incoming.node.computedTransform = 'matrix(1, 0, 0, 1, 0, 418)'
  const returning = app.drum(next, initial, { direction: -1, interrupted: forward })
  const frames = returning.entries.get('c').animation.frames
  assert.ok(frames.every((frame) => {
    const [x, y] = frame.transform.slice(10, -1).split(', ').map(parseFloat)
    return Math.abs(x) < 0.001 && Math.abs(y - 418) < 0.001
  }))
  returning.cleanup()
})

function dialPoint(frame, progress = 0) {
  const [_, pivot, rotation, x, y, counterRotation] = frame.transform.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g).map(Number)
  assert.equal(rotation + counterRotation, 0, 'artwork stays upright')
  const angle = rotation * (1 - progress) * Math.PI / 180
  return { x: x * Math.cos(angle) - y * Math.sin(angle), y: pivot + x * Math.sin(angle) + y * Math.cos(angle), pivot }
}

test('desktop entrance rotates around one common pivot with fixed spacing and angular speed', async () => {
  const app = await setup()
  const slots = app.drumSlots([['a', 0], ['b', 32], ['c', -32]])
  const motion = app.entrance(slots)
  const frames = (key) => slots.get(key).node.animation.frames
  assert.ok(motion.animations.every((animation) => animation.options.duration === 400 && animation.startTime === 500))
  assert.ok(Math.abs(dialPoint(frames('c')[0]).y - (600 * 0.47 + 240 / 2 + 2)) < 0.001, 'first existing record starts just below the visible edge')
  for (const [key, x, y] of [['a', 0, 0], ['b', 320, 258], ['c', -320, 258]]) {
    const end = dialPoint(frames(key).at(-1))
    assert.ok(Math.abs(end.x - x) < 0.001 && Math.abs(end.y - y) < 0.001)
  }
  const order = ['c', 'a', 'b']
  const points = (progress) => order.map((key) => dialPoint(frames(key)[0], progress))
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
  const initial = points(0)
  assert.ok(initial.every((point) => point.y >= 404 - 0.001), 'every record starts below the clip')
  for (const progress of [0.1, 0.5, 0.9, 1]) {
    const current = points(progress)
    assert.ok(current.every((point) => point.pivot === initial[0].pivot))
    for (let index = 0; index < current.length; index++) {
      assert.ok(Math.abs(distance(current[index], current[(index + 1) % current.length]) -
        distance(initial[index], initial[(index + 1) % initial.length])) < 0.001, 'records move as a rigid dial')
      assert.ok(Math.abs(Math.hypot(current[index].x, current[index].y - current[index].pivot) -
        Math.hypot(initial[index].x, initial[index].y - initial[index].pivot)) < 0.001, 'each record follows a circle')
    }
  }
  assert.ok(motion.animations.every((animation) => animation.frames.every((frame) => !('opacity' in frame))))
  motion.cleanup()
})

test('without a previous track the current record leads the circular desktop entrance', async () => {
  const app = await setup()
  const slots = app.drumSlots([['a', 0], ['b', 32]])
  const motion = app.entrance(slots)
  const main = dialPoint(slots.get('a').node.animation.frames[0])
  const next = dialPoint(slots.get('b').node.animation.frames[0])
  assert.ok(Math.abs(main.y - 404) < 0.001)
  assert.ok(next.y >= 404)
  assert.equal(motion.animations.length, 2)
  motion.cleanup()
})

test('desktop entrance finishes together and cancellation suppresses late completion', async () => {
  const app = await setup()
  const slots = app.drumSlots([['a', 0], ['b', 32], ['c', -32]])
  let completions = 0
  const motion = app.entrance(slots, () => { completions += 1 })
  motion.animations[0].finish()
  motion.animations[1].finish()
  await Promise.resolve()
  assert.equal(completions, 0)
  motion.animations[2].finish()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(completions, 1)
  assert.ok(motion.animations.every((animation) => animation.cancelled))
  const cancelled = app.entrance(slots, () => { completions += 1 })
  cancelled.cleanup()
  for (const animation of cancelled.animations) animation.finish()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(completions, 1)
})

test('failed desktop artwork does not enter as an empty record', async () => {
  const app = await setup()
  const slots = app.drumSlots([['a', 0], ['b', 32, false], ['c', -32]])
  const motion = app.entrance(slots)
  assert.equal(motion.animations.length, 2)
  assert.equal(slots.get('b').node.animation, undefined)
  motion.cleanup()
})
