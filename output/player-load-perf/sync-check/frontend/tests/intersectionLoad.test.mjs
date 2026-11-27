import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const sources = Object.fromEntries(await Promise.all(
  ['useIntersectionLoad', 'useInfiniteScroll', 'useLazyBatch'].map(async (name) => [
    name, await readFile(new URL(`../src/hooks/${name}.js`, import.meta.url), 'utf8'),
  ]),
))

async function mount({ active = true, kind = 'infinite', items = [], rootRef } = {}) {
  const document = new EventTarget()
  document.hidden = false
  const scrollerRef = { current: { name: 'screen scroller' } }
  const screen = { active, scrollerRef }
  const observers = []
  const holds = new Set()
  const calls = []
  const hooks = []
  let held = false
  let enabled = true
  let itemCount = 20
  let hookIndex = 0
  let effects = []
  let result
  let callback = () => calls.push('load')
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  const react = {
    useRef(value) { return hooks[hookIndex++] ??= { current: value } },
    useState(value) {
      const i = hookIndex++
      if (!hooks[i]) {
        const state = { value: typeof value === 'function' ? value() : value }
        state.set = (next) => { state.value = typeof next === 'function' ? next(state.value) : next }
        hooks[i] = state
      }
      return [hooks[i].value, hooks[i].set]
    },
    useCallback(fn, deps) {
      const i = hookIndex++
      if (!sameDeps(hooks[i]?.deps, deps)) hooks[i] = { value: fn, deps }
      return hooks[i].value
    },
    useEffect(fn, deps) {
      const i = hookIndex++
      if (sameDeps(hooks[i]?.deps, deps)) return
      const previous = hooks[i]
      hooks[i] = { deps, cleanup: previous?.cleanup }
      effects.push(() => { hooks[i].cleanup?.(); hooks[i].cleanup = fn() })
    },
  }
  const context = vm.createContext({
    document,
    IntersectionObserver: class {
      constructor(fn, options) { this.fn = fn; this.options = options; observers.push(this) }
      observe(node) { this.node = node }
      disconnect() { this.disconnected = true }
      emit(isIntersecting) { this.fn([{ isIntersecting }]) }
    },
  })
  const modules = new Map()
  const dependencies = {
    react,
    './useScreen': { useScreen: () => screen },
    '../services/navigation': {
      heavyAnimationsHeld: () => held,
      onHeavyAnimationsHold(fn) { holds.add(fn); return () => holds.delete(fn) },
    },
  }
  async function load(name) {
    if (modules.has(name)) return modules.get(name)
    const dependency = dependencies[name]
    const module = dependency
      ? new vm.SyntheticModule(Object.keys(dependency), function () {
          for (const [key, value] of Object.entries(dependency)) this.setExport(key, value)
        }, { context })
      : new vm.SourceTextModule(sources[name.replace('./', '')], { context })
    modules.set(name, module)
    await module.link(load)
    await module.evaluate()
    return module
  }
  const name = kind === 'lazy' ? 'useLazyBatch' : 'useInfiniteScroll'
  const hook = (await load(name)).namespace[name]
  const render = () => {
    hookIndex = 0
    effects = []
    result = kind === 'lazy' ? hook(items, { rootRef }) : hook(callback, { enabled, itemCount })
    for (const effect of effects) effect()
  }
  const sentinel = { name: 'end of list' }
  render()
  if (kind === 'lazy') result.sentinelRef(sentinel)
  else result(sentinel)
  render()
  return {
    observers, scrollerRef, calls, sentinel, holds,
    get result() { return result },
    enter(value = true) { observers.at(-1).emit(value); render() },
    active(value) { screen.active = value; render() },
    enable(value) { enabled = value; render() },
    count(value) { itemCount = value; render() },
    callback(fn) { callback = fn; render() },
    hold(value) { held = value; for (const fn of holds) fn(value); render() },
    hide(value) { document.hidden = value; document.dispatchEvent(new Event('visibilitychange')) },
    cleanup() { for (const hook of hooks) hook?.cleanup?.() },
  }
}

