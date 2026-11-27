import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { transform } from 'esbuild'

const source = await readFile(new URL('../src/hooks/usePullToRefresh.js', import.meta.url), 'utf8')
const { code } = await transform(source, { format: 'cjs', target: 'es2020' })
const script = new vm.Script(code, { filename: 'usePullToRefresh.js' })

function mountPull() {
  const listeners = new Map()
  const frames = new Map()
  const updates = []
  let refreshes = 0
  let frameId = 0
  let cleanup
  const react = {
    useCallback: (callback) => callback,
    useEffect: (effect) => { cleanup = effect() },
    useRef: (current) => ({ current }),
    useState: (initial) => [initial, (value) => updates.push(value)],
  }
  const module = { exports: {} }
  script.runInContext(vm.createContext({
    module, exports: module.exports,
    require(name) { assert.equal(name, 'react'); return react },
    window: {
      addEventListener: (name, listener) => listeners.set(name, listener),
      removeEventListener: (name) => listeners.delete(name),
    },
    requestAnimationFrame(callback) { const id = ++frameId; frames.set(id, callback); return id },
    cancelAnimationFrame(id) { frames.delete(id) },
  }))
  module.exports.usePullToRefresh({ onRefresh: () => { refreshes += 1 }, reachTop: () => true })
  return {
    updates,
    get refreshes() { return refreshes },
    get pendingFrames() { return frames.size },
    touch(name, x, y) { listeners.get(`touch${name}`)({ touches: name === 'end' ? [] : [{ clientX: x, clientY: y }] }) },
    paint() { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback()) },
    cleanup() { cleanup() },
  }
}

test('A diagonal tab swipe cannot show the refresh indicator or request an update', () => {
  const app = mountPull()
  app.touch('start', 300, 200)
  app.touch('move', 295, 202)
  app.paint()
  app.touch('move', 282, 206)
  app.paint()
  app.touch('move', 140, 240)
  app.paint()
  app.touch('move', 70, 360)
  app.paint()
  app.touch('end', 70, 360)
  assert.deepEqual(app.updates, [])
  assert.equal(app.pendingFrames, 0)
  assert.equal(app.refreshes, 0)
  app.cleanup()
})

test('Finger jitter below the direction threshold does not move the refresh indicator', () => {
  const app = mountPull()
  app.touch('start', 200, 200)
  app.touch('move', 202, 206)
  app.paint()
  assert.deepEqual(app.updates, [])
  app.touch('move', 203, 230)
  app.paint()
  assert.deepEqual(app.updates, [15])
  app.cleanup()
})

test('A deliberate downward pull still refreshes after crossing its threshold', async () => {
  const app = mountPull()
  app.touch('start', 200, 200)
  app.touch('move', 205, 240)
  app.paint()
  app.touch('move', 210, 340)
  app.paint()
  assert.deepEqual(app.updates, [20, 70])
  app.touch('end', 210, 340)
  assert.equal(app.refreshes, 1)
  await Promise.resolve()
  app.cleanup()
})
