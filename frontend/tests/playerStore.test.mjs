import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { transform } from 'esbuild'
import { create } from 'zustand'
import * as queueUtils from '../src/utils/playerQueue.js'
import { playbackLabel } from '../src/utils/playbackLabel.js'

const source = await readFile(new URL('../src/store/playerStore.js', import.meta.url), 'utf8')
// Use ordinary scripts, as in uiSession.test.mjs: Node 20's experimental VM
// module loader can segfault when fresh store contexts are garbage-collected.
const { code } = await transform(source, {
  format: 'cjs', loader: 'js', target: 'es2020',
  define: { 'import.meta.env.VITE_BUILD_TIME': JSON.stringify('test-build') },
})
const storeScript = new vm.Script(`(function (module, exports, require) {\n${code}\n})`, {
  filename: 'playerStore.js',
})
const { code: persistCode } = await transform(await readFile(new URL('../src/services/playerPersist.js', import.meta.url), 'utf8'), {
  format: 'cjs', loader: 'js', target: 'es2020',
})
const persistScript = new vm.Script(`(function (module, exports, require) {\n${persistCode}\n})`, {
  filename: 'playerPersist.js',
})
const noop = () => {}
const track = (id, artist = 'Favorite', protectedArtist = true) => ({
  id: `ytmusic:${id}`, source: 'ytmusic', external_id: id, artist, title: id,
  recommendation_surface: 'flow', recommendation_protected_artist: protectedArtist,
  recommendation_track_key: `${artist.toLowerCase()}|${id}`,
})

async function mountStore(apiOverrides = {}, globals = {}) {
  const api = {
    get: async () => ({ data: [] }), post: async () => ({ data: {} }), delete: async () => ({}),
    ...apiOverrides,
  }
  const context = vm.createContext({ console, performance, Date, setTimeout, clearTimeout, ...globals })
  const imports = {
    zustand: { create }, '../services/api': { default: api },
    '../services/pageCache': { invalidateCache: noop, patchCache: noop, peekCache: noop, LIKED_CACHE_KEY: 'liked' },
    '../utils/playerQueue': queueUtils,
  }
  const module = { exports: {} }
  storeScript.runInContext(context)(module, module.exports, (name) => {
    assert.ok(Object.hasOwn(imports, name), `Unmocked import: ${name}`)
    return { __esModule: true, ...imports[name] }
  })
  return module.exports.usePlayerStore
}

function setQueue(store, queue, extra = {}) {
  store.setState({ queue, currentTrack: queue[0], currentIndex: 0, isPlaying: true,
    shuffledOrder: queue.map((_, i) => i), currentShuffleIndex: -1,
    flowActive: true, ...extra })
}

function mountPersistence(store, storage = new Map()) {
  const listeners = new Map()
  const document = { hidden: false, addEventListener: (name, handler) => listeners.set(name, handler) }
  const context = vm.createContext({
    console, performance, Date, setTimeout: noop, clearTimeout: noop,
    document, window: { addEventListener: noop },
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
  })
  const imports = {
    './api': { default: { get: async () => ({ data: null }), put: async () => ({}), delete: async () => ({}) } },
    '../store/playerStore': { usePlayerStore: store },
    '../store/uiSettingsStore': { useUiSettingsStore: { getState: () => ({ rememberPlayer: true }), subscribe: noop } },
    '../utils/frameMeter': { noteSpan: noop },
  }
  const module = { exports: {} }
  persistScript.runInContext(context)(module, module.exports, (name) => {
    assert.ok(Object.hasOwn(imports, name), `Unmocked persistence import: ${name}`)
    return { __esModule: true, ...imports[name] }
  })
  return { ...module.exports, storage, hide: () => { document.hidden = true; listeners.get('visibilitychange')() } }
}

test('a protected artist survives two distinct skipped songs; duplicate events count once', async () => {
  const store = await mountStore()
  const queue = [track('a'), track('b'), track('c'), track('other', 'Other'), track('d'), track('e')]
  setQueue(store, queue)
  const signal = (row) => store.getState()._noteFlowSignal(row, 's')
  signal(queue[0])
  signal({ ...queue[0], id: 77, db_id: 77 })
  signal({ ...queue[0], source: 'soundcloud', id: 'soundcloud:alias', external_id: 'alias' })
  signal(queue[1])
  assert.equal(store.getState().queue.length, 6)
  signal(queue[2])
  assert.equal(store.getState().queue.length, 3)
  assert.equal(store.getState().queue.at(-1).artist, 'Other')
})

