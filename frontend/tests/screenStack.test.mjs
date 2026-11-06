import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { transform } from 'esbuild'

const source = await readFile(new URL('../src/components/ScreenStack.jsx', import.meta.url), 'utf8')
const { code } = await transform(source, { format: 'cjs', loader: 'jsx', jsx: 'automatic', target: 'es2020' })
const script = new vm.Script(code, { filename: 'ScreenStack.jsx' })

function mountStack({ warmTabs = true, nativeIdle = true, savedTop = 0, restorePending = false } = {}) {
  const timers = new Map()
  const idleTasks = new Map()
  const holdListeners = new Set()
  const instances = new Map()
  const restored = []
  const restoreCompletions = []
  const restoreOptions = []
  let taskId = 0
  let held = false
  let current
  let hookIndex
  let tree
  let location = { pathname: '/', search: '', hash: '', key: 'home' }
  const roots = ['/', '/search', '/liked', '/playlists']
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const useRef = (value) => {
    const i = hookIndex++
    return current.hooks[i] ??= { current: value }
  }
  const effect = (phase) => (callback, deps) => {
    const i = hookIndex++
    const previous = current.hooks[i]
    if (sameDeps(previous?.deps, deps)) return
    const next = { deps, cleanup: previous?.cleanup }
    current.hooks[i] = next
    current[phase].push(() => {
      next.cleanup?.()
      next.cleanup = callback()
    })
  }
  const jsx = (type, props, key) => ({ type, props, key })
  const modules = {
    react: {
      memo: (component) => component,
      Suspense: 'Suspense',
      useRef,
      useEffect: effect('effects'),
      useLayoutEffect: effect('layoutEffects'),
      useMemo: (callback) => callback(),
      useReducer: () => [0, () => {}],
      useSyncExternalStore: (_, snapshot) => snapshot(),
    },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-router-dom': {
      UNSAFE_LocationContext: { Provider: 'LocationProvider' },
      UNSAFE_RouteContext: { Provider: 'RouteProvider' },
      useLocation: () => location,
      useNavigationType: () => 'POP',
    },
    'lucide-react': { ArrowLeft: 'ArrowLeft' },
    './Spinner': { default: 'Spinner' },
    './MeterProfiler': { default: 'MeterProfiler' },
    '../hooks/useScreen': { ScreenContext: { Provider: 'ScreenProvider' } },
    '../services/scrollRestoration': {
      scrollKey: (entry) => entry.pathname + entry.search + entry.hash,
      savedScroll: () => savedTop,
      rememberScroll() {},
      restoreScrollPosition(element, top, done, options) {
        restored.push(top)
        element.scrollTop = top
        restoreCompletions.push(done)
        restoreOptions.push(options)
        if (!restorePending) done()
        return done
      },
    },
    '../services/navigation': {
      TAB_ROOTS: roots,
      isTabRoot: (path) => roots.includes(path),
      entryIndexOf: () => 0,
      entryAt: () => null,
      getShownTab: () => null,
      subscribeShownTab: () => () => {},
      clearShownTab() {},
      heavyAnimationsHeld: () => held,
      onHeavyAnimationsHold(callback) { holdListeners.add(callback); return () => holdListeners.delete(callback) },
    },
  }
  const window = {
    setTimeout(callback, ms) { const id = ++taskId; timers.set(id, { callback, ms }); return id },
    clearTimeout: (id) => timers.delete(id),
  }
  if (nativeIdle) {
    window.requestIdleCallback = (callback) => { const id = ++taskId; idleTasks.set(id, { callback }); return id }
    window.cancelIdleCallback = (id) => idleTasks.delete(id)
  }
  const module = { exports: {} }
  script.runInContext(vm.createContext({
    module, exports: module.exports, window,
    require(name) { assert.ok(modules[name], `Unexpected import: ${name}`); return modules[name] },
  }))
  const render = (key, component, props) => {
    let instance = instances.get(key)
    if (!instance) {
      instance = { hooks: [], effects: [], layoutEffects: [], scroller: new EventTarget() }
      instance.scroller.scrollTop = 0
      instances.set(key, instance)
    }
    current = instance
    hookIndex = 0
    const result = component(props)
    const attachRefs = (node) => {
      if (!node || typeof node !== 'object') return
      if (node.props?.ref) node.props.ref.current = instance.scroller
      for (const child of [node.props?.children].flat()) attachRefs(child)
    }
    attachRefs(result)
    for (const phase of ['layoutEffects', 'effects']) {
      for (const callback of instance[phase].splice(0)) callback()
    }
    return result
  }
  const update = () => {
    tree = render('stack', module.exports.default, { warmTabs, isMobile: true, renderRoutes: (entry) => entry.pathname })
  }
  const runTask = (queue, predicate = () => true) => {
    const task = [...queue].find(([, value]) => predicate(value))
    assert.ok(task, 'Expected scheduled work')
    queue.delete(task[0])
    task[1].callback()
    update()
  }
  update()
  return {
    timers, idleTasks, restored, restoreOptions,
    finishRestore: () => restoreCompletions.at(-1)(),
    tabs: () => tree.props.children[0],
    delay: () => runTask(timers, ({ ms }) => ms === 250),
    idle: () => runTask(nativeIdle ? idleTasks : timers, ({ ms }) => nativeIdle || ms === 32),
    hold(value) { held = value; for (const callback of holdListeners) callback(value) },
    navigate(pathname) { location = { pathname, search: '', hash: '', key: `visit:${pathname}` }; update() },
    renderTab(path) {
      const tab = tree.props.children[0].find(({ props }) => props.location.pathname === path)
      render(tab.key, tab.type, tab.props)
      return instances.get(tab.key).scroller
    },
    cleanup() {
      for (const instance of instances.values()) for (const hook of instance.hooks) hook?.cleanup?.()
    },
  }
}

