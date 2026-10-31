import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const hookSource = await readFile(new URL('../src/hooks/usePwaBackHandler.js', import.meta.url), 'utf8')
const bridgeSource = await readFile(new URL('../../android/app/src/main/assets/bridge.js', import.meta.url), 'utf8')

async function mountBackHandler({ native = true, pathname = '/', idx = 0, fullscreen = false, karaoke = false } = {}) {
  const effects = []
  const navigation = []
  const pushes = []
  const listeners = new Map()
  const player = {
    isFullScreen: fullscreen,
    karaokeMode: karaoke,
    currentTrack: { id: 42 },
    isPlaying: true,
    closeFullScreen() { this.isFullScreen = false; this.karaokeMode = false },
  }
  const add = { request: null, close() { this.request = null } }
  const censor = { track: null, close() { this.track = null } }
  // Zustand actions don't depend on `this`; bind the test stores likewise.
  for (const store of [player, add, censor]) {
    for (const [key, value] of Object.entries(store)) {
      if (typeof value === 'function') store[key] = value.bind(store)
    }
  }
  const storeHook = (state) => Object.assign((select) => select(state), { getState: () => state })
  const window = {
    __boltAndroid: true,
    __boltNativeBack: native,
    location: { pathname, href: `https://boltmusic.lat${pathname}` },
    history: {
      state: { idx },
      pushState(state) { this.state = state; pushes.push(state) },
      back() { navigation.push('history.back') },
    },
    addEventListener(name, listener) { listeners.set(name, listener) },
    removeEventListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name) },
  }
  const context = vm.createContext({ window, setTimeout, Date })
  const modules = {
    react: { useEffect: (effect) => effects.push(effect), useRef: (current) => ({ current }) },
    'react-router-dom': {
      useLocation: () => window.location,
      useNavigate: () => (...args) => navigation.push(args),
    },
    '../store/playerStore': { usePlayerStore: storeHook(player) },
    '../store/addToPlaylistStore': { useAddToPlaylistStore: storeHook(add) },
    '../store/censorDialogStore': { useCensorDialogStore: storeHook(censor) },
    '../services/navigation': {
      isAndroid: true,
      isStandalone: true,
      canGoBack: () => window.history.state.idx > 0,
      isTabRoot: (path) => ['/', '/search', '/liked', '/playlists'].includes(path),
      tabOf: (path) => path.startsWith('/albums') ? '/playlists' : path.startsWith('/artists') ? '/search' : '/',
    },
    '../store/toastStore': { toast: { info() {} } },
    '../services/androidApp': { isAndroidApp: () => window.__boltAndroid },
  }
  const hook = new vm.SourceTextModule(hookSource, { context })
  await hook.link((name) => {
    const exports = modules[name]
    assert.ok(exports, `Unexpected import: ${name}`)
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
    }, { context })
  })
  await hook.evaluate()
  hook.namespace.usePwaBackHandler()
  const cleanups = effects.map((effect) => effect()).filter(Boolean)
  return { window, player, add, censor, navigation, pushes, listeners, cleanup: () => cleanups.forEach((fn) => fn()) }
}

for (const karaoke of [false, true]) {
  test(`Native back closes ${karaoke ? 'karaoke' : 'player'} without leaving the app or stopping audio`, async () => {
    const app = await mountBackHandler({ fullscreen: true, karaoke, pathname: '/search', idx: 2 })
    assert.equal(app.window.__boltHandleBack(), true)
    assert.equal(app.player.isFullScreen, false)
    assert.equal(app.player.karaokeMode, false)
    assert.equal(app.player.isPlaying, true)
    assert.equal(app.player.currentTrack.id, 42)
    assert.deepEqual(app.navigation, [])
    assert.deepEqual(app.pushes, [])
    assert.equal(app.listeners.has('popstate'), false)
    app.cleanup()
  })
}

test('Consecutive back gestures read current stores and close dialogs before the player', async () => {
  const app = await mountBackHandler({ fullscreen: true })
  // Open dialogs after mounting, without a React render.
  app.add.request = { track: { id: 42 } }
  app.censor.track = { id: 42 }
  assert.equal(app.window.__boltHandleBack(), true)
  assert.equal(app.censor.track, null)
  assert.ok(app.add.request)
  assert.equal(app.player.isFullScreen, true)
  assert.equal(app.window.__boltHandleBack(), true)
  assert.equal(app.add.request, null)
  assert.equal(app.player.isFullScreen, true)
  assert.equal(app.window.__boltHandleBack(), true)
  assert.equal(app.player.isFullScreen, false)
  assert.equal(app.window.__boltHandleBack(), false)
  assert.deepEqual(app.navigation, [])
  app.cleanup()
})

test('Native back traverses actual route history', async () => {
  const app = await mountBackHandler({ pathname: '/artists/1', idx: 1 })
  assert.equal(app.window.__boltHandleBack(), true)
  assert.deepEqual(app.navigation, [[-1]])
  app.cleanup()
})

for (const [pathname, target] of [['/liked', '/'], ['/albums/1', '/playlists'], ['/artists/1', '/search']]) {
  test(`Cold start at ${pathname} returns inside the app to ${target}`, async () => {
    const app = await mountBackHandler({ pathname })
    assert.equal(app.window.__boltHandleBack(), true)
    assert.equal(app.navigation.length, 1)
    assert.equal(app.navigation[0][0], target)
    assert.equal(app.navigation[0][1].replace, true)
    app.cleanup()
  })
}

test('Root back lets the native shell minimize; unmount removes its handler', async () => {
  const app = await mountBackHandler()
  assert.equal(app.window.__boltHandleBack(), false)
  app.cleanup()
  assert.equal(app.window.__boltHandleBack, undefined)
})

test('Older APKs retain browser history support until the shell is updated', async () => {
  const app = await mountBackHandler({ native: false, fullscreen: true })
  assert.equal(app.window.__boltHandleBack, undefined)
  assert.equal(app.pushes.length, 2)
  assert.equal(app.pushes[0].__boltBuffer, true)
  assert.equal(app.pushes[1].__boltModal, 'fullscreen')
  app.listeners.get('popstate')()
  assert.equal(app.player.isFullScreen, false)
  app.cleanup()
})

test('Android bridge advertises native back and preserves next/previous commands', () => {
  const messages = []
  const navigator = {}
  const window = {
    BoltAndroid: { postMessage: (message) => messages.push(JSON.parse(message)) },
    matchMedia: () => ({ matches: false }),
  }
  const context = vm.createContext({
    window, navigator, URL,
    location: { href: 'https://boltmusic.lat/' },
    document: { readyState: 'complete', createElement: () => ({}), head: { appendChild() {} } },
  })
  vm.runInContext(bridgeSource, context)
  assert.equal(window.__boltNativeBack, true)
  const commands = []
  navigator.mediaSession.setActionHandler('nexttrack', (details) => commands.push(details.action))
  navigator.mediaSession.setActionHandler('previoustrack', (details) => commands.push(details.action))
  assert.equal(window.__boltMediaAction('nexttrack'), true)
  assert.equal(window.__boltMediaAction('previoustrack'), true)
  assert.deepEqual(commands, ['nexttrack', 'previoustrack'])
  navigator.mediaSession.setActionHandler('nexttrack', null)
  assert.equal(window.__boltMediaAction('nexttrack'), false)
  assert.ok(messages.some((message) => message.t === 'actions'))
})
