import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../src/hooks/useWarmNextDiscCover.js', import.meta.url), 'utf8')

async function mount({ enabled = true, current = '/a.jpg', next = '/b.jpg', settled = false, connection } = {}) {
  const observers = [], idle = [], loads = []
  let effect, args = [current, next, enabled]
  const main = { hasAttribute: () => settled }
  const arcRef = { current: { querySelector: () => main } }
  const dependencies = {
    react: {
      useEffect(fn, deps) {
        if (effect && deps.every((value, i) => Object.is(value, effect.deps[i]))) return
        effect?.cleanup?.()
        effect = { deps, cleanup: fn() }
      },
    },
    '../utils/media': {
      preloadCover(...args) { loads.push(args); return Promise.resolve(true) },
    },
    '../services/preloadQueue': {
      preloadInIdle(loaders, options) {
        const task = { loaders, options, stopped: false }
        idle.push(task)
        return () => { task.stopped = true }
      },
    },
  }
  const context = vm.createContext({
    navigator: { connection },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this) }
      observe(node) { this.node = node }
      disconnect() { this.disconnected = true }
    },
  })
  const module = new vm.SourceTextModule(source, { context })
  await module.link((name) => new vm.SyntheticModule(Object.keys(dependencies[name]), function () {
    for (const [key, value] of Object.entries(dependencies[name])) this.setExport(key, value)
  }, { context }))
  await module.evaluate()
  const render = () => module.namespace.useWarmNextDiscCover(arcRef, ...args)
  render()
  return {
    observers, idle, loads,
    settleMain() { settled = true; for (const observer of observers) if (!observer.disconnected) observer.callback() },
    change(...nextArgs) { args = nextArgs; render() },
    async runIdle() { for (const task of idle) if (!task.stopped) await task.loaders[0]() },
    unmount() { effect?.cleanup?.() },
  }
}

test('next cover waits for main artwork and loads at low priority only in idle time', async () => {
  const app = await mount()
  assert.equal(app.idle.length, 0)
  app.settleMain()
  assert.equal(app.idle.length, 1)
  assert.equal(app.loads.length, 0)
  app.settleMain()
  assert.equal(app.idle.length, 1)
  await app.runIdle()
  assert.equal(app.loads[0][0], '/b.jpg')
  assert.equal(app.loads[0][1], 10000)
  assert.equal(app.loads[0][2].priority, 'low')
})

test('hidden screens, missing next tracks and shared artwork do not trigger preloading', async () => {
  for (const options of [{ enabled: false }, { current: null }, { next: null }, { next: '/a.jpg' }]) {
    const app = await mount({ settled: true, ...options })
    assert.equal(app.idle.length, 0)
    assert.equal(app.observers.length, 0)
  }
})

test('optional preloading respects data saving and very slow connections', async () => {
  for (const connection of [{ saveData: true }, { effectiveType: '2g' }, { effectiveType: 'slow-2g' }]) {
    const app = await mount({ settled: true, connection })
    assert.equal(app.idle.length, 0)
  }
})

test('changing the queue cancels the old warmup before scheduling the new next cover', async () => {
  const app = await mount({ settled: true })
  app.change('/a.jpg', '/c.jpg', true)
  assert.equal(app.idle[0].stopped, true)
  assert.equal(app.observers[0].disconnected, true)
  await app.runIdle()
  assert.equal(app.loads.length, 1)
  assert.equal(app.loads[0][0], '/c.jpg')
})

test('unmounting cancels queued preloading and disconnects readiness observation', async () => {
  const app = await mount({ settled: true })
  app.unmount()
  await app.runIdle()
  assert.equal(app.loads.length, 0)
  assert.equal(app.observers[0].disconnected, true)
})
