import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { transform } from 'esbuild'
import { create } from 'zustand'
import { createBrowserHistory } from '@remix-run/router'

// Keep fresh module scope in each mocked browser with ordinary scripts. The
// previous experimental VM module loader was active when Node 20 CI hit SIGSEGV.
const source = async (path) => {
  const text = await readFile(new URL(`../src/${path}`, import.meta.url), 'utf8')
  const { code } = await transform(text, { format: 'cjs', loader: 'js', target: 'es2020' })
  return new vm.Script(`(function (module, exports, require) {\n${code}\n})`, { filename: path })
}
const sessionSource = await source('services/uiSession.js')
const searchSource = await source('store/searchStore.js')
const cacheSource = await source('services/pageCache.js')
const scrollSource = await source('services/scrollRestoration.js')
const navigationSource = await source('services/navigation.js')
const settingsSource = await source('store/uiSettingsStore.js')

async function environment(storage = new Map(), { path = '/', android = false, transitions = false } = {}) {
  const timers = new Map()
  let timerId = 0
  const window = new EventTarget()
  const document = new EventTarget()
  document.hidden = false
  document.documentElement = { dataset: {}, classList: { contains: () => true, toggle() {} } }
  const viewTransitions = []
  if (transitions) {
    document.documentElement.classList.contains = () => false
    document.startViewTransition = (update) => {
      let finish, reject
      const finished = new Promise((resolve, fail) => { finish = resolve; reject = fail })
      let rejectReady
      const ready = new Promise((_, fail) => { rejectReady = fail })
      const transition = { update, ready, finished, finish, reject, skipped: false, skipTransition() {
        this.skipped = true
        rejectReady(new Error('Transition skipped before ready'))
      } }
      viewTransitions.push(transition)
      return transition
    }
  }
  window.location = new URL(`https://bolt.test${path}`)
  window.__boltAndroid = android
  window.matchMedia = () => ({ matches: false })
  window.innerWidth = 400
  const historyEntries = [{ url: window.location.href, state: null }]
  let currentIndex = 0
  window.history = {
    get state() { return historyEntries[currentIndex].state },
    replaceState(state, _, to) {
      const url = new URL(to || window.location.href, window.location.href)
      window.location = url
      historyEntries[currentIndex] = { state, url: url.href }
    },
    pushState(state, _, to) {
      historyEntries.splice(currentIndex + 1)
      historyEntries.push({ state, url: new URL(to, window.location.href).href })
      currentIndex++
      window.location = new URL(historyEntries[currentIndex].url)
    },
    go(delta) {
      currentIndex += delta
      window.location = new URL(historyEntries[currentIndex].url)
      window.dispatchEvent(new Event('popstate'))
    },
  }
  const observers = []
  const mutations = []
  const observerClass = (list) => class {
    constructor(callback) { this.callback = callback; list.push(this) }
    observe() {}
    disconnect() { this.disconnected = true }
  }
  const localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  }
  const context = vm.createContext({
    window, document, localStorage, Event, Date, console, performance,
    navigator: { userAgent: android ? 'Android' : 'Test', maxTouchPoints: 1 },
    setTimeout: (fn) => { const id = ++timerId; timers.set(id, fn); return id },
    clearTimeout: (id) => timers.delete(id),
    ResizeObserver: observerClass(observers), MutationObserver: observerClass(mutations),
  })
  async function module(script, imports = {}) {
    const loaded = { exports: {} }
    script.runInContext(context)(loaded, loaded.exports, (name) => {
      const exports = imports[name]
      assert.ok(exports, `Unexpected import ${name}`)
      return exports.__esModule ? exports : { __esModule: true, ...exports }
    })
    return loaded.exports
  }
  const session = await module(sessionSource)
  const search = async () => (await module(searchSource, { zustand: { create }, '../services/uiSession': session })).useSearchStore
  const cache = async (api = { get: async () => ({ data: {} }) }) => module(cacheSource, { './uiSession': session, './api': { default: api } })
  const scroll = async () => module(scrollSource, { './uiSession': session })
  const navigation = async () => module(navigationSource, {
    './uiSession': session, './pageCache': { prefetchInFlight: () => false },
    '@remix-run/router': { createBrowserHistory: (options) => createBrowserHistory({ ...options, window }) },
  })
  const settings = async () => (await module(settingsSource, { zustand: { create } })).useUiSettingsStore
  return { session, search, cache, scroll, navigation, settings, localStorage, storage, window, document, timers, observers, mutations, viewTransitions }
}