test('dislike blocks queued aliases before materialization; next, preview and advance agree', async () => {
  const store = await mountStore()
  const disliked = track('bad')
  const queue = [disliked, { ...disliked, id: 90, db_id: 90 }, track('good'), track('bad'), track('last')]
  setQueue(store, queue, { flowActive: false })
  store.getState().markTrackDisliked(disliked)
  assert.equal(store.getState().getNextTrack().title, 'good')
  store.getState().advanceBy(2, 'ended')
  assert.equal(store.getState().currentTrack.title, 'last')
  store.getState().previousTrack()
  assert.equal(store.getState().currentTrack.title, 'good')
  store.getState().nextTrack('ended')
  assert.equal(store.getState().currentTrack.title, 'last')
})

test('shuffle navigation excludes dislikes and undo or like restores all aliases', async () => {
  const store = await mountStore()
  const bad = { ...track('bad'), db_id: 90 }
  const queue = [track('start'), bad, track('good')]
  setQueue(store, queue, { isShuffle: true, currentShuffleIndex: 0 })
  await store.getState().toggleTrackDislike(90, bad)
  assert.equal(store.getState().getNextTrack().title, 'good')
  store.getState().nextTrack('ended')
  assert.equal(store.getState().currentShuffleIndex, 2)
  await store.getState().toggleTrackDislike(90, bad)
  assert.equal(store.getState().getPrevTrack().title, 'bad')
  await store.getState().toggleTrackDislike(90, bad)
  await store.getState().toggleTrackLike(90, bad)
  assert.equal(store.getState().getPrevTrack().title, 'bad')
})

test('three fast skips trigger a rescue request', async () => {
  let requests = 0
  const store = await mountStore({ get: async (url, config) => {
    assert.equal(url, '/recommendations/flow')
    assert.equal(config.params.rescue, 1)
    requests += 1
    return { data: [] }
  } })
  const queue = [track('a'), track('b'), track('c')]
  setQueue(store, queue)
  for (const row of queue) store.getState()._noteFlowSignal(row, 's', { fast: true })
  assert.equal(requests, 1)
  await Promise.resolve()
})

test('loading dislikes preserves a concurrent immediate dislike', async () => {
  let resolveIds, resolveKeys
  const store = await mountStore({ get: (url) => new Promise((resolve) => {
    if (url.endsWith('/ids')) resolveIds = resolve
    else resolveKeys = resolve
  }) })
  const loading = store.getState().fetchDislikedTracks()
  store.getState().markTrackDisliked(track('during-fetch'))
  resolveIds({ data: [90] })
  resolveKeys({ data: ['local:90', 'ytmusic:old'] })
  await loading
  assert.ok(store.getState().dislikedTrackKeys.includes('ytmusic:during-fetch'))
  assert.ok(store.getState().dislikedTrackKeys.includes('ytmusic:old'))
})

const clickUrl = '/users/me/play-click'
const localTracks = () => [{ id: 1, title: 'First' }, { id: 2, title: 'Second' }]

test('a track click without recommendation attribution is recorded before playback changes', async () => {
  const clicks = []
  const store = await mountStore({ get: async () => ({ data: { ready: true } }), post: async (url, body, config) => {
    if (url === clickUrl) clicks.push({ body, config, currentTrack: store.getState().currentTrack })
    return { data: { ready: true } }
  } }, { window: { location: { pathname: '/search', search: '?token=never-log-this' } } })
  const selected = track('external')
  store.getState().playTrack(selected, [selected], 'external')
  assert.equal(clicks.length, 1)
  assert.equal(clicks[0].currentTrack, null)
  assert.equal(clicks[0].body.action, 'track')
  assert.equal(clicks[0].body.track_id, 'ytmusic:external')
  assert.equal(clicks[0].body.external_id, 'external')
  assert.equal(clicks[0].body.path, '/search')
  assert.equal(JSON.stringify(clicks[0].body).includes('never-log-this'), false)
  assert.equal(clicks[0].body.build, 'test-build')
  assert.equal(clicks[0].config.skipErrorToast, true)
  assert.equal(clicks[0].config.skipAuthRedirect, true)
  assert.equal(store.getState().isPlaying, true)
})

