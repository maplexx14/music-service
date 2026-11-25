import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Download, Play, Pause, Trash2, X } from '@/components/icons'
import { useOfflineTracks, cancelDownload, cancelPlaylistDownload, removeOfflineTrack } from '../services/offlineTracks'
import { isOffline } from '../services/connectivity'
import DownloadProgress from '../components/DownloadProgress'
import { usePlayerStore } from '../store/playerStore'
import { toast } from '../store/toastStore'
import { resolveCoverUrl, handleCoverError } from '../utils/media'
import defaultCover from '../assets/default-cover.webp'
import './Downloads.css'

export default function Downloads() {
  const { tracks, jobs, playlistJobs, ready, error } = useOfflineTracks()
  const currentTrack = usePlayerStore((state) => state.currentTrack)
  const isPlaying = usePlayerStore((state) => state.isPlaying)
  useEffect(() => {
    // Warm the player while online, so its controls can also open offline.
    if (!isOffline()) import('../components/FullScreenPlayer').catch(() => {})
  }, [])
  const queue = tracks.map((entry) => entry.track)
  const bytes = tracks.reduce((sum, entry) => sum + entry.bytes, 0)
  const play = (track) => {
    const player = usePlayerStore.getState()
    if (currentTrack?.id === track.id) player.togglePlayPause('offline')
    else player.playTrack(track, queue, 'offline')
  }
  return (
    <div className="page-container downloads-page">
      <div className="downloads-heading">
        <h1>Скачанные</h1>
        <Link to="/playlists" className="btn btn--secondary">Медиатека</Link>
      </div>
      <p className="downloads-description">{tracks.length} треков · {(bytes / 1024 / 1024).toFixed(1)} МБ на этом устройстве. Можно слушать без интернета.</p>
      {error && <p role="alert">{error}</p>}
      {!ready && <p role="status">Загрузка скачанных треков…</p>}
      <div className="downloads-list">
        {Object.entries(playlistJobs).map(([key, item]) => (
          <div className="downloads-row" key={`playlist:${key}`}>
            <Download size={24} />
            <div className="downloads-track"><strong>{item.title}</strong><span role="status">{item.total == null ? (item.kind === 'artist' ? 'Подготовка треков артиста…' : 'Подготовка плейлиста…') : `Скачивание ${item.kind === 'artist' ? 'треков артиста' : 'плейлиста'}: ${item.completed} из ${item.total}${item.failed ? ` · Ошибок: ${item.failed}` : ''}`}</span>
              <DownloadProgress value={item.total == null ? null : item.completed / item.total * 100} className="download-progress--row" label={item.title} />
            </div>
            <button className="downloads-action" onClick={() => cancelPlaylistDownload(key)} aria-label={`Отменить скачивание ${item.kind === 'artist' ? 'треков артиста' : 'плейлиста'} ${item.title}`}><X size={20} /></button>
          </div>
        ))}
        {Object.entries(jobs).map(([key, item]) => (
          <div className="downloads-row" key={key}>
            <Download size={24} />
            <div className="downloads-track"><strong>{item.title}</strong><span role="status">Скачивание{item.progress == null ? '…' : `: ${item.progress}%`}</span>
              <DownloadProgress value={item.progress} className="download-progress--row" label={item.title} />
            </div>
            <button className="downloads-action" onClick={() => cancelDownload(key)} aria-label={`Отменить скачивание ${item.title}`}><X size={20} /></button>
          </div>
        ))}
        {tracks.map(({ key, track }) => {
          const playing = currentTrack?.id === track.id && isPlaying
          return (
            <div className="downloads-row" key={key}>
              <button className="downloads-play" onClick={() => play(track)} aria-label={`${playing ? 'Приостановить' : 'Слушать'} ${track.title}`}>
                <img src={resolveCoverUrl(track.cover_url) || defaultCover} alt="" onError={handleCoverError} />
                {playing ? <Pause size={20} /> : <Play size={20} />}
              </button>
              <button className="downloads-track" onClick={() => play(track)}><strong>{track.title}</strong><span>{track.artist || 'Неизвестный исполнитель'}</span></button>
              <button className="downloads-action" onClick={() => removeOfflineTrack(key).catch(() => toast.error('Не удалось удалить скачанный трек'))} aria-label={`Удалить скачанный трек ${track.title}`}><Trash2 size={20} /></button>
            </div>
          )
        })}
      </div>
      {ready && !tracks.length && !Object.keys(jobs).length && !Object.keys(playlistJobs).length && <div className="downloads-empty"><Download size={40} /><p>Скачанных треков пока нет</p><p>Нажмите «Скачать» на странице плейлиста или артиста либо выберите «Скачать для офлайн» в меню трека.</p></div>}
    </div>
  )
}
