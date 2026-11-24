import { Download, Check, X } from '@/components/icons'
import { useAuthStore } from '../store/authStore'
import { toast } from '../store/toastStore'
import api from '../services/api'
import { useOffline } from '../hooks/useOffline'
import { useOfflineTracks, offlineTrackKey, offlinePlaylistKey, downloadPlaylist, cancelPlaylistDownload } from '../services/offlineTracks'
import './OfflinePlaylistDownloadButton.css'

export default function OfflinePlaylistDownloadButton({ playlist, totalTracks }) {
  const authenticated = useAuthStore((state) => state.isAuthenticated)
  const { tracks, library, playlistJobs, ready } = useOfflineTracks()
  const offline = useOffline()
  const key = offlinePlaylistKey(playlist)
  if (!authenticated || !key) return null
  const job = playlistJobs[key]
  const artist = playlist.download_source?.type === 'artist'
  const savedKeys = new Set(tracks.map((entry) => entry.key))
  const collection = [...(library.downloadedPlaylists || []), ...(library.playlists || [])].find((item) => String(item.id) === String(playlist.id))
  const keys = playlist.is_liked ? library.likedKeys : collection?.track_keys || playlist.tracks?.map(offlineTrackKey) || []
  const saved = totalTracks > 0 && keys.length + (collection?.skipped || 0) >= totalTracks && keys.every((trackKey) => savedKeys.has(trackKey))
    && (playlist.tracks || []).every((track) => savedKeys.has(offlineTrackKey(track)))
  const progress = job ? (job.total == null ? 'Подготовка…' : `${job.completed}/${job.total}`) : ''
  const label = artist
    ? job ? `Отменить скачивание треков артиста (${progress})` : saved ? 'Обновить скачанные треки артиста' : 'Скачать треки артиста для офлайн'
    : job ? `Отменить скачивание плейлиста (${progress})` : saved ? 'Обновить скачанный плейлист' : 'Скачать плейлист для офлайн'
  const onClick = (event) => {
    event.stopPropagation()
    if (job) { cancelPlaylistDownload(key); return }
    downloadPlaylist(playlist, useAuthStore.getState().token, api).then((result) => {
      if (!result) return
      if (result.failures.length) toast.error(`Скачано ${result.saved} из ${result.total}. ${result.failures[0].title}: ${result.failures[0].message}. Нажмите скачать, чтобы повторить`)
      else if (result.skipped) toast.error(`Скачано ${result.saved} треков. Не удалось найти: ${result.skipped}`)
      else toast.success(artist ? 'Треки артиста доступны офлайн' : 'Плейлист доступен офлайн')
    }).catch((error) => {
      if (error.name !== 'AbortError') toast.error(error.message || (artist ? 'Не удалось скачать треки артиста' : 'Не удалось скачать плейлист'))
    })
  }
  return <button type="button"
    className={`btn btn--ghost btn--lg playlist-action-icon round-actions__icon playlist-download-button${saved ? ' active' : ''}`}
    onClick={onClick} disabled={!job && (!ready || !totalTracks || offline)} title={label} aria-label={label}>
    {job ? <X size={20} /> : saved ? <Check size={20} /> : <Download size={20} />}
  </button>
}
