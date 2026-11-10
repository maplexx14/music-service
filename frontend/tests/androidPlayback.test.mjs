import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { transform } from 'esbuild'

const [playerSource, engineSource, recoverySource, androidSource, bridgeSource] = await Promise.all([
  readFile(new URL('../src/components/Player.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/services/audioEngine.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/services/playbackRecovery.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/services/androidApp.js', import.meta.url), 'utf8'),
  readFile(new URL('../../android/app/src/main/assets/bridge.js', import.meta.url), 'utf8'),
])
const { code } = await transform(playerSource, { loader: 'jsx', format: 'esm', target: 'es2020' })
const noop = () => {}

// Run the real Player effects, audio engine and APK bridge with controllable
// media events. UI imports are stubs; no browser or device is needed.
async function mountPlayer({ apk = true, ios = false, desktop = false, legacy = false, trackIds = [1, 2, 3, 4] } = {}) {
  let now = 0
  let dirty = true
  let hookIndex = 0
  const hooks = []
  const effects = []
  const subscribers = new Set()
  const messages = []
  const actions = new Map()
  const timers = new Map()
  let timerId = 0
  const schedule = (callback, delay) => {
    timers.set(++timerId, { callback, delay })
    return timerId
  }
  const eventTarget = (target = {}) => {
    const listeners = new Map()
    return Object.assign(target, {
      addEventListener(type, listener) {
        if (!listeners.has(type)) listeners.set(type, new Set())
        listeners.get(type).add(listener)
      },
      removeEventListener(type, listener) { listeners.get(type)?.delete(listener) },
      emit(type) { for (const listener of [...(listeners.get(type) || [])]) listener({ type }) },
    })
  }
  const window = eventTarget({
    location: { href: 'https://boltmusic.lat/', origin: 'https://boltmusic.lat' },
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    MediaMetadata: class { constructor(value) { Object.assign(this, value) } },
  })
  if (apk) window.BoltAndroid = { postMessage: (data) => messages.push(JSON.parse(data)) }
  const document = eventTarget({
    hidden: false,
    readyState: 'complete',
    documentElement: { classList: { contains: () => false } },
    createElement: () => ({}),
    head: { appendChild: noop },
    body: { appendChild: (element) => { element.isConnected = true } },
  })
  class Audio {
    constructor() {
      eventTarget(this)
      this.attributes = new Map()
      this.readyState = 0
      this.networkState = 0
      this.currentTime = 0
      this.duration = NaN
      this.paused = true
      this.ended = false
      this.playbackRate = 1
      this.volume = 1
      this.loadCalls = 0
      this.playCalls = 0
      this.buffered = { length: 0 }
      this.HAVE_METADATA = 1
      this.HAVE_CURRENT_DATA = 2
      this.HAVE_FUTURE_DATA = 3
      this.HAVE_ENOUGH_DATA = 4
      this.NETWORK_EMPTY = 0
      this.NETWORK_IDLE = 1
      this.NETWORK_LOADING = 2
      this.NETWORK_NO_SOURCE = 3
    }
    get src() { return this.source || '' }
    set src(value) {
      this.source = new URL(value, window.location.href).href
      this.resetLoad()
    }
    resetLoad() {
      this.readyState = 0
      this.currentTime = 0
      this.duration = NaN
      this.paused = true
      this.ended = false
      this.networkState = this.src ? 2 : 0
      this.emit('emptied')
      this.emit('loadstart')
    }
    load() { this.loadCalls += 1; this.resetLoad() }
    play() {
      this.playCalls += 1
      const wasPaused = this.paused
      this.paused = false
      if (wasPaused && this.readyState >= 2) this.emit('playing')
      return Promise.resolve()
    }
    pause() {
      if (this.paused) return
      this.paused = true
      this.emit('pause')
    }
    setAttribute(name, value) { this.attributes.set(name, value) }
    removeAttribute(name) {
      this.attributes.delete(name)
      if (name === 'src') this.source = ''
    }
    start() {
      this.readyState = 4
      this.duration = 180
      this.currentTime = 1
      this.paused = false
      this.emit('playing')
    }
    end() {
      this.currentTime = 180
      this.paused = true
      this.ended = true
      this.emit('pause')
      this.emit('ended')
    }
  }
  const queue = trackIds.map((id) => ({ id, title: `Track ${id}`, duration: 180 }))
  const state = {
    currentTrack: queue[0], queue, isPlaying: true, volume: 1, duration: 180, currentTime: 0,
    likedTrackIds: [], dislikedTrackIds: [], pendingLikeKeys: [],
    getNextTrack: (offset = 1) => queue[queue.indexOf(state.currentTrack) + offset],
    getPrevTrack: () => queue[queue.indexOf(state.currentTrack) - 1],
    setCurrentTime: (currentTime) => update({ currentTime }),
    setDuration: (duration) => update({ duration }),
    fetchLikedTracks: async () => {}, fetchDislikedTracks: async () => {},
    prefetchNext: async () => {}, prefetchTracks: noop, extendFlowIfNeeded: noop, extendQueueIfNeeded: async () => false,
    canContinueWithFlow: () => false, extendPlaybackQueueIfNeeded: async () => false,
    nextTrack: () => update(state.getNextTrack() ? { currentTrack: state.getNextTrack() } : { isPlaying: false }),
    advanceBy: (offset) => update(state.getNextTrack(offset) ? { currentTrack: state.getNextTrack(offset) } : { isPlaying: false }),
    togglePlayPause: () => update({ isPlaying: !state.isPlaying }),
    recordPlayClick: noop,
    materializeCurrentTrack: async () => state.currentTrack,
  }
  function update(value) {
    if (!Object.keys(value).some((key) => !Object.is(state[key], value[key]))) return
    Object.assign(state, value)
    dirty = true
    for (const listener of subscribers) listener(state)
  }
  const store = Object.assign((selector) => selector(state), {
    getState: () => state, setState: update,
    subscribe: (listener) => { subscribers.add(listener); return () => subscribers.delete(listener) },
  })
  function useEffect(callback, dependencies) {
    const index = hookIndex++
    const previous = hooks[index]
    if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
      hooks[index] = { dependencies, cleanup: previous?.cleanup }
      effects.push(() => { hooks[index].cleanup?.(); hooks[index].cleanup = callback() })
    }
  }
  const react = {
    createElement: () => ({}), memo: (component) => component,
    useEffect, useLayoutEffect: useEffect,
    useRef: (current) => hooks[hookIndex++] ||= { current },
    useState(initial) {
      const index = hookIndex++
      const hook = hooks[index] ||= { value: typeof initial === 'function' ? initial() : initial }
      return [hook.value, (next) => {
        const value = typeof next === 'function' ? next(hook.value) : next
        if (!Object.is(value, hook.value)) { hook.value = value; dirty = true }
      }]
    },
  }
  const navigator = {
    onLine: true,
    userAgent: ios ? 'iPhone AppleWebKit/605.1 Safari/605.1' : desktop ? 'Windows NT 10.0 Chrome/130.0 Edg/130.0' : 'Android vivo Chrome/130.0 BoltAndroid/1.8',
    mediaSession: {
      setActionHandler: (action, handler) => actions.set(action, handler),
      setPositionState: noop,
    },
  }
  const context = vm.createContext({
    window, document, navigator, Audio, URL, Blob, console,
    performance: { now: () => now },
    Date: class extends Date { static now() { return now } },
    setTimeout: schedule, setInterval: schedule,
    clearTimeout: (id) => timers.delete(id), clearInterval: (id) => timers.delete(id),
  })
  vm.runInContext(bridgeSource, context)
  if (legacy) delete window.__boltSetPlaybackRequested
  const overrides = {
    react: { default: react, ...react },
    '../store/playerStore': { usePlayerStore: store },
    '../store/authStore': { useAuthStore: (selector) => selector({ user: null }) },
    '../hooks/useTrackCarousel': { useTrackCarousel: () => ({ handlers: {}, swipedRef: { current: false } }) },
    '../hooks/useLyrics': { useLyrics: () => ({ syncedLines: [], plainText: '' }) },
    '../utils/media': { resolveCoverUrl: () => '', preloadCover: async () => {} },
    '../utils/streamQuality': { withQuality: (url) => url, sameStream: (a, b) => a === b, isLowQuality: () => false },
    '../utils/playerDiag': { snapshotAudio: () => ({}), playWithDiag: (audio) => audio.play() },
    '../services/playerPersist': { takeRestorePosition: () => 0 },
    '../services/api': { default: { post: async () => ({ data: {} }) } },
    '../config': { API_URL: '/api', SERVER_URL: window.location.origin },
    '../assets/default-cover.webp': { default: '/cover.webp' },
  }
  const importNames = new Map()
  for (const match of code.matchAll(/import\s+([^;]+?)\s+from\s+["']([^"']+)["']/g)) {
    const bindings = match[1]
    const names = bindings.match(/\{([^}]+)\}/)?.[1].split(',').map((name) => name.trim().split(/\s+as\s+/)[0]) || []
    if (!bindings.trim().startsWith('{') && !bindings.trim().startsWith('*')) names.push('default')
    importNames.set(match[2], names.filter(Boolean))
  }
  const cached = new Map()
  async function link(name) {
    if (cached.has(name)) return cached.get(name)
    const source = name === '../services/audioEngine' ? engineSource : name === '../services/playbackRecovery' ? recoverySource : name === '../services/androidApp' ? androidSource : null
    const exports = Object.fromEntries((importNames.get(name) || []).map((key) => [key, noop]))
    Object.assign(exports, overrides[name])
    const module = source ? new vm.SourceTextModule(source, { context }) : new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
    }, { context })
    cached.set(name, module)
    if (source) await module.link(link)
    return module
  }
  const player = new vm.SourceTextModule(code, { context, initializeImportMeta: (meta) => { meta.env = {} } })
  await player.link(link)
  await player.evaluate()
  function flush() {
    let renders = 0
    while (dirty) {
      assert.ok(++renders < 20, 'Player effects did not settle')
      dirty = false
      hookIndex = 0
      player.namespace.default()
      for (const effect of effects.splice(0)) effect()
    }
  }
  flush()
  const engine = cached.get('../services/audioEngine').namespace
  return {
    state, messages, document, window, navigator, engine, actions, flush,
    elapse: (ms) => { now += ms },
    watchdog: () => {
      for (const timer of [...timers.values()]) if (timer.delay === 3000) timer.callback()
      flush()
    },
    cleanup: () => { for (const hook of hooks) hook?.cleanup?.() },
  }
}