test('hidden screens do not load, and activation observes their own scroll container', async () => {
  const app = await mount({ active: false })
  assert.equal(app.observers.length, 0)
  app.active(true)
  assert.equal(app.observers[0].options.root, app.scrollerRef.current)
  assert.equal(app.observers[0].options.rootMargin, '400px')
  app.enter()
  assert.equal(app.calls.length, 1)
  app.active(false)
  app.observers[0].emit(true)
  assert.equal(app.calls.length, 1, 'A queued callback from a hidden screen started a request')
  assert.equal(app.holds.size, 0)
  app.cleanup()
})

test('swipes defer loading until release and discard intersections that have left the viewport', async () => {
  const app = await mount()
  app.hold(true)
  app.enter()
  assert.equal(app.calls.length, 0)
  app.enter(false)
  app.hold(false)
  assert.equal(app.calls.length, 0)
  app.hold(true)
  app.enter()
  app.callback(() => app.calls.push('fresh handler'))
  app.hold(false)
  assert.deepEqual(app.calls, ['fresh handler'])
  app.hold(true)
  app.hold(false)
  app.enter()
  assert.equal(app.calls.length, 1, 'One intersection triggered duplicate requests')
  app.cleanup()
})

test('request completion rearms a visible sentinel and an error can disable retries', async () => {
  const app = await mount()
  app.enter()
  app.enable(false)
  app.observers[0].emit(true)
  assert.equal(app.calls.length, 1)
  app.enable(true)
  app.enter()
  assert.equal(app.calls.length, 2)
  app.enable(false)
  app.hold(true)
  app.hold(false)
  assert.equal(app.calls.length, 2)
  app.cleanup()
})

test('a newly appended page continues loading when React batches both loading states', async () => {
  const app = await mount()
  app.enter()
  assert.equal(app.calls.length, 1)
  // Быстрый ответ закоммитил loading=false и новые данные вместе:
  // enabled ни разу не менялся, маячок всё ещё у нижнего края.
  app.count(40)
  app.enter()
  app.count(60)
  app.enter()
  assert.equal(app.calls.length, 3)
  app.enable(false)
  app.count(80)
  app.observers.at(-1).emit(true)
  assert.equal(app.calls.length, 3)
  app.cleanup()
})

test('backgrounding disconnects observers; foregrounding checks visibility again', async () => {
  const app = await mount()
  const old = app.observers[0]
  app.hide(true)
  assert.equal(old.disconnected, true)
  old.emit(true)
  app.hide(false)
  old.emit(true)
  assert.equal(app.calls.length, 0, 'A stale pre-background intersection was delivered')
  app.enter()
  assert.equal(app.calls.length, 1)
  app.cleanup()
})

test('local batches fill the viewport even when the sentinel stays visible', async () => {
  const rootRef = { current: { name: 'horizontal carousel' } }
  const items = Array.from({ length: 30 }, (_, id) => ({ id }))
  const app = await mount({ kind: 'lazy', items, rootRef })
  assert.equal(app.result.visibleItems.length, 12)
  assert.equal(app.observers[0].options.root, rootRef.current)
  app.enter()
  assert.equal(app.result.visibleItems.length, 24)
  assert.equal(app.observers[0].disconnected, true)
  app.enter()
  assert.equal(app.result.visibleItems.length, 30)
  assert.equal(app.result.hasMore, false)
  assert.equal(app.observers.at(-1).disconnected, true)
  app.cleanup()
})

test('a deferred local batch cannot mount after its screen is hidden', async () => {
  const app = await mount({ kind: 'lazy', items: Array.from({ length: 50 }) })
  app.hold(true)
  app.enter()
  app.active(false)
  app.hold(false)
  assert.equal(app.result.visibleItems.length, 12)
  app.active(true)
  app.enter()
  assert.equal(app.result.visibleItems.length, 24)
  app.cleanup()
})
