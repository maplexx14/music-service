import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { create } from 'zustand'
import { isUuid } from '../src/utils/identifiers.js'
import { validateDownloadResponse } from '../src/services/downloadResponse.js'

const source = await readFile(new URL('../src/services/offlineTracks.js', import.meta.url), 'utf8')
const urls = await readFile(new URL('../src/services/trackSource.js', import.meta.url), 'utf8')
const rangeSource = await readFile(new URL('../public/offline-response.js', import.meta.url), 'utf8')
const origin = 'https://bolt.test'
const track = { id: 'ytmusic:abc', source: 'ytmusic', external_id: 'abc', stream_url: `${origin}/api/ytdlp/stream/abc`, title: 'Test', artist: 'Artist' }
function mount(fetchImpl = async () => new Response('0123456789', { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '10' } })) {
  const entries = new Map()
  const absolute = (path) => new URL(typeof path === 'string' ? path : path.url, origin).href
  const cache = {
    put: async (path, response) => entries.set(absolute(path), response.clone()),
    match: async (path) => entries.get(absolute(path))?.clone(),
    delete: async (path) => entries.delete(absolute(path)),
    keys: async () => [...entries.keys()].map((url) => new Request(url)),
  }
  const context = vm.createContext({
    create, isUuid, validateDownloadResponse, API_URL: `${origin}/api`, SERVER_URL: origin,
    resolveCoverUrl: (path) => path, console, URL, Response, Request, Headers, Blob, DOMException, AbortController,
    navigator: { onLine: true, serviceWorker: { controller: {} }, storage: { persist: async () => true } },
    window: { location: { href: origin } }, caches: { open: async () => cache }, fetch: fetchImpl,
  })
  const transform = (code) => code.replace(/^import .+\n/gm, '').replace(/\bexport /g, '').replace("import('../components/FullScreenPlayer')", 'Promise.resolve()')
  vm.runInContext(transform(urls) + '\n' + transform(source) + '\n' + rangeSource + '\nthis.api = { loadOfflineTracks, downloadTrack, downloadPlaylist, cancelPlaylistDownload, setOfflineLibrarySync, offlineAudioUrl, removeOfflineTrack, cancelDownload, useOfflineTracks, offlineResponse, onlineTrackUrl };', context)
  return { ...context.api, cache, entries, context }
}

test('downloads persist across reload, use stable provider keys, and delete all files', async () => {
  const app = mount()
  await app.loadOfflineTracks('user-a')
  await app.downloadTrack(track, 'secret')
  assert.equal(app.useOfflineTracks.getState().tracks.length, 1)
  const url = app.offlineAudioUrl(track)
  assert.match(url, /__bolt_offline__/)
  await app.loadOfflineTracks('user-a')
  assert.equal(app.offlineAudioUrl({ ...track, id: '12345678-1234-1234-1234-123456789abc' }), url)
  const response = await app.offlineResponse(new Request(origin + url))
  assert.equal(await response.text(), '0123456789')
  assert.equal(response.headers.get('Accept-Ranges'), 'bytes')
  await app.removeOfflineTrack('ytmusic:abc')
  assert.equal(app.entries.size, 0)
  assert.equal(app.offlineAudioUrl(track), undefined)
})

test('downloaded libraries are isolated by account and survive account switching', async () => {
  const app = mount()
  await app.loadOfflineTracks('a')
  await app.downloadTrack(track)
  await app.loadOfflineTracks('b')
  assert.equal(app.offlineAudioUrl(track), undefined)
  assert.equal(app.useOfflineTracks.getState().tracks.length, 0)
  await app.loadOfflineTracks('a')
  assert.ok(app.offlineAudioUrl(track))
  await app.loadOfflineTracks(null)
  assert.equal(app.offlineAudioUrl(track), undefined)
})

test('mobile seek requests return exact bytes for closed, open and suffix ranges', async () => {
  const app = mount()
  await app.loadOfflineTracks('a')
  await app.downloadTrack(track)
  const url = origin + app.offlineAudioUrl(track)
  for (const [range, expected, contentRange] of [['bytes=0-1', '01', 'bytes 0-1/10'], ['bytes=5-', '56789', 'bytes 5-9/10'], ['bytes=-3', '789', 'bytes 7-9/10'], ['bytes=8-99', '89', 'bytes 8-9/10']]) {
    const response = await app.offlineResponse(new Request(url, { headers: { Range: range } }))
    assert.equal(response.status, 206)
    assert.equal(await response.text(), expected)
    assert.equal(response.headers.get('Content-Range'), contentRange)
    assert.equal(Number(response.headers.get('Content-Length')), expected.length)
  }
  for (const range of ['bytes=10-', 'bytes=8-3', 'bytes=-0', 'bytes=', 'bytes=0-1,5-6']) {
    const response = await app.offlineResponse(new Request(url, { headers: { Range: range } }))
    assert.equal(response.status, 416)
    assert.equal(response.headers.get('Content-Range'), 'bytes */10')
  }
})

