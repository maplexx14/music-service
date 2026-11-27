import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { transform } from 'esbuild'

const hookSource = await readFile(new URL('../src/hooks/usePwaBackHandler.js', import.meta.url), 'utf8')
const bridgeSource = await readFile(new URL('../../android/app/src/main/assets/bridge.js', import.meta.url), 'utf8')

// Use the stable Script API after this suite hit SIGSEGV on Node 20 CI with
// experimental VM modules. Compile the real hook once; each case gets a fresh
// context and its own mocked imports, stores, history and React effects.
const { code: hookCode } = await transform(hookSource, {
  format: 'cjs', target: 'es2020', sourcefile: 'usePwaBackHandler.js',
})
const hookScript = new vm.Script(hookCode, { filename: 'usePwaBackHandler.js' })

async function mountBackHandler({ native = true, android = true, standalone = true, pathname = '/', idx = 0, fullscreen = false, karaoke = false, tab } = {}) {
  const effects = []
  const refs = []
  let effectIndex = 0
  let refIndex = 0
  let pendingEffects = []
  const navigation = []
  const pushes = []
  const listeners = new Map()
  const timers = []
  const toasts = []
  const entries = [{ state: { idx, key: 'page', usr: { from: 'library', __boltTab: tab } }, href: `https://boltmusic.lat${pathname}` }]
  let historyIndex = 0
  let pendingBacks = 0
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
    __boltAndroid: android,
    __boltNativeBack: native,
    location: new URL(entries[0].href),
    history: {
      get state() { return entries[historyIndex].state },
      pushState(state, _, href) {
        entries.splice(historyIndex + 1, Infinity, { state, href })
        historyIndex += 1
        window.location = new URL(href)
        pushes.push(state)
      },
      back() { navigation.push('history.back'); pendingBacks += 1 },
    },
    addEventListener(name, listener) { listeners.set(name, listener) },
    removeEventListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name) },
  }
  const navigate = (...args) => navigation.push(args)
  const modules = {
    react: {
      useEffect(effect, deps) {
        const index = effectIndex++
        const previous = effects[index]
        if (!previous || !deps || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
          pendingEffects.push(() => {
            previous?.cleanup?.()
            effects[index] = { deps, cleanup: effect() }
          })
        }
      },
      useRef(current) { return refs[refIndex++] ??= { current } },
    },
    'react-router-dom': {
      useLocation: () => ({ pathname: window.location.pathname, state: window.history.state.usr }),
      useNavigate: () => navigate,
    },
    '../store/playerStore': { usePlayerStore: storeHook(player) },
    '../store/addToPlaylistStore': { useAddToPlaylistStore: storeHook(add) },
    '../store/censorDialogStore': { useCensorDialogStore: storeHook(censor) },
    '../services/navigation': {
      isAndroid: android,
      isStandalone: standalone,
      canGoBack: () => window.history.state.idx > 0,
      isTabRoot: (path) => ['/', '/search', '/liked', '/playlists'].includes(path),
      tabForLocation: ({ pathname, state }) => state?.__boltTab ?? (pathname.startsWith('/albums') ? '/playlists' : pathname.startsWith('/artists') ? '/search' : '/'),
    },
    '../store/toastStore': { toast: { info: (...args) => toasts.push(args) } },
    '../services/androidApp': { isAndroidApp: () => window.__boltAndroid },
  }
  const hook = { exports: {} }
  const context = vm.createContext({
    window, setTimeout: (fn) => timers.push(fn), Date,
    module: hook,
    exports: hook.exports,
    require(name) {
      const exports = modules[name]
      assert.ok(exports, `Unexpected import: ${name}`)
      return exports
    },
  })
  hookScript.runInContext(context)
  const rerender = () => {
    effectIndex = 0
    refIndex = 0
    pendingEffects = []
    hook.exports.usePwaBackHandler()
    pendingEffects.forEach((effect) => effect())
  }
  // Like browser history, back() schedules a popstate after the closing render.
  const flushBack = () => {
    assert.ok(pendingBacks > 0, 'Expected a pending history.back()')
    assert.ok(historyIndex > 0, 'Expected a previous history entry')
    pendingBacks -= 1
    historyIndex -= 1
    window.location = new URL(entries[historyIndex].href)
    listeners.get('popstate')?.({ state: window.history.state })
    rerender()
    timers.splice(0).forEach((timer) => timer())
  }
  rerender()
  return {
    window, player, add, censor, navigation, pushes, listeners, toasts, rerender, flushBack,
    cleanup: () => effects.forEach((effect) => effect.cleanup?.()),
  }
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

