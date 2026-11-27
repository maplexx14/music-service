import { create } from 'zustand'
import { onlineTrackUrl } from './trackSource'
import { resolveCoverUrl } from '../utils/media'
import { API_URL } from '../config'
import { validateDownloadResponse } from './downloadResponse'

export const OFFLINE_CACHE = 'bolt-offline-v1'
const PREFIX = '/__bolt_offline__/'
export const offlineTrackKey = (track) => track?.external_id && track?.source
  ? `${track.source}:${track.external_id}` : String(track?.id || '')
const pathFor = (owner, key, kind) => `${PREFIX}${encodeURIComponent(owner)}/${encodeURIComponent(key)}/${kind}`
let owner = null
let generation = 0
const active = new Map()
const activePlaylists = new Map()
let syncLibrary = null
let libraryWrite = Promise.resolve()
export const useOfflineTracks = create(() => ({ userId: null, tracks: [], library: { playlists: [], likedKeys: [] }, jobs: {}, playlistJobs: {}, ready: false, error: '' }))
export const getOfflineOwner = () => owner
export function setOfflineLibrarySync(callback) { syncLibrary = callback; return () => { if (syncLibrary === callback) syncLibrary = null } }
export function offlineLibraryPath(userId) { return `${PREFIX}${encodeURIComponent(userId)}/library.json` }

// Serialize collection writes so simultaneous downloads cannot lose each other's metadata.
export function updateOfflineLibrary(update, expectedOwner = owner) {
  const run = generation
  const write = libraryWrite.catch(() => {}).then(async () => {
    if (!expectedOwner || owner !== expectedOwner || run !== generation) return
    const cache = await caches.open(OFFLINE_CACHE)
    if (owner !== expectedOwner || run !== generation) return
    const library = update(useOfflineTracks.getState().library)
    await cache.put(offlineLibraryPath(expectedOwner), new Response(JSON.stringify(library), { headers: { 'Content-Type': 'application/json' } }))
    if (owner === expectedOwner && run === generation) useOfflineTracks.setState({ library })
  })
  libraryWrite = write
  return write
}

export function downloadedTracks(tracks = useOfflineTracks.getState().tracks.map((entry) => entry.track)) {
  const saved = new Map(useOfflineTracks.getState().tracks.map((entry) => [offlineTrackKey(entry.track), entry.track]))
  const seen = new Set()
  return tracks.flatMap((track) => {
    const key = offlineTrackKey(track)
    if (!saved.has(key) || seen.has(key)) return []
    seen.add(key)
    return [{ ...track, ...saved.get(key) }]
  })
}

export async function loadOfflineTracks(userId) {
  const run = ++generation
  owner = userId ? String(userId) : null
  const loadedOwner = owner
  for (const controller of active.values()) controller.abort()
  for (const controller of activePlaylists.values()) controller.abort()
  active.clear()
  activePlaylists.clear()
  useOfflineTracks.setState({ userId: loadedOwner, tracks: [], library: { playlists: [], likedKeys: [] }, jobs: {}, playlistJobs: {}, ready: false, error: '' })
  try {
    const tracks = []
    let library = { playlists: [], likedKeys: [] }
    if (loadedOwner && typeof caches !== 'undefined') {
      const cache = await caches.open(OFFLINE_CACHE)
      try { library = await (await cache.match(offlineLibraryPath(loadedOwner))).json() } catch { /* New library. */ }
      for (const request of await cache.keys()) {
        if (!new URL(request.url).pathname.startsWith(`${PREFIX}${encodeURIComponent(loadedOwner)}/`) || !request.url.endsWith('/meta')) continue
        try {
          const entry = await (await cache.match(request)).json()
          if (await cache.match(entry.audioUrl)) tracks.push(entry)
          else await cache.delete(request)
        } catch { /* A damaged entry must not prevent opening the library. */ }
      }
    }
    if (run === generation) useOfflineTracks.setState({ tracks: tracks.sort((a, b) => b.savedAt - a.savedAt), library, ready: true })
  } catch {
    if (run === generation) useOfflineTracks.setState({ ready: true, error: 'Не удалось открыть скачанные треки' })
  }
}