test('partial responses, HTML errors and truncated bodies never appear as downloaded tracks', async () => {
  for (const response of [
    new Response('abc', { status: 206, headers: { 'Content-Type': 'audio/mpeg' } }),
    new Response('<html/>', { headers: { 'Content-Type': 'text/html' } }),
    new Response('abc', { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '10' } }),
  ]) {
    const app = mount(async () => response)
    await app.loadOfflineTracks('a')
    await assert.rejects(app.downloadTrack(track))
    assert.equal(app.entries.size, 0)
    assert.equal(app.useOfflineTracks.getState().tracks.length, 0)
    assert.equal(Object.keys(app.useOfflineTracks.getState().jobs).length, 0)
  }
})

test('downloads bypass playback HTTP cache and accept a verified complete 206 body', async () => {
  const app = mount(async (_, options) => {
    assert.equal(options.cache, 'no-store')
    assert.equal(options.headers.Range, undefined)
    return new Response('0123456789', { status: 206, headers: { 'Content-Type': 'audio/mp4', 'Content-Range': 'bytes 0-9/10', 'Content-Length': '10' } })
  })
  await app.loadOfflineTracks('a')
  await app.downloadTrack(track)
  assert.equal(app.useOfflineTracks.getState().tracks[0].bytes, 10)
  assert.equal(await (await app.offlineResponse(new Request(origin + app.offlineAudioUrl(track)))).text(), '0123456789')
})

test('partial byte ranges are rejected even when their body matches Content-Length', async () => {
  for (const range of ['bytes 0-2/10', 'bytes 3-5/10', 'bytes 0-2/*']) {
    const app = mount(async () => new Response('abc', { status: 206, headers: { 'Content-Type': 'audio/mpeg', 'Content-Range': range, 'Content-Length': '3' } }))
    await app.loadOfflineTracks('a')
    await assert.rejects(app.downloadTrack(track), /только часть/)
    assert.equal(app.entries.size, 0)
  }
})

test('download failures show HTTP status and server explanation', async () => {
  const app = mount(async () => new Response(JSON.stringify({ detail: 'Источник временно ограничил доступ' }), { status: 503, headers: { 'Content-Type': 'application/json' } }))
  await app.loadOfflineTracks('a')
  await assert.rejects(app.downloadTrack(track), /Источник временно ограничил доступ.*HTTP 503/)
})

test('cancellation and logout during download do not commit incomplete or foreign entries', async () => {
  for (const logout of [false, true]) {
    let release
    const app = mount(() => new Promise((resolve) => { release = resolve }))
    await app.loadOfflineTracks('a')
    const pending = app.downloadTrack(track)
    if (logout) await app.loadOfflineTracks('b')
    else app.cancelDownload('ytmusic:abc')
    release(new Response('abc', { headers: { 'Content-Type': 'audio/mpeg' } }))
    await assert.rejects(pending, { name: 'AbortError' })
    assert.equal(app.entries.size, 0)
    assert.equal(app.useOfflineTracks.getState().tracks.length, 0)
  }
})

test('quota failures roll back downloaded audio and show a useful error', async () => {
  const app = mount()
  const put = app.cache.put
  app.cache.put = async (path, response) => {
    if (path.endsWith('/meta')) throw new DOMException('Quota exceeded', 'QuotaExceededError')
    return put(path, response)
  }
  await app.loadOfflineTracks('a')
  await assert.rejects(app.downloadTrack(track), /Недостаточно места/)
  assert.equal(app.entries.size, 0)
})