test('Native back from a tab ignores stale route history and returns home', async () => {
  const app = await mountBackHandler({ pathname: '/liked', idx: 8 })
  assert.equal(app.window.__boltHandleBack(), true)
  assert.equal(app.navigation[0][0], '/')
  assert.equal(app.navigation[0][1].replace, true)
  app.cleanup()
})

test('Native back on home minimizes even with older routes in history', async () => {
  const app = await mountBackHandler({ idx: 8 })
  assert.equal(app.window.__boltHandleBack(), false)
  assert.deepEqual(app.navigation, [])
  app.cleanup()
})

test('Cold restored artist returns to the tab that opened it', async () => {
  const app = await mountBackHandler({ pathname: '/artists/1', tab: '/liked' })
  assert.equal(app.window.__boltHandleBack(), true)
  assert.equal(app.navigation[0][0], '/liked')
  assert.equal(app.navigation[0][1].replace, true)
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
  app.window.history.back()
  app.flushBack()
  assert.equal(app.player.isFullScreen, false)
  app.cleanup()
})

for (const [platform, android, standalone] of [
  ['Android browser', true, false],
  ['iOS PWA', false, true],
]) {
  for (const pathname of ['/', '/search?q=test#results', '/liked', '/playlists', '/playlists/42', '/albums/1', '/artists/1', '/settings/playback']) {
    test(`${platform}: closing the player preserves ${pathname} and its history state`, async () => {
      const app = await mountBackHandler({ native: false, android, standalone, pathname })
      const originalUrl = app.window.location.href
      const originalState = structuredClone(app.window.history.state)
      app.player.isFullScreen = true
      app.rerender()
      app.player.closeFullScreen()
      app.rerender()
      app.flushBack()

      assert.deepEqual(app.navigation, ['history.back'])
      assert.equal(app.window.location.href, originalUrl)
      assert.deepEqual(structuredClone(app.window.history.state), originalState)
      assert.equal(app.player.isFullScreen, false)
      assert.equal(app.player.isPlaying, true)
      assert.deepEqual(app.toasts, [])
      app.cleanup()
    })
  }
}

for (const dialog of ['add', 'censor']) {
  test(`Closing the ${dialog} dialog leaves the fullscreen player open`, async () => {
    const app = await mountBackHandler({ native: false, pathname: '/search', fullscreen: true })
    if (dialog === 'add') app.add.request = { track: { id: 42 } }
    else app.censor.track = { id: 42 }
    app.rerender()
    app[dialog].close()
    app.rerender()
    app.flushBack()

    assert.equal(app.player.isFullScreen, true)
    assert.equal(app.window.history.state.__boltModal, 'fullscreen')
    assert.deepEqual(app.navigation, ['history.back'])

    // A real back gesture still closes the player without navigating away.
    app.window.history.back()
    app.flushBack()
    assert.equal(app.player.isFullScreen, false)
    assert.deepEqual(app.navigation, ['history.back', 'history.back'])
    app.cleanup()
  })
}

test('Closing and reopening the player does not consume the next real back gesture', async () => {
  const app = await mountBackHandler({ native: false, pathname: '/liked' })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    app.player.isFullScreen = true
    app.rerender()
    assert.equal(app.window.history.state.__boltModal, 'fullscreen')
    app.player.closeFullScreen()
    app.rerender()
    app.flushBack()
  }
  assert.deepEqual(app.navigation, ['history.back', 'history.back'])
  app.window.history.back()
  app.flushBack()
  assert.equal(app.navigation.at(-1)[0], '/')
  assert.equal(app.navigation.at(-1)[1].replace, true)
  app.cleanup()
})

function mountBridge() {
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
  return { window, navigator, messages }
}

test('Android bridge advertises native back and preserves next/previous commands', () => {
  const { window, navigator, messages } = mountBridge()
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

test('background settings open only on explicit request without changing playback', () => {
  const { window, navigator, messages } = mountBridge()
  assert.equal(typeof window.__boltOpenBackgroundPlaybackSettings, 'function')
  navigator.mediaSession.playbackState = 'playing'
  assert.equal(messages.some((message) => message.t === 'background-settings'), false)
  window.__boltOpenBackgroundPlaybackSettings()
  assert.deepEqual(messages.at(-1), { t: 'background-settings' })
  assert.equal(navigator.mediaSession.playbackState, 'playing')
})
