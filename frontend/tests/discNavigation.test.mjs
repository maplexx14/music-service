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
  const context = vm.createContext({
    getComputedStyle: (node) => ({ transform: node.computedTransform || node.style?.transform || 'matrix(1, 0, 0, 1, -120, -120)' }),
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this) }
      observe(node) { this.node = node }
      disconnect() { this.disconnected = true }
    },
    document: {
      createElement() {
        return {
          style: {}, attributes: {},
          setAttribute(name, value) { this.attributes[name] = value },
          append(node) { this.record = node },
          querySelector() { return this.record },
          remove() { this.removed = true },
          animate(frames, options) {
            let finish
            const finished = new Promise((resolve) => { finish = resolve })
            this.animation = { frames, options, finished, finish, cancel() { this.cancelled = true } }
            return this.animation
          },
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