test('authentication tokens are only sent to the configured API', async () => {
  const requests = []
  const app = mount(async (url, options) => {
    requests.push(options.headers)
    return new Response('abc', { headers: { 'Content-Type': 'audio/mpeg' } })
  })
  await app.loadOfflineTracks('a')
  await app.downloadTrack(track, 'secret')
  await app.downloadTrack({ ...track, id: 'external:2', external_id: '2', stream_url: 'https://provider.test/song' }, 'secret')
  assert.equal(requests[0].Authorization, 'Bearer secret')
  assert.equal(requests[1].Authorization, undefined)
})

const playlistTrack = (index) => ({ ...track, id: `ytmusic:${index}`, external_id: String(index), title: `Track ${index}` })
function playlistClient(tracks, requests = [], isLiked = false) {
  return { get: async (url, options) => {
    requests.push({ url, ...options.params })
    return { data: { id: 'mix', name: 'Mix', is_liked: isLiked, tracks: tracks.slice(options.params.skip, options.params.skip + options.params.limit) }, headers: { 'x-total-count': String(tracks.length) } }
  } }
}

test('playlist downloads fetch every page, skip saved files and duplicates, and preserve metadata across reload', async () => {
  let downloads = 0
  let syncs = 0
  const app = mount(async () => { downloads++; return new Response('abc', { headers: { 'Content-Type': 'audio/mpeg' } }) })
  await app.loadOfflineTracks('a')
  app.setOfflineLibrarySync(async () => { syncs++ })
  await app.downloadTrack(playlistTrack(0))
  syncs = 0
  const all = [...Array.from({ length: 103 }, (_, i) => playlistTrack(i)), playlistTrack(0)]
  const requests = []
  const result = await app.downloadPlaylist({ id: 'mix', name: 'Mix', tracks: all.slice(0, 30) }, 'secret', playlistClient(all, requests))
  assert.deepEqual(requests, [{ url: '/playlists/mix', skip: 0, limit: 100 }, { url: '/playlists/mix', skip: 100, limit: 100 }])
  assert.equal(result.saved, 103)
  assert.equal(downloads, 103)
  assert.equal(syncs, 1)
  assert.equal(Object.keys(app.useOfflineTracks.getState().playlistJobs).length, 0)
  await app.loadOfflineTracks('a')
  assert.equal(app.useOfflineTracks.getState().tracks.length, 103)
  assert.equal(app.useOfflineTracks.getState().library.downloadedPlaylists[0].track_keys.length, 103)
})

test('playlist failures preserve successes and retry only missing tracks', async () => {
  let broken = true
  const counts = new Map()
  const app = mount(async (url) => {
    const id = url.pathname.split('/').pop()
    counts.set(id, (counts.get(id) || 0) + 1)
    if (id === '1' && broken) return new Response('Unavailable', { status: 503 })
    return new Response('abc', { headers: { 'Content-Type': 'audio/mpeg' } })
  })
  await app.loadOfflineTracks('a')
  const all = [0, 1, 2].map((i) => ({ ...playlistTrack(i), stream_url: `${origin}/api/audio/${i}` }))
  const client = playlistClient(all)
  const result = await app.downloadPlaylist({ id: 'mix', name: 'Mix' }, null, client)
  assert.equal(result.saved, 2)
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].title, 'Track 1')
  broken = false
  assert.equal((await app.downloadPlaylist({ id: 'mix', name: 'Mix' }, null, client)).saved, 3)
  assert.equal(counts.get('0'), 1)
  assert.equal(counts.get('1'), 2)
  assert.equal(counts.get('2'), 1)
})

test('cancelling a playlist or switching account stops queued downloads and clears progress', async () => {
  for (const logout of [false, true]) {
    let release
    let started
    let downloads = 0
    const downloading = new Promise((resolve) => { started = resolve })
    const app = mount(() => { downloads++; started(); return new Promise((resolve) => { release = resolve }) })
    await app.loadOfflineTracks('a')
    const pending = app.downloadPlaylist({ id: 'mix', name: 'Mix' }, null, playlistClient([0, 1, 2].map(playlistTrack)))
    await downloading
    if (logout) await app.loadOfflineTracks('b')
    else app.cancelPlaylistDownload('mix')
    release(new Response('abc', { headers: { 'Content-Type': 'audio/mpeg' } }))
    await assert.rejects(pending, { name: 'AbortError' })
    assert.equal(downloads, 1)
    assert.equal(app.useOfflineTracks.getState().tracks.length, 0)
    assert.equal(Object.keys(app.useOfflineTracks.getState().playlistJobs).length, 0)
  }
})

