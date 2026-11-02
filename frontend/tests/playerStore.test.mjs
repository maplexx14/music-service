import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { create } from 'zustand'
import * as queueUtils from '../src/utils/playerQueue.js'

const source = await readFile(new URL('../src/store/playerStore.js', import.meta.url), 'utf8')
const noop = () => {}
const track = (id, artist = 'Favorite', protectedArtist = true) => ({
  id: `ytmusic:${id}`, source: 'ytmusic', external_id: id, artist, title: id,
  recommendation_surface: 'flow', recommendation_protected_artist: protectedArtist,
  recommendation_track_key: `${artist.toLowerCase()}|${id}`,
})

async function mountStore(apiOverrides = {}) {
  const api = {
    get: async () => ({ data: [] }), post: async () => ({ data: {} }), delete: async () => ({}),
    ...apiOverrides,
  }
  const context = vm.createContext({ console, performance, Date, setTimeout, clearTimeout })
  const imports = {
    zustand: { create }, '../services/api': { default: api },
    '../services/pageCache': { invalidateCache: noop, patchCache: noop, peekCache: noop, LIKED_CACHE_KEY: 'liked' },
    '../utils/playerQueue': queueUtils,
  }
  const module = new vm.SourceTextModule(source, { context })
  await module.link(async (name) => {
    const exports = imports[name]
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
    }, { context })
  })
  await module.evaluate()
  return module.namespace.usePlayerStore
}

function setQueue(store, queue, extra = {}) {
  store.setState({ queue, currentTrack: queue[0], currentIndex: 0, isPlaying: true,
    shuffledOrder: queue.map((_, i) => i), currentShuffleIndex: -1,
    flowActive: true, ...extra })
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