export function offlineAudioUrl(track) {
  if (!owner || !navigator.serviceWorker?.controller) return undefined
  return useOfflineTracks.getState().tracks.find((entry) => entry.key === offlineTrackKey(track))?.audioUrl
}

function job(key, value) {
  const jobs = { ...useOfflineTracks.getState().jobs }
  if (value == null) delete jobs[key]
  else jobs[key] = value
  useOfflineTracks.setState({ jobs })
}

export async function downloadTrack(track, token, { signal, sync = true } = {}) {
  const key = offlineTrackKey(track)
  if (!owner) throw new Error('Войдите, чтобы скачивать треки')
  if (!key || !onlineTrackUrl(track)) throw new Error('Этот трек недоступен для скачивания')
  if (active.has(key) || useOfflineTracks.getState().tracks.some((entry) => entry.key === key)) return
  if (navigator.onLine === false) throw new Error('Для скачивания нужен интернет')
  if (!navigator.serviceWorker?.controller || typeof caches === 'undefined') throw new Error('Откройте приложение через HTTPS и перезапустите его для скачивания')
  const run = generation
  const savedOwner = owner
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  active.set(key, controller)
  job(key, { progress: null, title: track.title })
  const audioUrl = pathFor(savedOwner, key, 'audio')
  const coverUrl = pathFor(savedOwner, key, 'cover')
  const metaUrl = pathFor(savedOwner, key, 'meta')
  let cache
  try {
    const source = new URL(onlineTrackUrl(track), window.location.href)
    const apiSource = new URL(API_URL, window.location.href)
    const headers = source.origin === apiSource.origin && source.pathname.startsWith(apiSource.pathname.replace(/\/$/, '') + '/') && token
      ? { Authorization: `Bearer ${token}` } : {}
    const response = await fetch(source, { headers, signal: controller.signal, cache: 'no-store' })
    const { type, total } = await validateDownloadResponse(response)
    const reader = response.body?.getReader()
    const chunks = []
    let size = 0
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        size += value.byteLength
        const progress = total ? Math.min(99, Math.round(size / total * 100)) : null
        if (run === generation && useOfflineTracks.getState().jobs[key]?.progress !== progress) job(key, { progress, title: track.title })
      }
    } else {
      const bytes = await response.arrayBuffer()
      chunks.push(bytes)
      size = bytes.byteLength
    }
    if (!size) throw new Error('Скачан пустой файл')
    if (total && !response.headers.get('content-encoding') && size !== total) throw new Error('Файл скачан не полностью. Попробуйте ещё раз')
    if (controller.signal.aborted || run !== generation) throw new DOMException('Cancelled', 'AbortError')
    cache = await caches.open(OFFLINE_CACHE)
    await cache.put(audioUrl, new Response(new Blob(chunks, { type }), { headers: { 'Content-Type': type, 'Content-Length': String(size) } }))
    let savedCover = null
    const cover = resolveCoverUrl(track.cover_url)
    if (cover) {
      try {
        const image = await fetch(cover, { signal: controller.signal })
        if (image.ok && (image.headers.get('content-type') || '').startsWith('image/')) {
          await cache.put(coverUrl, image)
          savedCover = coverUrl
        }
      } catch { /* Audio remains useful even without artwork. */ }
    }
    if (controller.signal.aborted || run !== generation) throw new DOMException('Cancelled', 'AbortError')
    const entry = { key, audioUrl, bytes: size, savedAt: Date.now(), track: { ...track, cover_url: savedCover || track.cover_url } }
    await cache.put(metaUrl, new Response(JSON.stringify(entry), { headers: { 'Content-Type': 'application/json' } }))
    if (controller.signal.aborted || run !== generation) throw new DOMException('Cancelled', 'AbortError')
    useOfflineTracks.setState((state) => ({ tracks: [entry, ...state.tracks] }))
    // Collection metadata is saved before reporting that downloading finished.
    if (sync && syncLibrary) await syncLibrary().catch(() => {})
    import('../components/FullScreenPlayer').catch(() => {})
    navigator.storage?.persist?.().catch(() => {})
  } catch (error) {
    if (cache) await Promise.all([audioUrl, coverUrl, metaUrl].map((path) => cache.delete(path))).catch(() => {})
    if (error.name === 'QuotaExceededError') throw new Error('Недостаточно места. Удалите часть скачанных треков')
    throw error
  } finally {
    signal?.removeEventListener('abort', abort)
    if (run === generation) { active.delete(key); job(key, null) }
  }
}