test('liked playlist uses its dedicated endpoint and persists liked membership', async () => {
  const app = mount()
  await app.loadOfflineTracks('a')
  const requests = []
  await app.downloadPlaylist({ id: 'mix', name: 'Понравившиеся', is_liked: true }, null, playlistClient([track], requests, true))
  assert.equal(requests[0].url, '/playlists/me/liked')
  await app.loadOfflineTracks('a')
  assert.deepEqual(Array.from(app.useOfflineTracks.getState().library.likedKeys), ['ytmusic:abc'])
})

test('playlist joins an existing individual download before reporting success', async () => {
  let release
  let downloads = 0
  const app = mount(() => { downloads++; return new Promise((resolve) => { release = resolve }) })
  await app.loadOfflineTracks('a')
  const individual = app.downloadTrack(track)
  const pending = app.downloadPlaylist({ id: 'mix', name: 'Mix' }, null, playlistClient([track]))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(app.useOfflineTracks.getState().playlistJobs.mix.completed, 0)
  release(new Response('abc', { headers: { 'Content-Type': 'audio/mpeg' } }))
  await individual
  assert.equal((await pending).saved, 1)
  assert.equal(downloads, 1)
})

test('simultaneous playlist downloads retain both collections and download shared audio once', async () => {
  let downloads = 0
  const app = mount(async () => { downloads++; return new Response('abc', { headers: { 'Content-Type': 'audio/mpeg' } }) })
  await app.loadOfflineTracks('a')
  const client = { get: async (url) => ({ data: { id: url.split('/').pop(), name: 'Mix', tracks: [track] }, headers: { 'x-total-count': '1' } }) }
  const results = await Promise.all(['first', 'second'].map((id) => app.downloadPlaylist({ id, name: id }, null, client)))
  assert.equal(results[0].saved, 1)
  assert.equal(results[1].saved, 1)
  assert.equal(downloads, 1)
  await app.loadOfflineTracks('a')
  assert.deepEqual(Array.from(app.useOfflineTracks.getState().library.downloadedPlaylists, (item) => item.id).sort(), ['first', 'second'])
})

test('external SoundCloud playlist downloads every track without importing it to the server library', async () => {
  const app = mount()
  await app.loadOfflineTracks('a')
  const all = Array.from({ length: 45 }, (_, i) => playlistTrack(i))
  const playlist = { id: 'soundcloud:playlist:42', name: 'External mix', tracks: all.slice(0, 30),
    download_source: { type: 'soundcloud', id: '42' }, page_url: '/external/soundcloud/playlists/42' }
  let requests = 0
  const client = { get: async (url, config) => {
    requests++
    assert.equal(url, '/soundcloud/playlists/42')
    assert.ok(config.signal)
    return { data: { playlist: { id: playlist.id, title: 'External mix', track_count: 45 }, tracks: all }, headers: {} }
  } }
  assert.equal((await app.downloadPlaylist(playlist, null, client)).saved, 45)
  assert.equal(requests, 1)
  await app.loadOfflineTracks('a')
  const saved = app.useOfflineTracks.getState().library.downloadedPlaylists[0]
  assert.equal(saved.name, 'External mix')
  assert.equal(saved.page_url, playlist.page_url)
  assert.equal(saved.track_keys.length, 45)
})

test('linked playlists follow source cursors through empty matched pages and retain skipped count', async () => {
  const app = mount()
  await app.loadOfflineTracks('a')
  const url = 'https://music.youtube.com/playlist?list=PLmix'
  const playlist = { id: `link:${url}`, name: 'Linked mix', download_source: { type: 'link', url }, page_url: `/link?url=${encodeURIComponent(url)}` }
  const cursors = []
  const client = { get: async (path, config) => {
    assert.equal(path, '/import/listen')
    assert.equal(config.params.url, url)
    cursors.push(config.params.skip)
    const pages = {
      0: { tracks: [playlistTrack(0)], skipped: 1, next_offset: 2 },
      2: { tracks: [], skipped: 2, next_offset: 4 },
      4: { tracks: [playlistTrack(4)], skipped: 0, next_offset: null },
    }
    return { data: { title: 'Linked mix', kind: 'playlist', source: 'ytmusic', total: 5, ...pages[config.params.skip] }, headers: {} }
  } }
  const result = await app.downloadPlaylist(playlist, null, client)
  assert.deepEqual(cursors, [0, 2, 4])
  assert.equal(result.saved, 2)
  assert.equal(result.skipped, 3)
  await app.loadOfflineTracks('a')
  const saved = app.useOfflineTracks.getState().library.downloadedPlaylists[0]
  assert.equal(saved.id, playlist.id)
  assert.equal(saved.page_url, playlist.page_url)
  assert.equal(saved.total, 5)
  assert.equal(saved.skipped, 3)
  assert.equal(saved.track_keys.length, 2)
})