test('a flow click is recorded while recommendations are pending and survives their failure', async () => {
  const calls = []
  let rejectFlow
  const store = await mountStore({
    post: async (url, body) => { if (url === clickUrl) calls.push(body); return { data: {} } },
    get: () => new Promise((_resolve, reject) => { rejectFlow = reject }),
  })
  const starting = store.getState().startFlow()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].action, 'flow')
  assert.equal(calls[0].track_id, undefined)
  assert.equal(store.getState().currentTrack, null)
  const failed = assert.rejects(starting, /provider unavailable/)
  rejectFlow(new Error('provider unavailable'))
  await failed
  assert.equal(calls.length, 1)
  assert.equal(store.getState().flowLoading, false)
})

for (const preload of [false, true]) {
  test(`flow ${preload ? 'with preload' : 'without preload'} records one click and autoplay records none`, async () => {
    const clicks = []
    const store = await mountStore({
      get: async () => ({ data: localTracks() }),
      post: async (url, body) => { if (url === clickUrl) clicks.push(body); return { data: {} } },
    })
    if (preload) {
      store.getState().preloadFlow()
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(clicks.length, 0)
    }
    assert.equal(await store.getState().startFlow(), true)
    assert.equal(clicks.length, 1)
    assert.equal(clicks[0].action, 'flow')
    store.getState().nextTrack('ended')
    assert.equal(store.getState().currentTrack.id, 2)
    assert.equal(clicks.length, 1)
  })
}

test('flow starts with the visible batch even after its TTL and a background replacement', async () => {
  const requests = []
  const store = await mountStore({ get: async (url) => { requests.push(url); return { data: [] } } })
  store.setState({ prefetchTracks: noop })
  const shown = [track('shown-first'), track('shown-second'), track('shown-third')]
  const preview = { tracks: shown, ts: Date.now() - 6 * 60 * 1000 }
  store.getState().pinFlowPreview(preview)
  store.getState()._markPrefetchResolved('yt:shown-second')
  store.setState({ flowPreload: { tracks: [track('replacement')], ts: Date.now() } })
  assert.equal(await store.getState().startFlow(), true)
  assert.equal(store.getState().currentTrack.id, shown[0].id)
  assert.deepEqual(store.getState().queue.map(row => row.id), shown.map(row => row.id))
  assert.equal(store.getState().flowActive, true)
  assert.equal(store.getState().flowPreview, null)
  assert.equal(store.getState().flowPreload, null)
  assert.deepEqual(requests, [])
})

test('a visible flow preview preserves the next two discs when shuffle is enabled', async () => {
  const store = await mountStore()
  const shown = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, title: `Track ${i}` }))
  store.setState({ isShuffle: true })
  store.getState().pinFlowPreview({ tracks: shown, ts: Date.now() })
  assert.equal(await store.getState().startFlow(), true)
  assert.equal(store.getState().currentTrack.id, 1)
  assert.equal(store.getState().getNextTrack(1).id, 2)
  assert.equal(store.getState().getNextTrack(2).id, 3)
  assert.equal(store.getState().isShuffle, true)
  assert.equal(new Set(store.getState().shuffledOrder).size, shown.length)
  assert.deepEqual(Array.from(store.getState().shuffledOrder.slice(3)).sort(), [3, 4, 5, 6, 7])
})