function bufferTo(audio, end) {
  audio.buffered = { length: 1, start: () => 0, end: () => end }
}

test('desktop playback waits for thirty buffered seconds before competing with the current download', async () => {
  const app = await mountPlayer({ apk: false, desktop: true })
  const audio = app.engine.getActive()
  audio.start()
  bufferTo(audio, 9)
  audio.emit('timeupdate')
  assert.equal(app.engine.getIdle().src, '')
  audio.currentTime = 2
  bufferTo(audio, 32)
  audio.emit('timeupdate')
  assert.equal(app.engine.hasPrimedSrc('/api/tracks/2/stream'), true)
  app.cleanup()
})

test('a fully downloaded track can prime its successor immediately', async () => {
  const app = await mountPlayer({ apk: false, desktop: true })
  const audio = app.engine.getActive()
  audio.start()
  bufferTo(audio, 180)
  audio.emit('timeupdate')
  assert.equal(app.engine.hasPrimedSrc('/api/tracks/2/stream'), true)
  app.cleanup()
})

test('an early desktop skip loads the requested track immediately while speculative preload is deferred', async () => {
  const app = await mountPlayer({ apk: false, desktop: true })
  const audio = app.engine.getActive()
  audio.start()
  bufferTo(audio, 9)
  audio.emit('timeupdate')
  assert.equal(app.engine.getIdle().src, '')
  app.actions.get('nexttrack')()
  app.flush()
  assert.equal(app.state.currentTrack.id, 2)
  assert.equal(app.engine.getActive(), audio)
  assert.equal(audio.src, 'https://boltmusic.lat/api/tracks/2/stream')
  assert.equal(audio.paused, false)
  app.cleanup()
})