const authStorage = () => new Map([['auth-storage', JSON.stringify({ token: 'test', user: { id: 7 } })]])

test('backgrounding flushes the latest search; reopening restores query, filter and results', async () => {
  const storage = authStorage()
  const app = await environment(storage)
  const search = await app.search()
  search.getState().setQuery('Muse')
  search.getState().setFilter('library')
  search.getState().setResults({ tracks: [{ id: 42, title: 'Uprising' }], playlists: [] }, 'Muse')
  search.getState().finishSearch('Muse')
  assert.equal(storage.has('bolt-ui-session-v2'), false)
  app.document.hidden = true
  app.document.dispatchEvent(new Event('visibilitychange'))
  const reopened = await environment(storage)
  const restored = (await reopened.search()).getState()
  assert.equal(restored.query, 'Muse')
  assert.equal(restored.filter, 'library')
  assert.equal(restored.results.tracks[0].title, 'Uprising')
  assert.equal(restored.cachedQuery, 'Muse')
})

test('continuous scrolling keeps persistence off the interaction and saves the final position', async () => {
  const app = await environment(authStorage())
  const scroll = await app.scroll()
  const location = { pathname: '/liked', key: 'liked' }
  scroll.rememberScroll(location, 100)
  const firstTimer = app.timers.keys().next().value
  for (let top = 110; top <= 900; top += 10) scroll.rememberScroll(location, top)
  assert.equal(app.timers.has(firstTimer), false, 'An earlier write would serialize the session during scrolling')
  assert.equal(app.timers.size, 1)
  assert.equal(app.storage.has('bolt-ui-session-v2'), false)
  assert.equal(scroll.savedScroll(location), 900)
  app.timers.values().next().value()
  const reopened = await environment(app.storage)
  assert.equal((await reopened.scroll()).savedScroll(location), 900)
})

test('switching accounts and logout clear private context and pending writes', async () => {
  const app = await environment(authStorage())
  const search = await app.search()
  search.getState().setQuery('Private search')
  app.session.flushUiSession()
  app.session.setUiSessionUser(8)
  assert.equal(search.getState().query, '')
  assert.equal(app.session.readUiSession('navigation'), undefined)
  app.session.clearUiSession()
  app.session.setUiSessionUser(null)
  for (const fn of app.timers.values()) fn()
  assert.equal(app.storage.has('bolt-ui-session-v2'), false)
})

test('corrupt, expired and other-user sessions are ignored', async () => {
  for (const data of ['{', JSON.stringify({ userId: '8', savedAt: Date.now(), values: { search: { query: 'secret' } } }),
    JSON.stringify({ userId: '7', savedAt: Date.now() - 49 * 3600000, values: { search: { query: 'old' } } })]) {
    const storage = authStorage()
    storage.set('bolt-ui-session-v2', data)
    const app = await environment(storage)
    assert.equal((await app.search()).getState().query, '')
  }
})

test('cached pages survive reload, preserve untouched pages and invalidate on edits', async () => {
  const storage = authStorage()
  const first = await environment(storage)
  const cache = await first.cache()
  cache.writeCache('artist:Muse', { name: 'Muse' })
  cache.writeCache('playlist:42', { playlist: { name: 'Saved' } })
  first.session.flushUiSession()
  const second = await environment(storage)
  const restored = await second.cache()
  restored.writeCache('home:snapshot', { userId: 7 })
  assert.equal(restored.peekCache('artist:Muse').name, 'Muse')
  restored.invalidateCache('playlist:')
  second.session.flushUiSession()
  const third = await environment(storage)
  const afterEdit = await third.cache()
  assert.equal(afterEdit.peekCache('playlist:42'), undefined)
  assert.equal(afterEdit.peekCache('artist:Muse').name, 'Muse')
  third.session.setUiSessionUser(8)
  assert.equal(afterEdit.peekCache('artist:Muse'), undefined)
})