test('Cold mobile tabs have swipeable shells before their contents mount', () => {
  const app = mountStack()
  assert.deepEqual(Array.from(app.tabs(), ({ props }) => props.id), ['tab:/', 'tab:/search', 'tab:/liked', 'tab:/playlists'])
  assert.deepEqual(Array.from(app.tabs(), ({ props }) => props.ready), [true, false, false, false])
  app.delay()
  app.idle()
  assert.deepEqual(Array.from(app.tabs(), ({ props }) => props.ready), [true, true, false, false])
  app.cleanup()
})

test('Tab warming pauses during a swipe and resumes one page at a time after release', () => {
  for (const nativeIdle of [true, false]) {
    const app = mountStack({ nativeIdle })
    app.delay()
    app.hold(true)
    assert.equal(app.idleTasks.size + app.timers.size, 0)
    assert.deepEqual(Array.from(app.tabs(), ({ props }) => props.ready), [true, false, false, false])
    app.hold(false)
    app.idle()
    assert.deepEqual(Array.from(app.tabs(), ({ props }) => props.ready), [true, true, false, false])
    app.idle()
    assert.deepEqual(Array.from(app.tabs(), ({ props }) => props.ready), [true, true, true, false])
    app.cleanup()
    assert.equal(app.idleTasks.size + app.timers.size, 0)
    app.hold(true)
    app.hold(false)
    assert.equal(app.idleTasks.size + app.timers.size, 0)
  }
})

test('A swipe started before the warmup delay keeps cold tabs unmounted until release', () => {
  const app = mountStack()
  app.hold(true)
  app.delay()
  assert.equal(app.idleTasks.size, 0)
  app.hold(false)
  app.idle()
  assert.equal(app.tabs()[1].props.ready, true)
  app.cleanup()
})

test('A warmed tab restores its preview without starting a deadline while hidden', () => {
  const app = mountStack({ savedTop: 800 })
  const scroller = app.renderTab('/search')
  assert.deepEqual(app.restored, [], 'An empty shell started scroll restoration before it could show the saved position')
  app.delay()
  app.idle()
  assert.equal(app.renderTab('/search'), scroller)
  assert.deepEqual(app.restored, [800])
  assert.equal(app.restoreOptions[0].timeoutMs, 0, 'A hidden tab started a restore timeout before pagination could run')
  assert.equal(scroller.scrollTop, 800)
  app.navigate('/search')
  app.renderTab('/search')
  assert.deepEqual(app.restored, [800])
  app.cleanup()
})

test('A deep restoration pauses when hidden and resumes its original target on return', () => {
  const app = mountStack({ savedTop: 8000, restorePending: true })
  app.navigate('/liked')
  const scroller = app.renderTab('/liked')
  assert.deepEqual(app.restored, [8000])
  // Пока пришла только первая страница, фактическая прокрутка короче цели.
  scroller.scrollTop = 1500
  app.navigate('/search')
  app.renderTab('/liked')
  assert.deepEqual(app.restored, [8000, 8000])
  assert.equal(app.restoreOptions.at(-1).timeoutMs, 0)
  app.navigate('/liked')
  app.renderTab('/liked')
  assert.deepEqual(app.restored, [8000, 8000, 8000])
  assert.equal(app.restoreOptions.at(-1).timeoutMs, 10000)
  app.finishRestore()
  scroller.scrollTop = 7600
  app.navigate('/search')
  app.renderTab('/liked')
  app.navigate('/liked')
  app.renderTab('/liked')
  assert.equal(scroller.scrollTop, 7600)
  assert.deepEqual(app.restored, [8000, 8000, 8000], 'A completed restoration ran again and overwrote manual scrolling')
  app.cleanup()
})

test('Opening a cold tab before idle warming restores scrolling without waiting for idle work', () => {
  const app = mountStack({ savedTop: 800 })
  app.renderTab('/search')
  assert.deepEqual(app.restored, [])
  app.hold(true)
  app.navigate('/search')
  assert.equal(app.tabs()[1].props.ready, true)
  const scroller = app.renderTab('/search')
  assert.deepEqual(app.restored, [800])
  assert.equal(scroller.scrollTop, 800)
  scroller.scrollTop = 420
  app.navigate('/liked')
  app.renderTab('/search')
  app.navigate('/search')
  app.renderTab('/search')
  assert.equal(scroller.scrollTop, 420)
  assert.deepEqual(app.restored, [800])
  app.cleanup()
})

test('Without mobile warming, visiting tabs mounts only the pages the user opens', () => {
  const app = mountStack({ warmTabs: false })
  assert.equal(app.tabs().length, 1)
  assert.equal(app.idleTasks.size + app.timers.size, 0)
  app.navigate('/search')
  assert.deepEqual(Array.from(app.tabs(), ({ props }) => props.id), ['tab:/', 'tab:/search'])
  assert.ok(app.tabs().every(({ props }) => props.ready))
  app.cleanup()
})