test('background playback still primes near the end when the current buffer is small', async () => {
  const app = await mountPlayer({ apk: false, ios: true })
  const audio = app.engine.getActive()
  app.document.hidden = true
  audio.start()
  audio.currentTime = 140
  bufferTo(audio, 145)
  audio.emit('timeupdate')
  assert.equal(app.engine.hasPrimedSrc('/api/tracks/2/stream'), true)
  app.cleanup()
})

test('repeat-one avoids downloading another track even with a full buffer', async () => {
  const app = await mountPlayer({ apk: false, desktop: true })
  const audio = app.engine.getActive()
  app.state.isRepeatOne = true
  audio.start()
  bufferTo(audio, 180)
  audio.emit('timeupdate')
  assert.equal(app.engine.getIdle().src, '')
  app.cleanup()
})

test('a primed background successor starts through the existing audio slot without another load', async () => {
  const app = await mountPlayer({ apk: false, ios: true })
  const audio = app.engine.getActive()
  audio.start()
  bufferTo(audio, 180)
  audio.emit('timeupdate')
  const next = app.engine.getIdle()
  next.readyState = next.HAVE_FUTURE_DATA
  const loads = next.loadCalls
  app.document.hidden = true
  app.actions.get('nexttrack')()
  app.flush()
  assert.equal(app.engine.getActive(), next)
  assert.equal(app.state.currentTrack.id, 2)
  assert.equal(next.loadCalls, loads)
  assert.ok(next.playCalls > 0)
  app.cleanup()
})