test('scroll restores after delayed content and stops when the user takes over', async () => {
  const app = await environment(authStorage())
  const scroll = await app.scroll()
  const location = { pathname: '/search', search: '', key: 'original' }
  scroll.rememberScroll(location, 800)
  app.session.flushUiSession()
  const reopened = await environment(app.storage)
  assert.equal((await reopened.scroll()).savedScroll({ ...location, key: 'new' }), 800)
  const element = new EventTarget()
  element.children = [{}]
  let maxTop = 100
  let top = 0
  Object.defineProperty(element, 'scrollTop', { get: () => top, set: (value) => { top = Math.min(maxTop, value) } })
  scroll.restoreScrollPosition(element, 800)
  assert.equal(top, 100)
  maxTop = 1000
  app.mutations[0].callback()
  assert.equal(top, 800)
  assert.equal(app.observers[0].disconnected, true)
  maxTop = 100
  scroll.restoreScrollPosition(element, 900)
  element.dispatchEvent(new Event('wheel'))
  top = 40
  maxTop = 2000
  app.observers[1].callback()
  app.mutations[1].callback()
  assert.equal(top, 40)
})

test('a hidden tab can await delayed content without expiring its saved scroll target', async () => {
  const app = await environment(authStorage())
  const scroll = await app.scroll()
  const element = new EventTarget()
  element.children = [{}]
  let top = 0
  let maxTop = 0
  Object.defineProperty(element, 'scrollTop', { get: () => top, set: (value) => { top = Math.min(maxTop, value) } })
  const cancel = scroll.restoreScrollPosition(element, 8000, () => {}, { timeoutMs: 0 })
  assert.equal(app.timers.size, 0)
  maxTop = 1000
  app.mutations[0].callback()
  assert.equal(top, 1000)
  maxTop = 9000
  app.mutations[0].callback()
  assert.equal(top, 8000)
  assert.equal(app.observers[0].disconnected, true)
  cancel()
})

test('scroll restoration pauses its deadline while the app is in the background', async () => {
  const app = await environment(authStorage())
  const scroll = await app.scroll()
  const element = new EventTarget()
  element.children = [{}]
  let top = 0, maxTop = 0
  Object.defineProperty(element, 'scrollTop', { get: () => top, set: (value) => { top = Math.min(maxTop, value) } })
  scroll.restoreScrollPosition(element, 8000)
  assert.equal(app.timers.size, 1)
  app.document.hidden = true
  app.document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(app.timers.size, 0)
  app.document.hidden = false
  app.document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(app.timers.size, 1)
  maxTop = 9000
  app.mutations[0].callback()
  assert.equal(top, 8000)
  assert.equal(app.timers.size, 0)
})

test('an explicit return to the top cancels delayed restoration instead of fighting the user', async () => {
  const app = await environment(authStorage())
  const scroll = await app.scroll()
  const element = new EventTarget()
  element.children = [{}]
  let top = 0, maxTop = 100
  let completed = 0
  Object.defineProperty(element, 'scrollTop', { get: () => top, set: (value) => { top = Math.min(maxTop, value) } })
  scroll.restoreScrollPosition(element, 8000, () => completed++)
  scroll.cancelScrollRestoration(element)
  element.scrollTop = 0
  maxTop = 9000
  app.mutations[0].callback()
  app.observers[0].callback()
  app.document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(top, 0)
  assert.equal(completed, 1)
  assert.equal(app.timers.size, 0)
  assert.equal(app.observers[0].disconnected, true)
})

test('a late prefetch from the previous account cannot repopulate the new cache', async () => {
  const app = await environment(authStorage())
  let resolve
  const cache = await app.cache({ get: () => new Promise((done) => { resolve = done }) })
  cache.prefetchCache('playlist:42', '/playlists/42')
  app.session.setUiSessionUser(8)
  resolve({ data: { name: 'Private playlist' } })
  await new Promise((done) => setImmediate(done))
  assert.equal(cache.peekCache('playlist:42'), undefined)
})

test('fresh tabs using the default history key restore their own URL position', async () => {
  const app = await environment(authStorage())
  const scroll = await app.scroll()
  scroll.rememberScroll({ pathname: '/search', key: 'default' }, 900)
  scroll.rememberScroll({ pathname: '/artists/Muse', key: 'artist-key' }, 500)
  assert.equal(scroll.savedScroll({ pathname: '/artists/Muse', key: 'default' }), 500)
  assert.equal(scroll.savedScroll({ pathname: '/search', key: 'default' }), 900)
})

test('tab switches replace history; nested routes retain their originating tab', async () => {
  const app = await environment(authStorage())
  const nav = await app.navigation()
  const history = nav.createAppHistory()
  history.listen(() => {})
  history.push('/search')
  history.push('/liked')
  assert.equal(app.window.history.state.idx, 0)
  history.push('/artists/Muse')
  assert.equal(app.window.history.state.idx, 1)
  assert.equal(nav.tabForLocation(history.location), '/liked')
  history.go(-1)
  assert.equal(history.location.pathname, '/liked')
  history.push('/search')
  history.push('/artists/Muse')
  assert.equal(nav.tabForLocation(history.location), '/search')
})

