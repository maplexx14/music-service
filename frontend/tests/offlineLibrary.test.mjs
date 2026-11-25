import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { create } from 'zustand'
import { isUuid } from '../src/utils/identifiers.js'

const sources = await Promise.all(['trackSource', 'offlineTracks', 'offlineLibrary'].map((name) => readFile(new URL(`../src/services/${name}.js`, import.meta.url), 'utf8')))
const a = { id: 'ytmusic:a', source: 'ytmusic', external_id: 'a', title: 'Saved A', artist: 'Artist A' }
const b = { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', title: 'Saved B', artist: 'Artist B' }
const c = { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', title: 'Saved C', artist: 'Artist C' }
function mount() {
  const entries = new Map()
  const cache = { match: async (path) => entries.get(path)?.clone(), put: async (path, value) => entries.set(path, value.clone()), keys: async () => [] }
  const navigator = { onLine: false, serviceWorker: { controller: {} } }
  const context = vm.createContext({ create, isUuid, console, API_URL: '/api', SERVER_URL: '', URL, URLSearchParams, Response, Blob, DOMException, AbortController,
    resolveCoverUrl: (url) => url, navigator, isOffline: () => navigator.onLine === false, window: { location: { href: 'https://bolt.test/' } }, caches: { open: async () => cache },
  })
  const code = sources.map((source) => source.replace(/\r\n/g, '\n').replace(/^import .+\n/gm, '').replace(/\bexport /g, '').replace("import('../components/FullScreenPlayer')", 'Promise.resolve()')).join('\n')
  vm.runInContext(code + '\nthis.api={useOfflineTracks,loadOfflineTracks,offlineArtist,offlineCollections,offlineApiResponse,randomOfflineTracks,syncOfflineLibrary};', context)
  const api = context.api
  api.useOfflineTracks.setState({ userId: 'owner', ready: true, tracks: [a, b, c].map((track) => ({ key: track.id, track })), library: {
    playlists: [{ id: 'mix', name: 'Offline mix', track_keys: ['ytmusic:a', b.id, 'missing'] }, { id: 'empty', name: 'Unavailable', track_keys: ['missing'] }],
    likedKeys: ['ytmusic:a', 'missing'],
  } })
  return { ...api, context, entries }
}

test('collections contain only downloaded tracks, include partial playlists, and omit empty ones', () => {
  const app = mount()
  const data = app.offlineCollections()
  assert.equal(data.tracks.length, 3)
  assert.equal(data.playlists.length, 1)
  assert.deepEqual(Array.from(data.playlists[0].tracks, (track) => track.id), [a.id, b.id])
  assert.equal(data.playlists[0].track_count, 2)
  assert.equal(data.liked.tracks.length, 1)
})

test('offline API serves recommendations, liked songs, playlists, paging and search without a network', async () => {
  const app = mount()
  assert.equal((await app.offlineApiResponse('/recommendations/')).data.tracks.length, 3)
  assert.equal((await app.offlineApiResponse('/playlists/me')).data.length, 1)
  assert.equal((await app.offlineApiResponse('/playlists/me/liked')).data.tracks.length, 1)
  const response = await app.offlineApiResponse('/playlists/mix', { params: { skip: 1, limit: 1 } })
  assert.equal(response.data.tracks[0].id, b.id)
  assert.equal(response.headers['x-total-count'], '2')
  assert.equal((await app.offlineApiResponse('/search/', { params: { q: 'Artist B' } })).data.tracks[0].id, b.id)
  await assert.rejects(app.offlineApiResponse('/playlists/empty'), /нет скачанных/)
})

test('offline radio includes the entire downloaded library once per shuffled batch', () => {
  const app = mount()
  const tracks = app.randomOfflineTracks([], () => 0)
  assert.equal(tracks.length, 3)
  assert.equal(new Set(tracks.map((track) => track.id)).size, 3)
  assert.notEqual(tracks[0].id, a.id)
  assert.equal(app.randomOfflineTracks([a.id]).length, 2)
})

test('removing a local file immediately removes it from playlists, liked songs and radio', async () => {
  const app = mount()
  app.useOfflineTracks.setState((state) => ({ tracks: state.tracks.filter((entry) => entry.track.id !== a.id) }))
  assert.equal(app.offlineCollections().liked.tracks.length, 0)
  assert.equal(app.offlineCollections().playlists[0].tracks.length, 1)
  assert.equal((await app.offlineApiResponse('/recommendations/flow')).data.length, 2)
})

test('collection metadata survives reopening the application without internet', async () => {
  const app = mount()
  await app.loadOfflineTracks('owner')
  const library = { playlists: [{ id: 'persisted', track_keys: [b.id] }], likedKeys: [b.id] }
  app.context.navigator.onLine = true
  app.useOfflineTracks.setState({ tracks: [{ track: b, key: b.id }] })
  await app.syncOfflineLibrary({ post: async () => ({ data: library }) })
  assert.ok(app.entries.has('/__bolt_offline__/owner/library.json'))
  app.context.navigator.onLine = false
  await app.loadOfflineTracks('owner')
  assert.equal(app.useOfflineTracks.getState().library.playlists[0].id, 'persisted')
  await app.loadOfflineTracks('other')
  assert.equal(app.useOfflineTracks.getState().library.playlists.length, 0)
})

test('explicitly downloaded public playlists survive server library sync and remain playable offline', async () => {
  const app = mount()
  await app.loadOfflineTracks('owner')
  app.context.navigator.onLine = true
  app.useOfflineTracks.setState({ tracks: [{ track: b, key: b.id }], library: {
    playlists: [], likedKeys: [], downloadedPlaylists: [{ id: 'public-mix', name: 'Public mix', track_keys: [b.id, 'missing'] }],
  } })
  await app.syncOfflineLibrary({ post: async () => ({ data: { playlists: [], likedKeys: [] } }) })
  assert.equal(app.offlineCollections().playlists[0].id, 'public-mix')
  app.context.navigator.onLine = false
  assert.equal((await app.offlineApiResponse('/playlists/public-mix')).data.tracks[0].id, b.id)
  await app.loadOfflineTracks('owner')
  assert.equal(app.useOfflineTracks.getState().library.downloadedPlaylists[0].id, 'public-mix')
})

test('downloaded artist pages restore exact track membership, portrait and favorite state offline', async () => {
  const app = mount()
  app.useOfflineTracks.setState({ tracks: [
    { key: b.id, track: { ...b, artist: 'Artist & Guest', cover_url: 'song.webp' } },
    { key: c.id, track: { ...c, artist: 'Artist tribute' } },
  ], library: { playlists: [], likedKeys: [], downloadedPlaylists: [{
    id: 'artist:artist', name: 'Artist', track_keys: [b.id, 'missing'], cover_url: '/__bolt_offline__/owner/artist/collection-cover',
    artist_is_liked: true, is_liked: false, download_source: { type: 'artist', name: 'Artist' }, page_url: '/artists/Artist',
    albums: [{ source: 'ytmusic', external_id: 'unavailable', title: 'Not downloaded' }],
  }] } })
  const data = (await app.offlineApiResponse('/artists', { params: { name: 'ARTIST' } })).data
  assert.equal(data.name, 'Artist')
  assert.deepEqual(Array.from(data.tracks, (item) => item.id), [b.id])
  assert.equal(data.cover_url, '/__bolt_offline__/owner/artist/collection-cover')
  assert.equal(data.is_liked, true)
  assert.equal(data.albums.length, 0)
  app.useOfflineTracks.setState({ tracks: [] })
  assert.equal(app.offlineArtist('Artist').tracks.length, 0)
})