test('APK plays four cold tracks in the background and releases playback intent at the end', async () => {
  const app = await mountPlayer()
  app.document.hidden = true
  for (const id of [1, 2, 3, 4]) {
    const audio = app.engine.getActive()
    assert.equal(app.state.currentTrack.id, id)
    assert.equal(audio.src, `https://boltmusic.lat/api/tracks/${id}/stream`)
    audio.start()
    app.flush()
    audio.end()
    app.flush()
    if (id < 4) assert.equal(app.engine.getActive().paused, false)
  }
  assert.equal(app.state.isPlaying, false)
  assert.deepEqual(app.messages.filter((message) => message.t === 'requested').map((message) => message.v), [true, false])
  app.cleanup()
})

test('APK recovers a stalled background load without reopening the activity', async () => {
  const app = await mountPlayer()
  app.document.hidden = true
  const audio = app.engine.getActive()
  const previous = audio.loadCalls
  app.elapse(9000)
  audio.emit('stalled')
  assert.equal(audio.loadCalls, previous + 1)
  assert.equal(audio.paused, false)
  audio.start()
  assert.equal(app.window.__boltAndroid, true)
  app.cleanup()
})

test('an explicit pause reaches the native bridge before another React render', async () => {
  const app = await mountPlayer()
  app.document.hidden = true
  app.state.togglePlayPause()
  assert.equal(app.messages.filter((message) => message.t === 'requested').at(-1).v, false)
  app.flush()
  assert.equal(app.engine.getActive().paused, true)
  app.cleanup()
})

function stallMidTrack(app) {
  const audio = app.engine.getActive()
  audio.start()
  audio.currentTime = 42
  audio.emit('timeupdate')
  audio.readyState = audio.HAVE_CURRENT_DATA
  app.document.hidden = true
  return audio
}