test('starting a visible preview does not wait for an unrelated refresh in flight', async () => {
  let finishRefresh
  const store = await mountStore({ get: () => new Promise(resolve => { finishRefresh = resolve }) })
  store.setState({ prefetchTracks: noop })
  store.getState().pinFlowPreview({ tracks: localTracks(), ts: Date.now() - 6 * 60 * 1000 })
  store.getState().preloadFlow()
  const starting = store.getState().startFlow()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(store.getState().currentTrack?.id, 1)
  finishRefresh({ data: [{ id: 99, title: 'Refreshed' }] })
  assert.equal(await starting, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(store.getState().currentTrack.id, 1)
})

test('changing preferences invalidates the displayed flow before a new start', async () => {
  const store = await mountStore({ get: async () => ({ data: [{ id: 99, title: 'New flow' }] }) })
  store.getState().pinFlowPreview({ tracks: localTracks(), ts: Date.now() })
  store.getState().markTrackDisliked(localTracks()[0])
  assert.equal(store.getState().flowPreview, null)
  assert.equal(await store.getState().startFlow(), true)
  assert.equal(store.getState().currentTrack.id, 99)
})

test('an unseen flow can still choose the already resolved first playable track', async () => {
  const store = await mountStore()
  store.setState({ prefetchTracks: noop })
  const batch = [track('cold'), track('ready')]
  store.setState({ flowPreload: { tracks: batch, ts: Date.now() } })
  store.getState()._markPrefetchResolved('yt:ready')
  assert.equal(await store.getState().startFlow(), true)
  assert.equal(store.getState().currentTrack.id, batch[1].id)
})

test('playing another queue clears a displayed flow and cannot pin one over playback', async () => {
  const store = await mountStore()
  const preview = { tracks: localTracks(), ts: Date.now() }
  store.getState().pinFlowPreview(preview)
  store.getState().playTrack({ id: 99, title: 'Selected track' })
  assert.equal(store.getState().flowPreview, null)
  store.getState().pinFlowPreview(preview)
  assert.equal(store.getState().flowPreview, null)
})

test('shuffle records the click before fetching a playlist and does not double count its start', async () => {
  const clicks = []
  let finishFetch
  const store = await mountStore({
    post: async (url, body) => { if (url === clickUrl) clicks.push(body); return { data: {} } },
    get: () => new Promise(resolve => { finishFetch = resolve }),
  })
  const starting = store.getState().shufflePlaylist(localTracks(), 'album', { url: '/albums/test', total: 3 })
  assert.equal(clicks.length, 1)
  assert.equal(clicks[0].action, 'shuffle')
  assert.equal(store.getState().currentTrack, null)
  finishFetch({ data: { tracks: [...localTracks(), { id: 3, title: 'Third' }] } })
  await starting
  assert.equal(clicks.length, 1)
  assert.equal(store.getState().isPlaying, true)
})

test('playlist selection and an explicit resume are clicks; pause and internal sync are not', async () => {
  const clicks = []
  const store = await mountStore({ post: async (url, body) => {
    if (url === clickUrl) clicks.push(body)
    return { data: {} }
  } })
  store.getState().playPlaylist(localTracks(), 1, 'album')
  store.getState().togglePlayPause('mini_player') // Pause.
  store.getState().setCurrentTime(12.5)
  store.getState().togglePlayPause('mini_player') // Explicit resume.
  store.getState().togglePlayPause() // Internal state sync.
  store.getState().togglePlayPause()
  assert.deepEqual(clicks.map(click => click.action), ['playlist', 'resume'])
  assert.equal(clicks[0].track_id, '2')
  assert.equal(clicks[1].position, 12.5)
  assert.equal(clicks[1].via, 'mini_player')
})

for (const synchronous of [false, true]) {
  test(`a ${synchronous ? 'synchronous' : 'rejected'} telemetry failure never prevents playback`, async () => {
    const store = await mountStore({ post: (url) => {
      if (url === clickUrl) {
        if (synchronous) throw new Error('offline')
        return Promise.reject(new Error('offline'))
      }
      return Promise.resolve({ data: {} })
    } })
    store.getState().playTrack(localTracks()[0])
    await Promise.resolve()
    assert.equal(store.getState().isPlaying, true)
    assert.equal(store.getState().currentTrack.id, 1)
  })
}

for (const scenario of [
  { source: 'flow', path: '/', label: 'поток' },
  { source: null, path: '/liked', context: { kind: 'liked', title: 'Понравившиеся' }, label: 'Понравившиеся' },
  { source: null, path: '/playlists/42', context: { kind: 'playlist', title: 'Вечерний плейлист' }, label: 'Вечерний плейлист' },
  { source: 'artist', path: '/artists/Muse', context: { title: 'Muse' }, label: 'Muse' },
  { source: 'album', path: '/albums/deezer/42', context: { title: 'Название альбома' }, label: 'Название альбома' },
  { source: 'external', path: '/external/soundcloud/playlists/42', context: { kind: 'playlist', title: 'SoundCloud mix' }, label: 'SoundCloud mix' },
  { source: 'external', path: '/link', context: { kind: 'playlist', title: 'Spotify mix' }, label: 'Spotify mix' },
]) {
  test(`playback label stays ${scenario.label} through track changes, navigation and pause`, async () => {
    const location = { pathname: scenario.path }
    const store = await mountStore({}, { window: { location } })
    const tracks = [{ id: 1, artist: 'First Artist' }, { id: 2, artist: 'Other Artist' }]
    store.getState().playPlaylist(tracks, 0, scenario.source, null, { context: scenario.context })
    assert.equal(playbackLabel(store.getState()), scenario.label)
    location.pathname = '/search'
    store.getState().nextTrack('ended')
    assert.equal(store.getState().currentTrack.artist, 'Other Artist')
    assert.equal(playbackLabel(store.getState()), scenario.label)
    store.getState().togglePlayPause()
    assert.equal(store.getState().isPlaying, false)
    assert.equal(playbackLabel(store.getState()), scenario.label)
    const saved = JSON.parse(JSON.stringify({ currentTrack: store.getState().currentTrack, playContext: store.getState().playContext, source: store.getState().source }))
    assert.equal(playbackLabel(saved), scenario.label)
  })
}

test('shuffle captures the playlist name and originating page before awaiting more tracks', async () => {
  let finishFetch
  const location = { pathname: '/playlists/42' }
  const store = await mountStore({ get: () => new Promise(resolve => { finishFetch = resolve }) }, { window: { location } })
  const starting = store.getState().shufflePlaylist(localTracks(), null, { url: '/playlists/42', total: 3 }, {
    context: { kind: 'playlist', title: 'Original Playlist' },
  })
  location.pathname = '/artists/Another'
  finishFetch({ data: { tracks: [...localTracks(), { id: 3, artist: 'Other Artist' }] } })
  await starting
  assert.equal(store.getState().playContext.path, '/playlists/42')
  assert.equal(playbackLabel(store.getState()), 'Original Playlist')
})

test('legacy contexts identify flow, liked and encoded artist pages without using the song artist', () => {
  const currentTrack = { artist: 'Different Artist' }
  assert.equal(playbackLabel({ currentTrack, source: 'flow' }), 'поток')
  assert.equal(playbackLabel({ currentTrack, playContext: { path: '/liked' } }), 'Понравившиеся')
  assert.equal(playbackLabel({ currentTrack, playContext: { path: `/artists/${encodeURIComponent('Король и Шут')}` } }), 'Король и Шут')
  assert.equal(playbackLabel({ currentTrack, playContext: { path: '/artists/%E0' } }), '%E0')
  assert.equal(playbackLabel({ currentTrack, playContext: { path: '/search' } }), 'Поиск')
  assert.equal(playbackLabel({ currentTrack: null, playContext: { title: 'Previous Playlist' } }), 'поток')
})

const flowTracks = (start = 100) => Array.from({ length: 6 }, (_, i) => ({ id: start + i, title: `Flow ${start + i}` }))

for (const scenario of [
  { source: 'album', context: { title: 'Album' } },
  { source: null, context: { kind: 'playlist', title: 'Playlist' } },
  { source: null, context: { kind: 'liked', title: 'Понравившиеся' } },
  { source: 'external', context: { kind: 'playlist', title: 'Imported playlist' } },
  { source: 'external', context: { kind: 'album', title: 'Imported album' } },
  { source: null, context: { path: '/liked' } },
]) {
  test(`${scenario.context.title || scenario.context.path} continues into flow after its last track without recording another click`, async () => {
    const clicks = []
    const store = await mountStore({
      get: async (url, config) => {
        assert.equal(url, '/recommendations/flow')
        assert.equal(config.params.preload, 1)
        assert.equal(config.params.exclude, '1,2')
        return { data: flowTracks() }
      },
      post: async (url, body) => { if (url === clickUrl) clicks.push(body); return { data: {} } },
    })
    store.getState().playPlaylist(localTracks(), 0, scenario.source, null, { context: scenario.context })
    const label = playbackLabel(store.getState())
    assert.equal(await store.getState().extendPlaybackQueueIfNeeded(), true)
    assert.equal(store.getState().currentTrack.id, 1)
    assert.equal(store.getState().flowActive, false)
    assert.equal(playbackLabel(store.getState()), label)
    store.getState().nextTrack('ended')
    assert.equal(store.getState().currentTrack.id, 2)
    assert.equal(store.getState().flowActive, false)
    store.getState().nextTrack('ended')
    assert.equal(store.getState().currentTrack.id, 100)
    assert.equal(store.getState().isPlaying, true)
    assert.equal(store.getState().flowActive, true)
    assert.equal(store.getState().source, 'flow')
    assert.equal(playbackLabel(store.getState()), 'поток')
    assert.equal(store.getState().flowStartIndex, null)
    assert.deepEqual(clicks.map(({ action }) => action), ['playlist'])
  })
}

test('flow preparation stays near the end and the resulting flow keeps replenishing', async () => {
  const requests = []
  const store = await mountStore({ get: async (_url, config) => {
    requests.push(config.params)
    return { data: flowTracks(requests.length * 100) }
  } })
  const album = Array.from({ length: 7 }, (_, i) => ({ id: i + 1 }))
  store.getState().playPlaylist(album, 0, 'album')
  assert.equal(await store.getState().extendPlaybackQueueIfNeeded(), false)
  assert.equal(requests.length, 0)
  store.getState().advanceBy(3, 'ended')
  await store.getState().extendPlaybackQueueIfNeeded()
  assert.equal(requests.length, 1)
  store.getState().advanceBy(4, 'ended')
  assert.equal(store.getState().currentTrack.id, 100)
  assert.equal(store.getState().flowActive, true)
  store.getState().advanceBy(3, 'ended')
  await store.getState().extendPlaybackQueueIfNeeded()
  assert.equal(requests.length, 2)
  assert.equal(requests[1].preload, undefined)
  store.getState().advanceBy(3, 'ended')
  assert.equal(store.getState().currentTrack.id, 200)
})

for (const shuffleBeforePreload of [false, true]) {
  test(`flow stays after the collection when shuffle is enabled ${shuffleBeforePreload ? 'before' : 'after'} preload`, async () => {
    const store = await mountStore({ get: async () => ({ data: flowTracks() }) })
    const album = [{ id: 1 }, { id: 2 }, { id: 3 }]
    if (shuffleBeforePreload) await store.getState().shufflePlaylist(album, 'album')
    else store.getState().playPlaylist(album, 0, 'album')
    await store.getState().extendPlaybackQueueIfNeeded()
    if (!shuffleBeforePreload) store.getState().toggleShuffle()
    assert.ok(store.getState().shuffledOrder.slice(0, 3).every(index => index < 3))
    assert.ok(store.getState().shuffledOrder.slice(3).every(index => index >= 3))
    while (store.getState().currentShuffleIndex < 2) {
      store.getState().nextTrack('ended')
      assert.equal(store.getState().flowActive, false)
      assert.ok(store.getState().currentTrack.id < 100)
    }
    store.getState().nextTrack('ended')
    assert.equal(store.getState().flowActive, true)
    assert.ok(store.getState().currentTrack.id >= 100)
  })
}

test('liked songs finish loading their pages before flow is appended', async () => {
  const requests = []
  const store = await mountStore({ get: async (url, config) => {
    requests.push(url)
    if (url === '/recommendations/flow') return { data: flowTracks() }
    return { data: { tracks: [{ id: config.params.skip + 1 }] }, headers: { 'x-total-count': '3' } }
  } })
  store.getState().playPlaylist([{ id: 1 }], 0, null, { url: '/playlists/me/liked', total: 3 }, {
    context: { kind: 'liked' },
  })
  await store.getState().extendPlaybackQueueIfNeeded(true)
  assert.deepEqual(requests, ['/playlists/me/liked'])
  store.getState().nextTrack('ended')
  assert.equal(store.getState().currentTrack.id, 2)
  await store.getState().extendPlaybackQueueIfNeeded()
  assert.deepEqual(requests, ['/playlists/me/liked', '/playlists/me/liked', '/recommendations/flow'])
  store.getState().nextTrack('ended')
  assert.equal(store.getState().currentTrack.id, 3)
  assert.equal(store.getState().flowActive, false)
  store.getState().nextTrack('ended')
  assert.equal(store.getState().currentTrack.id, 100)
  assert.equal(store.getState().flowActive, true)
})

test('a playable last page does not wait for the flow request to finish', async () => {
  let finishFlow
  const store = await mountStore({ get: (url) => url === '/recommendations/flow'
    ? new Promise(resolve => { finishFlow = resolve })
    : Promise.resolve({ data: { tracks: [{ id: 2 }] }, headers: { 'x-total-count': '2' } }),
  })
  store.getState().playPlaylist([{ id: 1 }], 0, null, { url: '/playlists/1', total: 2 }, { context: { kind: 'playlist' } })
  assert.equal(await store.getState().extendPlaybackQueueIfNeeded(true), true)
  store.getState().nextTrack('ended')
  assert.equal(store.getState().currentTrack.id, 2)
  const pending = store.getState().extendPlaybackQueueIfNeeded(true)
  finishFlow({ data: flowTracks() })
  assert.equal(await pending, true)
})

test('empty cursor pages and disliked tracks cannot make an unfinished imported playlist start flow', async () => {
  const pages = []
  const store = await mountStore({ get: async (url, config) => {
    assert.equal(url, '/links/playlist')
    pages.push(config.params.skip)
    return { data: { tracks: config.params.skip === 20 ? [] : [{ id: 2 }], next_offset: config.params.skip + 20 }, headers: {} }
  } })
  store.getState().playPlaylist([{ id: 1 }, { id: 9 }], 0, 'external', {
    url: '/links/playlist', total: 100, cursor: 20,
  }, { context: { kind: 'playlist' } })
  store.getState().markTrackDisliked({ id: 9 })
  assert.equal(await store.getState().extendPlaybackQueueIfNeeded(true), true)
  assert.deepEqual(pages, [20, 40])
  store.getState().nextTrack('ended')
  assert.equal(store.getState().currentTrack.id, 2)
  assert.equal(store.getState().flowActive, false)
})

test('ended waits for the same flow request as the background preparation', async () => {
  let finishFlow
  let requests = 0
  const store = await mountStore({ get: () => {
    requests += 1
    return new Promise(resolve => { finishFlow = resolve })
  } })
  store.getState().playPlaylist([{ id: 1 }], 0, 'album')
  const preparing = store.getState().extendPlaybackQueueIfNeeded()
  const ending = store.getState().extendPlaybackQueueIfNeeded(true)
  assert.equal(requests, 1)
  finishFlow({ data: flowTracks() })
  assert.deepEqual(await Promise.all([preparing, ending]), [true, true])
  store.getState().nextTrack('ended')
  assert.equal(store.getState().currentTrack.id, 100)
})

test('preparing autoplay does not block an explicit flow start or replace its selected tracks', async () => {
  let finishPreload
  const store = await mountStore({ get: (_url, config) => config.params.preload
    ? new Promise(resolve => { finishPreload = resolve })
    : Promise.resolve({ data: flowTracks(200) }),
  })
  store.getState().playPlaylist([{ id: 1 }], 0, 'album')
  const pending = store.getState().extendPlaybackQueueIfNeeded()
  assert.equal(await store.getState().startFlow(), true)
  assert.equal(store.getState().currentTrack.id, 200)
  finishPreload({ data: flowTracks() })
  assert.equal(await pending, false)
  assert.equal(store.getState().currentTrack.id, 200)
  assert.equal(store.getState().queue.length, 6)
  assert.equal(store.getState().flowActive, true)
})

for (const target of ['page', 'flow']) {
  test(`a failed ${target} request preserves the collection and can be retried`, async () => {
    let fail = true
    const store = await mountStore({ get: async (url) => {
      if (target === 'page') assert.equal(url, '/playlists/1')
      if (fail) throw new Error('offline')
      return { data: target === 'flow' ? flowTracks() : { tracks: [{ id: 2 }] }, headers: { 'x-total-count': '3' } }
    } }, { console: { ...console, error: noop } })
    const pager = target === 'page' ? { url: '/playlists/1', total: 3 } : null
    store.getState().playPlaylist([{ id: 1 }], 0, 'album', pager)
    assert.equal(await store.getState().extendPlaybackQueueIfNeeded(true), null)
    assert.equal(store.getState().queue.length, 1)
    assert.equal(store.getState().flowActive, false)
    assert.equal(store.getState().flowLoading, false)
    assert.equal(Boolean(store.getState().queuePager), target === 'page')
    fail = false
    assert.equal(await store.getState().extendPlaybackQueueIfNeeded(true), true)
  })
}

for (const action of ['replace', 'clear', 'pause']) {
  test(`a pending autoplay request respects ${action}`, async () => {
    let finishFlow
    const store = await mountStore({ get: () => new Promise(resolve => { finishFlow = resolve }) })
    store.getState().playPlaylist([{ id: 1 }], 0, 'album')
    const pending = store.getState().extendPlaybackQueueIfNeeded()
    if (action === 'replace') store.getState().playPlaylist([{ id: 1 }, { id: 2 }], 0, 'album')
    else if (action === 'clear') store.getState().clearQueue()
    else store.getState().togglePlayPause()
    finishFlow({ data: flowTracks() })
    assert.equal(await pending, action === 'pause')
    assert.equal(store.getState().flowActive, false)
    assert.equal(store.getState().isPlaying, action === 'replace')
    assert.equal(store.getState().queue.length, action === 'replace' ? 2 : action === 'clear' ? 0 : 7)
  })
}

test('autoplay excludes collection aliases, dislikes and repeated recommendations', async () => {
  const original = { ...track('original'), id: 1, db_id: 1 }
  const store = await mountStore({ get: async () => ({ data: [track('original'), { id: 101 }, { id: 100 }, { id: 100 }] }) })
  store.setState({ prefetchTracks: noop })
  store.getState().playPlaylist([original, { id: 2 }], 0, 'album')
  store.getState().markTrackDisliked({ id: 101 })
  store.getState().markTrackDisliked({ id: 2 })
  await store.getState().extendPlaybackQueueIfNeeded()
  assert.deepEqual(Array.from(store.getState().queue, row => row.id), [1, 2, 100])
  store.getState().nextTrack('ended')
  assert.equal(store.getState().currentTrack.id, 100)
  assert.equal(store.getState().flowActive, true)
})

test('an empty flow leaves the completed collection stopped and search queues do not start flow', async () => {
  let requests = 0
  const store = await mountStore({ get: async () => { requests += 1; return { data: [] } } })
  store.getState().playPlaylist([{ id: 1 }], 0, 'album')
  assert.equal(await store.getState().extendPlaybackQueueIfNeeded(true), false)
  store.getState().nextTrack('ended')
  assert.equal(store.getState().isPlaying, false)
  assert.equal(store.getState().flowActive, false)
  assert.equal(store.getState().flowStartIndex, null)
  store.getState().playTrack({ id: 2 })
  assert.equal(await store.getState().extendPlaybackQueueIfNeeded(), false)
  assert.equal(requests, 1)
})

test('restoring a trimmed queue preserves the transition from its last album track into flow', async () => {
  const store = await mountStore({ get: async () => ({ data: flowTracks() }) })
  const album = Array.from({ length: 80 }, (_, i) => ({ id: i + 1 }))
  store.getState().playPlaylist(album, 79, 'album')
  await store.getState().extendPlaybackQueueIfNeeded()
  const persist = mountPersistence(store)
  persist.restorePlayer(7)
  persist.hide()
  const saved = JSON.parse(persist.storage.get(persist.PLAYER_PERSIST_KEY))
  assert.equal(saved.currentIndex, 50)
  assert.equal(saved.flowStartIndex, 51)
  assert.equal(saved.flowActive, false)

  const reopened = await mountStore()
  mountPersistence(reopened, persist.storage).restorePlayer(7)
  assert.equal(reopened.getState().currentTrack.id, 80)
  assert.equal(reopened.getState().isPlaying, false)
  assert.equal(reopened.getState().flowActive, false)
  reopened.getState().togglePlayPause()
  reopened.getState().nextTrack('ended')
  assert.equal(reopened.getState().currentTrack.id, 100)
  assert.equal(reopened.getState().flowActive, true)
  assert.equal(playbackLabel(reopened.getState()), 'поток')
})