export function cancelDownload(key) { active.get(key)?.abort() }

export const offlineArtistKey = (name) => `artist:${String(name || '').trim().toLocaleLowerCase()}`
export const offlinePlaylistKey = (playlist) => playlist?.is_liked && playlist?.download_source?.type !== 'artist' ? 'liked' : String(playlist?.id || '')
export function cancelPlaylistDownload(key) { activePlaylists.get(key)?.abort() }

function playlistJob(key, value) {
  useOfflineTracks.setState((state) => {
    const playlistJobs = { ...state.playlistJobs }
    if (value == null) delete playlistJobs[key]
    else playlistJobs[key] = value
    return { playlistJobs }
  })
}

async function waitForTrack(key, signal) {
  if (!useOfflineTracks.getState().jobs[key]) return
  await new Promise((resolve, reject) => {
    const finish = () => { stop(); signal.removeEventListener('abort', abort) }
    const abort = () => { finish(); reject(new DOMException('Cancelled', 'AbortError')) }
    const stop = useOfflineTracks.subscribe((state) => {
      if (!state.jobs[key]) { finish(); resolve() }
    })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    else if (!useOfflineTracks.getState().jobs[key]) { finish(); resolve() }
  })
}

export async function downloadPlaylist(playlist, token, client) {
  const key = offlinePlaylistKey(playlist)
  if (!owner) throw new Error('Войдите, чтобы скачивать плейлисты')
  if (!key) throw new Error('Плейлист недоступен для скачивания')
  if (activePlaylists.has(key)) return
  if (navigator.onLine === false) throw new Error('Для скачивания нужен интернет')
  if (!useOfflineTracks.getState().ready || !navigator.serviceWorker?.controller || typeof caches === 'undefined') {
    throw new Error('Перезапустите приложение для скачивания')
  }
  const run = generation
  const savedOwner = owner
  const controller = new AbortController()
  activePlaylists.set(key, controller)
  const status = { title: playlist.name, kind: playlist.download_source?.type === 'artist' ? 'artist' : 'playlist', completed: 0, total: null, failed: 0 }
  playlistJob(key, { ...status })
  const check = () => {
    if (controller.signal.aborted || run !== generation) throw new DOMException('Cancelled', 'AbortError')
  }
  try {
    // Fetch every page afresh: the screen may only have loaded the first one.
    const source = playlist.download_source
    const url = source?.type === 'soundcloud' ? `/soundcloud/playlists/${source.id}`
      : source?.type === 'album' ? `/albums/${source.source}/${source.id}`
      : source?.type === 'artist' ? '/artists'
      : source?.type === 'link' ? '/import/listen'
      : playlist.is_liked ? '/playlists/me/liked' : `/playlists/${playlist.id}`
    const tracks = new Map()
    let skip = 0
    let skipped = 0
    let snapshot = playlist
    for (;;) {
      check()
      const response = await client.get(url, {
        params: source?.type === 'link' ? { url: source.url, skip, limit: 100 }
          : source?.type === 'artist' ? { name: source.name, limit: 100 } : { skip, limit: 100 },
        signal: controller.signal, skipErrorToast: true,
        ...(source ? { timeout: 0 } : {}),
      })
      check()
      const page = source?.type === 'artist' ? [...(response.data.tracks || []), ...(response.data.external || [])] : response.data.tracks
      if (!skip) {
        const metadata = source?.type === 'soundcloud' ? response.data.playlist
          : source?.type === 'album' ? response.data.album : response.data
        snapshot = { ...playlist, ...metadata, id: playlist.id, name: metadata.name || metadata.title || playlist.name,
          is_liked: source?.type === 'artist' ? false : playlist.is_liked || metadata.is_liked,
          ...(source?.type === 'artist' ? { artist_is_liked: metadata.is_liked } : {}) }
      }
      for (const track of page) tracks.set(offlineTrackKey(track), track)
      if (source?.type === 'artist') break
      if (source?.type === 'soundcloud' || source?.type === 'album') {
        skipped = Math.max(0, (snapshot.track_count || page.length) - page.length)
        break
      }
      if (source?.type === 'link') {
        skipped += response.data.skipped || 0
        const next = response.data.next_offset
        if (next == null) break
        if (!Number.isInteger(next) || next <= skip) throw new Error('Не удалось догрузить плейлист. Попробуйте ещё раз')
        skip = next
        continue
      }
      skip += page.length
      const total = Number(response.headers['x-total-count'])
      if (Number.isFinite(total) && skip >= total) break
      if (page.length < 100) {
        if (total > skip) throw new Error('Плейлист изменился. Попробуйте скачать его ещё раз')
        break
      }
    }
    status.total = tracks.size
    if (!status.total) throw new Error(source?.type === 'artist' ? 'У артиста нет доступных треков' : 'В плейлисте нет треков')
    const metadata = { ...snapshot }
    delete metadata.tracks
    delete metadata.external
    delete metadata.next_offset
    if (source?.type === 'artist' && snapshot.cover_url) {
      try {
        const image = await fetch(resolveCoverUrl(snapshot.cover_url), { signal: controller.signal })
        if (image.ok && (image.headers.get('content-type') || '').startsWith('image/')) {
          const coverUrl = pathFor(savedOwner, key, 'collection-cover')
          const cache = await caches.open(OFFLINE_CACHE)
          check()
          await cache.put(coverUrl, image)
          metadata.cover_url = coverUrl
        }
      } catch (error) {
        check()
        if (error.name === 'QuotaExceededError') throw error
        // Track downloads remain useful when the artist portrait is unavailable.
      }
    }
    const collection = { ...metadata, skipped, track_keys: [...tracks.keys()] }
    await updateOfflineLibrary((library) => snapshot.is_liked
      ? { ...library, likedKeys: collection.track_keys }
      : { ...library, downloadedPlaylists: [...(library.downloadedPlaylists || []).filter((item) => String(item.id) !== String(snapshot.id)), collection] }, savedOwner)
    check()
    playlistJob(key, { ...status })
    const failures = []
    for (const [trackKey, track] of tracks) {
      check()
      try {
        await waitForTrack(trackKey, controller.signal)
        check()
        await downloadTrack(track, token, { signal: controller.signal, sync: false })
        check()
        if (!useOfflineTracks.getState().tracks.some((entry) => entry.key === trackKey)) throw new Error('Скачивание трека отменено')
      } catch (error) {
        check()
        failures.push({ title: track.title, message: error.message })
        status.failed++
        // Stop when continuing cannot help, keeping files already downloaded.
        if (navigator.onLine === false || /Недостаточно места/.test(error.message)) throw error
      }
      status.completed++
      playlistJob(key, { ...status })
    }
    if (syncLibrary) await syncLibrary().catch(() => {})
    check()
    return { total: status.total, saved: status.total - status.failed, failures, skipped }
  } catch (error) {
    check()
    if (error.name === 'QuotaExceededError') throw new Error('Недостаточно места. Удалите часть скачанных треков')
    throw error
  } finally {
    if (run === generation) { activePlaylists.delete(key); playlistJob(key, null) }
  }
}

export async function removeOfflineTrack(key) {
  const savedOwner = owner
  const run = generation
  const cache = await caches.open(OFFLINE_CACHE)
  await Promise.all(['audio', 'cover', 'meta'].map((kind) => cache.delete(pathFor(savedOwner, key, kind))))
  if (run === generation) useOfflineTracks.setState((state) => ({ tracks: state.tracks.filter((entry) => entry.key !== key) }))
}