test('APK reloads a stalled mid-track stream in the background and restores its position', async () => {
  const app = await mountPlayer()
  const audio = stallMidTrack(app)
  const loads = audio.loadCalls
  app.elapse(12000)
  app.watchdog()
  assert.equal(audio.loadCalls, loads + 1)
  assert.equal(audio.currentTime, 42)
  // Some decoders expose 0 until metadata arrives; the guarded restore wins.
  audio.currentTime = 0
  audio.readyState = audio.HAVE_METADATA
  audio.emit('loadedmetadata')
  assert.equal(audio.currentTime, 42)
  audio.readyState = audio.HAVE_ENOUGH_DATA
  audio.emit('canplay')
  audio.emit('playing')
  audio.currentTime = 46
  audio.emit('timeupdate')
  app.watchdog()
  assert.equal(audio.loadCalls, loads + 1)
  assert.equal(audio.paused, false)
  assert.equal(app.state.currentTrack.id, 1)
  app.cleanup()
})

test('healthy playback, arriving bytes, and a fresh seek do not reload the APK stream', async () => {
  const app = await mountPlayer()
  const audio = stallMidTrack(app)
  const loads = audio.loadCalls
  for (let i = 0; i < 30; i++) {
    app.elapse(3000)
    audio.currentTime += 3
    audio.emit('timeupdate')
    app.watchdog()
  }
  for (let i = 0; i < 10; i++) {
    app.elapse(3000)
    audio.emit('progress')
    app.watchdog()
  }
  app.elapse(9000)
  audio.seeking = true
  audio.emit('seeking')
  app.watchdog()
  assert.equal(audio.loadCalls, loads)
  app.cleanup()
})

test('APK waits while offline and recovers the same position when connectivity returns', async () => {
  const app = await mountPlayer()
  const audio = stallMidTrack(app)
  const loads = audio.loadCalls
  app.navigator.onLine = false
  app.elapse(60000)
  app.watchdog()
  assert.equal(audio.loadCalls, loads)
  app.navigator.onLine = true
  app.watchdog()
  assert.equal(audio.loadCalls, loads + 1)
  assert.equal(audio.currentTime, 42)
  app.cleanup()
})

test('mid-track recovery has bounded retries and startup recovery cannot bypass that limit', async () => {
  const app = await mountPlayer()
  const audio = stallMidTrack(app)
  const loads = audio.loadCalls
  app.elapse(12000)
  app.watchdog()
  audio.currentTime = 0
  app.elapse(9000)
  audio.emit('stalled')
  assert.equal(audio.loadCalls, loads + 1, 'stalled event must not overwrite the pending position')
  for (let i = 0; i < 10; i++) {
    app.elapse(30000)
    app.watchdog()
    audio.currentTime = 0
  }
  assert.equal(audio.loadCalls, loads + 3)
  app.cleanup()
})

for (const systemPause of [false, true]) {
  test(`${systemPause ? 'system' : 'explicit'} pause cancels recovery before React flush and late canplay`, async () => {
    const app = await mountPlayer()
    const audio = stallMidTrack(app)
    app.elapse(12000)
    app.watchdog()
    const plays = audio.playCalls
    if (systemPause) audio.pause()
    else app.state.togglePlayPause()
    audio.emit('loadedmetadata')
    audio.emit('canplay')
    app.flush()
    app.elapse(60000)
    app.watchdog()
    app.document.hidden = false
    app.document.emit('visibilitychange')
    assert.equal(app.state.isPlaying, false)
    assert.equal(audio.paused, true)
    assert.equal(audio.playCalls, plays)
    assert.equal(audio.currentTime, 42)
    app.cleanup()
  })
}

