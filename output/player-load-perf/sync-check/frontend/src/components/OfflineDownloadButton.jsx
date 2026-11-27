import { Download, Check, X } from '@/components/icons'
import { useAuthStore } from '../store/authStore'
import { toast } from '../store/toastStore'
import { useOfflineTracks, offlineTrackKey, downloadTrack, removeOfflineTrack, cancelDownload } from '../services/offlineTracks'

export default function OfflineDownloadButton({ track, className, size = 22 }) {
  const authenticated = useAuthStore((state) => state.isAuthenticated)
  const { tracks, jobs } = useOfflineTracks()
  const key = offlineTrackKey(track)
  const saved = tracks.some((entry) => entry.key === key)
  const downloading = jobs[key]
  if (!authenticated || !key) return null
  const label = saved ? 'Удалить скачанный трек' : downloading ? `Отменить скачивание${downloading.progress == null ? '' : ` (${downloading.progress}%)`}` : 'Скачать для офлайн'
  const onClick = (event) => {
    event.stopPropagation()
    if (downloading) { cancelDownload(key); return }
    const action = saved ? removeOfflineTrack(key) : downloadTrack(track, useAuthStore.getState().token)
    action.then(() => toast.success(saved ? 'Скачанный трек удалён' : 'Трек доступен офлайн')).catch((error) => {
      if (error.name !== 'AbortError') toast.error(error.message || 'Не удалось скачать трек')
    })
  }
  return <button type="button" className={`${className}${saved ? ' active' : ''}`} onClick={onClick} aria-label={label} title={label}>
    {saved ? <Check size={size} /> : downloading ? <X size={size} /> : <Download size={size} />}
  </button>
}