test('invalid source cursors fail without saving an incomplete linked playlist', async () => {
  const app = mount()
  await app.loadOfflineTracks('a')
  const playlist = { id: 'link:mix', name: 'Mix', download_source: { type: 'link', url: 'https://provider.test/mix' } }
  const client = { get: async () => ({ data: { tracks: [track], next_offset: 0 }, headers: {} }) }
  await assert.rejects(app.downloadPlaylist(playlist, null, client), /догрузить/)
  assert.equal(app.useOfflineTracks.getState().tracks.length, 0)
  assert.equal(Object.keys(app.useOfflineTracks.getState().playlistJobs).length, 0)
})

test('albums download from their own endpoint and preserve their offline page', async () => {
  const app = mount()
  await app.loadOfflineTracks('a')
  const playlist = { id: 'album:yandex:42', name: 'Album', download_source: { type: 'album', source: 'yandex', id: '42' }, page_url: '/albums/yandex/42' }
  const client = { get: async (url) => {
    assert.equal(url, '/albums/yandex/42')
    return { data: { album: { title: 'Album', source: 'yandex', external_id: '42' }, tracks: [track] }, headers: {} }
  } }
  assert.equal((await app.downloadPlaylist(playlist, null, client)).saved, 1)
  await app.loadOfflineTracks('a')
  assert.equal(app.useOfflineTracks.getState().library.downloadedPlaylists[0].page_url, playlist.page_url)
})

test('artist page download includes local and external tracks once and preserves portrait and metadata', async () => {
  let audioRequests = 0
  const app = mount(async (url) => {
    if (String(url) === 'https://images.test/artist.webp') return new Response('portrait', { headers: { 'Content-Type': 'image/webp' } })
    audioRequests++
    return new Response('abc', { headers: { 'Content-Type': 'audio/mpeg' } })
  })
  await app.loadOfflineTracks('a')
  const external = Array.from({ length: 42 }, (_, i) => playlistTrack(i))
  const local = { ...external[0], id: '12345678-1234-1234-1234-123456789abc' }
  const playlist = { id: 'artist:artist', name: 'Artist', download_source: { type: 'artist', name: 'Artist' }, page_url: '/artists/Artist' }
  const client = { get: async (url, config) => {
    assert.equal(url, '/artists')
    assert.deepEqual({ ...config.params }, { name: 'Artist', limit: 100 })
    return { data: { name: 'Artist', is_liked: true, cover_url: 'https://images.test/artist.webp', tracks: [local], external, albums: [] }, headers: {} }
  } }
  const result = await app.downloadPlaylist(playlist, null, client)
  assert.equal(result.saved, 42)
  assert.equal(audioRequests, 42)
  await app.loadOfflineTracks('a')
  const library = app.useOfflineTracks.getState().library
  assert.equal(library.likedKeys.length, 0)
  const saved = library.downloadedPlaylists[0]
  assert.equal(saved.id, 'artist:artist')
  assert.equal(saved.is_liked, false)
  assert.equal(saved.artist_is_liked, true)
  assert.equal(saved.page_url, '/artists/Artist')
  assert.equal(saved.external, undefined)
  assert.match(saved.cover_url, /collection-cover$/)
  assert.equal(await (await app.cache.match(saved.cover_url)).text(), 'portrait')
})

test('artist audio downloads still succeed if the portrait cannot be fetched', async () => {
  const app = mount(async (url) => {
    if (String(url) === 'https://images.test/unavailable.webp') throw new Error('Network error')
    return new Response('abc', { headers: { 'Content-Type': 'audio/mpeg' } })
  })
  await app.loadOfflineTracks('a')
  const playlist = { id: 'artist:artist', name: 'Artist', download_source: { type: 'artist', name: 'Artist' } }
  const client = { get: async () => ({ data: { name: 'Artist', cover_url: 'https://images.test/unavailable.webp', tracks: [], external: [track] }, headers: {} }) }
  assert.equal((await app.downloadPlaylist(playlist, null, client)).saved, 1)
})