test('an OS pause during ordinary playback is not undone by canplay or foregrounding', async () => {
  const app = await mountPlayer()
  const audio = stallMidTrack(app)
  const plays = audio.playCalls
  audio.pause()
  audio.emit('canplay')
  app.document.hidden = false
  app.document.emit('visibilitychange')
  app.elapse(60000)
  app.watchdog()
  assert.equal(audio.paused, true)
  assert.equal(audio.playCalls, plays)
  assert.equal(app.state.isPlaying, false)
  app.cleanup()
})

test('an OS pause before recovered metadata arrives cancels playback even at position zero', async () => {
  const app = await mountPlayer()
  const audio = stallMidTrack(app)
  app.elapse(12000)
  app.watchdog()
  audio.currentTime = 0
  const plays = audio.playCalls
  audio.pause()
  audio.emit('loadedmetadata')
  audio.emit('canplay')
  app.watchdog()
  assert.equal(app.state.isPlaying, false)
  assert.equal(audio.paused, true)
  assert.equal(audio.playCalls, plays)
  app.cleanup()
})

test('changing tracks invalidates a pending position restore even before React flush', async () => {
  const app = await mountPlayer()
  const audio = stallMidTrack(app)
  app.elapse(12000)
  app.watchdog()
  app.window.__boltMediaAction('nexttrack')
  audio.emit('loadedmetadata')
  app.flush()
  assert.equal(app.state.currentTrack.id, 2)
  assert.equal(app.engine.getActive().currentTime, 0)
  app.cleanup()
})

test('unmount cancels a pending position restore', async () => {
  const app = await mountPlayer()
  const audio = stallMidTrack(app)
  app.elapse(12000)
  app.watchdog()
  app.cleanup()
  audio.currentTime = 0
  audio.emit('loadedmetadata')
  assert.equal(audio.currentTime, 0)
})

for (const options of [{ apk: false }, { apk: false, ios: true }]) {
  test(`mid-track APK recovery does not reload ${options.ios ? 'iOS' : 'Android browser'} audio`, async () => {
    const app = await mountPlayer(options)
    const audio = stallMidTrack(app)
    const loads = audio.loadCalls
    app.elapse(60000)
    app.watchdog()
    assert.equal(audio.loadCalls, loads)
    app.cleanup()
  })
}

test('system Play records one intent before touching audio, including a failed start', async () => {
  const app = await mountPlayer()
  const clicks = []
  const audio = app.engine.getActive()
  app.state.isPlaying = false
  app.state.recordPlayClick = (action, metadata) => clicks.push({ action, metadata, playCalls: audio.playCalls })
  const before = audio.playCalls
  audio.play = () => { throw new Error('unavailable audio') }
  try {
    assert.equal(app.window.__boltMediaAction('play'), true)
    await Promise.resolve()
    assert.equal(clicks.length, 1)
    assert.equal(clicks[0].action, 'resume')
    assert.equal(clicks[0].metadata.via, 'media_session')
    assert.equal(clicks[0].metadata.track.id, app.state.currentTrack.id)
    assert.equal(clicks[0].playCalls, before)
  } finally {
    app.cleanup()
  }
})

for (const ios of [false, true]) {
  test(`${ios ? 'iOS' : 'Android browser'} retains deferred background starts`, async () => {
    const app = await mountPlayer({ apk: false, ios })
    app.document.hidden = true
    app.engine.getActive().start()
    app.flush()
    app.engine.getActive().end()
    app.flush()
    assert.equal(app.state.currentTrack.id, 1)
    assert.equal(app.engine.getActive().paused, true)
    app.cleanup()
  })
}

test('older APK bridges can still start a cold track in the background', async () => {
  const app = await mountPlayer({ legacy: true })
  app.document.hidden = true
  app.engine.getActive().start()
  app.flush()
  app.engine.getActive().end()
  app.flush()
  assert.equal(app.state.currentTrack.id, 2)
  assert.equal(app.engine.getActive().paused, false)
  assert.equal(app.messages.some((message) => message.t === 'requested'), false)
  app.cleanup()
})