test('an instant tab selection cannot be overwritten by a skipped transition callback', async () => {
  const app = await environment(authStorage(), { transitions: true })
  const nav = await app.navigation()
  const history = nav.createAppHistory()
  const screens = []
  history.listen(({ location }) => { screens.push(location.pathname); nav.notifyRouteCommitted(location.key) })
  history.push('/artists/Old')
  const old = app.viewTransitions[0]
  history.push('/search')
  assert.equal(old.skipped, true)
  await old.update()
  old.finish()
  await Promise.resolve()
  assert.deepEqual(screens, ['/search'])
  assert.equal(history.location.pathname, '/search')
  assert.equal(nav.heavyAnimationsHeld(), false)
  assert.equal(app.document.documentElement.dataset.nav, undefined)
})

test('only the latest animated navigation commits; cancelled transitions release their holds', async () => {
  const app = await environment(authStorage(), { transitions: true })
  const nav = await app.navigation()
  const history = nav.createAppHistory()
  const screens = []
  history.listen(({ location }) => { screens.push(location.pathname); nav.notifyRouteCommitted(location.key) })
  history.push('/artists/Old')
  history.push('/artists/New')
  const [old, next] = app.viewTransitions
  await next.update()
  await old.update()
  old.reject(new Error('Transition superseded'))
  await Promise.resolve()
  assert.deepEqual(screens, ['/artists/New'])
  assert.equal(nav.heavyAnimationsHeld(), true)
  assert.equal(app.document.documentElement.dataset.nav, 'forward')
  next.finish()
  await Promise.resolve()
  assert.equal(nav.heavyAnimationsHeld(), false)
  assert.equal(app.document.documentElement.dataset.nav, undefined)
  assert.equal(app.timers.size, 1, 'Only the session persistence timer should remain')
})

test('stale tab cleanup cannot dismiss a newer selection and external navigation clears the preview', async () => {
  const app = await environment(authStorage())
  const nav = await app.navigation()
  const history = nav.createAppHistory()
  history.listen(() => {})
  nav.showTabNow('/search')
  nav.showTabNow('/liked')
  nav.clearShownTab('/search')
  assert.equal(nav.getShownTab(), '/liked')
  history.push('/liked')
  assert.equal(nav.getShownTab(), '/liked')
  history.push('/artists/Muse')
  assert.equal(nav.getShownTab(), null)
})

test('Android reopens the last route but explicit links and shortcuts take priority', async () => {
  const storage = authStorage()
  const app = await environment(storage, { android: true })
  const nav = await app.navigation()
  const history = nav.createAppHistory()
  history.listen(() => {})
  history.push('/liked')
  history.push('/artists/Muse')
  app.session.flushUiSession()
  for (const [path, expected] of [['/', '/artists/Muse'], ['/track/42', '/track/42'], ['/?app=wave', '/']]) {
    const freshStorage = new Map(storage)
    const reopened = await environment(freshStorage, { path, android: true })
    const restored = (await reopened.navigation()).createAppHistory()
    assert.equal(restored.location.pathname, expected)
    if (path === '/') assert.equal(restored.location.state.__boltTab, '/liked')
  }
})

test('reload restores the previous history entry and account changes discard it', async () => {
  const app = await environment(authStorage())
  const firstNav = await app.navigation()
  const history = firstNav.createAppHistory()
  history.listen(() => {})
  history.push('/search')
  history.push('/artists/Muse')
  const reloadedNav = await app.navigation()
  const reloadedHistory = reloadedNav.createAppHistory()
  assert.equal(reloadedNav.entryAt(0).pathname, '/search')
  assert.equal(reloadedNav.tabForLocation(reloadedHistory.location), '/search')
  app.session.setUiSessionUser(8)
  assert.equal(reloadedNav.entryAt(0), null)
})

test('remembering the player defaults on and respects an explicit opt out', async () => {
  for (const [stored, expected] of [[null, true], [{ liteMode: false }, true], [{ rememberPlayer: false }, false], [{ rememberPlayer: true }, true]]) {
    const app = await environment(authStorage())
    if (stored) app.localStorage.setItem('ui-settings', JSON.stringify(stored))
    assert.equal((await app.settings()).getState().rememberPlayer, expected)
  }
})
