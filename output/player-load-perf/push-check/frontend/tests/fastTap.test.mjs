import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../src/services/fastTap.js', import.meta.url), 'utf8')

async function setup() {
  const actions = []
  const listeners = { document: new Map(), window: new Map() }
  let hit = null
  class Element {
    constructor(selectors, parent = null, action = null) {
      this.selectors = selectors
      this.parent = parent
      this.action = action
      this.isConnected = true
    }
    matches(selector) {
      return selector.split(',').some((part) => this.selectors.includes(part.trim()))
    }
    closest(selector) {
      return this.matches(selector) ? this : this.parent?.closest(selector) ?? null
    }
    contains(target) {
      for (let node = target; node; node = node.parent) {
        if (node === this) return true
      }
      return false
    }
    click() {
      actions.push(this.action)
    }
  }
  const document = {
    addEventListener: (type, listener) => listeners.document.set(type, listener),
    elementFromPoint: () => hit,
  }
  const window = { addEventListener: (type, listener) => listeners.window.set(type, listener) }
  const context = vm.createContext({ document, window, Element, performance: { now: () => 1000 } })
  const module = new vm.SourceTextModule(source, { context })
  await module.link(() => { throw new Error('Unexpected import') })
  await module.evaluate()
  module.namespace.installFastTap()

  const row = new Element(['[data-fast-tap]'], null, 'play')
  const title = new Element([], row)
  const artist = new Element(['a[href]', '[data-precise-tap]'], row, 'artist')
  const artistText = new Element([], artist)
  const button = new Element(['button'], row, 'like')
  const emit = (type, target, overrides = {}) => {
    const event = {
      type, target, pointerType: 'touch', isPrimary: true,
      clientX: 100, clientY: 100, timeStamp: type === 'pointerdown' ? 100 : 200,
      isTrusted: true, detail: 1,
      preventDefault() { this.defaultPrevented = true },
      stopPropagation() { this.propagationStopped = true },
      ...overrides,
    }
    const owner = ['click', 'mousedown', 'mouseup'].includes(type) ? 'window' : 'document'
    listeners[owner].get(type)?.(event)
    return event
  }
  const tap = (target, physicalTarget = target) => {
    hit = physicalTarget
    emit('pointerdown', target)
    emit('pointerup', target)
  }
  return { actions, row, title, artist, artistText, button, emit, tap, setHit: (target) => { hit = target } }
}

test('A touch near the artist plays the row when the browser expands the link target', async () => {
  const app = await setup()
  app.tap(app.artistText, app.title)
  assert.deepEqual(app.actions, ['play'])
})

test('A touch on the artist opens only the artist, including nested text', async () => {
  const app = await setup()
  app.tap(app.artistText)
  assert.deepEqual(app.actions, ['artist'])
  const duplicate = app.emit('click', app.artist)
  assert.equal(duplicate.defaultPrevented, true)
  assert.equal(duplicate.propagationStopped, true)
})

test('Physical contact on the artist wins over a browser target pointing at the row', async () => {
  const app = await setup()
  app.tap(app.row, app.artistText)
  assert.deepEqual(app.actions, ['artist'])
})

test('A delayed browser click on the artist cannot navigate after the row starts playing', async () => {
  const app = await setup()
  app.tap(app.title)
  for (const type of ['mousedown', 'mouseup', 'click']) {
    // Browser touch adjustment can place the compatible click farther away.
    const duplicate = app.emit(type, app.artist, { clientY: 140 })
    assert.equal(duplicate.propagationStopped, true, type)
    assert.equal(duplicate.defaultPrevented, type === 'click' ? true : undefined, type)
  }
  assert.deepEqual(app.actions, ['play'])
})

test('New touches and mouse presses are independent of the previous duplicate guard', async () => {
  const app = await setup()
  app.tap(app.title)
  app.emit('pointerdown', app.button, { pointerType: 'mouse' })
  app.emit('pointerup', app.button, { pointerType: 'mouse' })
  const mouseClick = app.emit('click', app.button, { pointerType: 'mouse' })
  assert.equal(mouseClick.propagationStopped, undefined)
  app.tap(app.button)
  assert.deepEqual(app.actions, ['play', 'like'])
})

test('Keyboard activation remains available after a touch on the same row', async () => {
  const app = await setup()
  app.tap(app.title)
  const keyboardClick = app.emit('click', app.artist, { detail: 0, clientX: 0, clientY: 0 })
  assert.equal(keyboardClick.propagationStopped, undefined)
})

for (const interruption of ['pointermove', 'pointercancel', 'scroll']) {
  test(`${interruption} cancels touch activation`, async () => {
    const app = await setup()
    app.setHit(app.title)
    app.emit('pointerdown', app.title)
    app.emit(interruption, app.title, { clientY: 115 })
    app.emit('pointerup', app.title)
    assert.deepEqual(app.actions, [])
  })
}

test('A long press does not trigger fast playback or artist navigation', async () => {
  const app = await setup()
  app.setHit(app.artist)
  app.emit('pointerdown', app.artist)
  app.emit('pointerup', app.artist, { timeStamp: 550 })
  assert.deepEqual(app.actions, [])
})