function pendingFlow(app) {
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  app.state.canContinueWithFlow = () => true
  app.state.extendPlaybackQueueIfNeeded = () => pending
  return () => {
    app.state.queue.push({ id: 100, title: 'Flow', duration: 180 })
    finish(true)
  }
}

for (const platform of ['desktop', 'APK', 'iOS']) {
  test(`${platform} starts flow after the last collection track while its recommendations are loading`, async () => {
    const app = await mountPlayer({ apk: platform === 'APK', ios: platform === 'iOS', desktop: platform === 'desktop', trackIds: [1] })
    const finish = pendingFlow(app)
    app.document.hidden = platform !== 'desktop'
    app.engine.getActive().start()
    app.flush()
    app.engine.getActive().end()
    app.flush()
    assert.equal(app.state.currentTrack.id, 1)
    assert.equal(app.state.isPlaying, true)
    finish()
    await new Promise(resolve => setImmediate(resolve))
    if (platform === 'iOS') {
      // The existing background handoff waits for real audio readiness.
      assert.equal(app.state.currentTrack.id, 1)
      assert.equal(app.engine.hasPrimedSrc('/api/tracks/100/stream'), true)
      const next = app.engine.getIdle()
      next.readyState = next.HAVE_FUTURE_DATA
      next.emit('canplay')
    }
    app.flush()
    assert.equal(app.state.currentTrack.id, 100)
    assert.equal(app.state.isPlaying, true)
    assert.equal(app.engine.getActive().paused, false)
    assert.equal(app.engine.getActive().src, 'https://boltmusic.lat/api/tracks/100/stream')
    app.cleanup()
  })
}

for (const system of [false, true]) {
  test(`pausing via ${system ? 'system controls' : 'the player'} while flow loads cancels the automatic transition`, async () => {
    const app = await mountPlayer({ trackIds: [1] })
    const finish = pendingFlow(app)
    app.engine.getActive().start()
    app.flush()
    app.engine.getActive().end()
    if (system) assert.equal(app.window.__boltMediaAction('pause'), true)
    else app.state.togglePlayPause()
    finish()
    await new Promise(resolve => setImmediate(resolve))
    app.flush()
    assert.equal(app.state.currentTrack.id, 1)
    assert.equal(app.state.isPlaying, false)
    assert.equal(app.engine.getActive().paused, true)
    app.cleanup()
  })
}

test('a new collection with the same current track cancels the old automatic transition', async () => {
  const app = await mountPlayer({ trackIds: [1] })
  const finish = pendingFlow(app)
  app.engine.getActive().start()
  app.flush()
  app.engine.getActive().end()
  app.state.playContext = { kind: 'album', title: 'Another album' }
  finish()
  await new Promise(resolve => setImmediate(resolve))
  app.flush()
  assert.equal(app.state.currentTrack.id, 1)
  assert.equal(app.engine.getActive().src, 'https://boltmusic.lat/api/tracks/1/stream')
  app.cleanup()
})

test('repeat-one replays the final collection track instead of starting its prepared flow', async () => {
  const app = await mountPlayer({ trackIds: [1, 100] })
  app.state.isRepeatOne = true
  app.engine.getActive().start()
  app.flush()
  app.engine.getActive().end()
  app.flush()
  assert.equal(app.state.currentTrack.id, 1)
  assert.equal(app.state.isPlaying, true)
  assert.equal(app.engine.getActive().currentTime, 0)
  assert.equal(app.engine.getActive().paused, false)
  app.cleanup()
})

test('no available flow stops the finished collection instead of leaving a silent playing state', async () => {
  const app = await mountPlayer({ trackIds: [1] })
  app.state.canContinueWithFlow = () => true
  app.engine.getActive().start()
  app.flush()
  app.engine.getActive().end()
  await new Promise(resolve => setImmediate(resolve))
  app.flush()
  assert.equal(app.state.isPlaying, false)
  assert.equal(app.state.currentTrack.id, 1)
  app.cleanup()
})
