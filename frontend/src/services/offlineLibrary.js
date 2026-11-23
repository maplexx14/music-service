import { API_URL } from '../config'
import { downloadedTracks, getOfflineOwner, offlineArtistKey, offlineTrackKey, updateOfflineLibrary, useOfflineTracks } from './offlineTracks'

export function offlineCollections(state = useOfflineTracks.getState()) {
  const byKey = new Map(state.tracks.map((entry) => [offlineTrackKey(entry.track), entry.track]))
  const select = (keys) => [...new Set(keys || [])].flatMap((key) => byKey.has(key) ? [byKey.get(key)] : [])
  const collections = new Map([...(state.library?.downloadedPlaylists || []), ...(state.library?.playlists || [])].map((playlist) => [String(playlist.id), playlist]))
  const playlists = [...collections.values()].flatMap((playlist) => {
    const tracks = select(playlist.track_keys)
    if (!tracks.length) return []
    return [{ ...playlist, tracks, track_count: tracks.length, cover_url: playlist.download_source?.type === 'artist'
      ? playlist.cover_url || tracks[0].cover_url : tracks[0].cover_url || playlist.cover_url }]
  })
  const likedTracks = select(state.library?.likedKeys)
  return { tracks: [...byKey.values()], playlists, liked: { id: 'offline-liked', name: 'Понравившиеся', is_liked: true, tracks: likedTracks, track_count: likedTracks.length, cover_url: null } }
}

export function offlineArtist(name, state = useOfflineTracks.getState()) {
  const { tracks, playlists } = offlineCollections(state)
  const saved = playlists.find((item) => item.id === offlineArtistKey(name))
  const artistTracks = saved?.tracks || tracks.filter((track) => (track.artist || '').toLocaleLowerCase().includes(name.trim().toLocaleLowerCase()))
  const albums = (saved?.albums || []).filter((album) => playlists.some((item) => item.id === `album:${album.source}:${album.external_id}`))
  return { ...saved, name: saved?.name || name, tracks: artistTracks, external: [], albums, related_artists: [],
    cover_url: saved?.cover_url || artistTracks[0]?.cover_url || null, is_liked: saved?.artist_is_liked || false }
}

let pendingSync = null
export async function syncOfflineLibrary(client) {
  const owner = getOfflineOwner()
  const state = useOfflineTracks.getState()
  if (!owner || !state.ready || navigator.onLine === false || !state.tracks.length) return
  if (pendingSync?.owner === owner) {
    await pendingSync.promise
    if (pendingSync?.owner === owner) return
  }
  const request = { owner }
  request.promise = (async () => {
    const response = await client.post('/playlists/me/offline-library', {
      tracks: useOfflineTracks.getState().tracks.map(({ track }) => ({ id: String(track.id), db_id: track.db_id || null, source: track.source || null, external_id: track.external_id || null })),
    }, { skipErrorToast: true, skipAuthRedirect: true })
    if (getOfflineOwner() !== owner || !response.data?.playlists || !response.data?.likedKeys) return
    await updateOfflineLibrary((library) => ({ ...response.data, downloadedPlaylists: library.downloadedPlaylists || [] }), owner)
  })().finally(() => { if (pendingSync === request) pendingSync = null })
  pendingSync = request
  return request.promise
}

function pathAndParams(url, params) {
  const full = new URL(url, new URL(API_URL.replace(/\/$/, '') + '/', window.location.href))
  const apiPath = new URL(API_URL, window.location.href).pathname.replace(/\/$/, '')
  const path = full.pathname.startsWith(apiPath + '/') ? full.pathname.slice(apiPath.length) : full.pathname
  return { path: path.replace(/\/$/, '') || '/', params: new URLSearchParams([...full.searchParams, ...new URLSearchParams(params || {})]) }
}

export function hasOfflineData(url) {
  const { path } = pathAndParams(url)
  return /^\/(recommendations|playlists|search|artists|albums|import\/search|tracks(?:\/me\/(?:liked|history|disliked)|\/[0-9a-f-]{36}|$)|home)(?:\/|$)/.test(path)
}

async function readyLibrary() {
  if (useOfflineTracks.getState().ready) return
  await new Promise((resolve) => {
    const stop = useOfflineTracks.subscribe((state) => { if (state.ready) { stop(); resolve() } })
    if (useOfflineTracks.getState().ready) { stop(); resolve() }
  })
}

export function randomOfflineTracks(exclude = [], random = Math.random) {
  const keys = new Set(exclude)
  const tracks = downloadedTracks().filter((track) => !keys.has(track.id) && !keys.has(offlineTrackKey(track)))
  for (let i = tracks.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[tracks[i], tracks[j]] = [tracks[j], tracks[i]]
  }
  return tracks
}

export async function offlineApiResponse(url, config = {}) {
  await readyLibrary()
  if (config.signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
  const { path, params } = pathAndParams(url, config.params)
  const { tracks, playlists, liked } = offlineCollections()
  const page = (items) => items.slice(Number(params.get('skip')) || 0, (Number(params.get('skip')) || 0) + (Number(params.get('limit')) || items.length))
  const q = (params.get('q') || params.get('name') || '').trim().toLocaleLowerCase()
  const matches = (track) => `${track.title} ${track.artist} ${track.album || ''}`.toLocaleLowerCase().includes(q)
  let data = []
  let total = 0
  if (path === '/recommendations/flow') {
    const exclude = (params.get('exclude') || '').split(',').filter(Boolean)
    data = page(randomOfflineTracks(exclude))
  } else if (path === '/recommendations') data = { tracks: page(tracks), playlists }
  else if (path === '/playlists/me' || path === '/playlists') data = playlists
  else if (path === '/playlists/me/liked' || /^\/playlists\/[^/]+$/.test(path)) {
    const playlist = path === '/playlists/me/liked' ? liked : playlists.find((item) => String(item.id) === path.split('/').pop())
    if (!playlist) { const error = new Error('В этом плейлисте нет скачанных треков'); error.response = { status: 404 }; throw error }
    total = playlist.tracks.length
    data = { ...playlist, tracks: page(playlist.tracks) }
  } else if (path === '/tracks/me/liked/ids') data = liked.tracks.map((track) => track.db_id || track.id)
  else if (path === '/tracks/me/liked') data = page(liked.tracks)
  else if (path === '/tracks/me/history') data = page(tracks)
  else if (path === '/search') data = { tracks: page(tracks.filter(matches)), playlists: playlists.filter((item) => item.name.toLocaleLowerCase().includes(q)) }
  else if (path === '/artists') data = offlineArtist(params.get('name') || '')
  else if (path.startsWith('/albums/')) {
    const albumTracks = tracks.filter((track) => String(track.album_id || track.album) === decodeURIComponent(path.split('/').pop()))
    data = { album: { title: albumTracks[0]?.album || 'Альбом', artist: albumTracks[0]?.artist, cover_url: albumTracks[0]?.cover_url }, tracks: albumTracks }
  } else if (path === '/tracks') data = page(tracks.filter(matches))
  else if (/^\/tracks\/[0-9a-f-]{36}$/.test(path)) data = tracks.find((track) => track.id === path.split('/').pop() || track.db_id === path.split('/').pop()) || null
  else if (path === '/search/external') data = { top: [], ytmusic: [], soundcloud: [], jamendo: [], soulseek: [] }
  return { data, status: 200, statusText: 'OK', headers: { 'x-total-count': String(total || (Array.isArray(data) ? data.length : 0)) }, config, offline: true }
}
