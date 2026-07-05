import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, Download, Heart, ListMusic, SkipBack, SkipForward, Play, Pause, Shuffle, Repeat1 } from 'lucide-react'
import { usePlayerStore } from '../store/playerStore'
import defaultCover from '../assets/default-cover.svg'
import { resolveCoverUrl } from '../utils/media'
import './FullScreenPlayer.css'

function FullScreenPlayer() {
  const {
    currentTrack,
    isPlaying,
    currentTime,
    duration,
    togglePlayPause,
    previousTrack,
    nextTrack,
    closeFullScreen,
    isRepeatOne,
    isShuffle,
    toggleRepeatOne,
    toggleShuffle,
    queue,
    currentIndex,
    likedTrackIds,
    fetchLikedTracks,
    toggleTrackLike,
    materializeCurrentTrack,
  } = usePlayerStore()
  const [loadingLike, setLoadingLike] = useState(false)
  const isExternalTrack = ['jamendo', 'soulseek', 'ytmusic'].includes(currentTrack?.source)
  const dbTrackId =
    currentTrack?.db_id ?? (typeof currentTrack?.id === 'number' ? currentTrack.id : null)
  const canInteract = dbTrackId !== null || isExternalTrack

  const progressPercent = useMemo(() => {
    if (!duration) return 0
    return Math.min(100, (currentTime / duration) * 100)
  }, [currentTime, duration])

  const coverUrl = useMemo(
    () => {
      if (isExternalTrack) {
        return currentTrack?.cover_url || defaultCover
      }
      return resolveCoverUrl(currentTrack?.cover_url) || defaultCover
    },
    [currentTrack?.cover_url, isExternalTrack],
  )

  useEffect(() => {
    const checkLikedStatus = async () => {
      if (!dbTrackId) return
      try {
        await fetchLikedTracks()
      } catch (error) {
        console.error('Error checking liked status:', error)
      }
    }

    checkLikedStatus()
  }, [dbTrackId, fetchLikedTracks])

  if (!currentTrack) return null

  const formatTime = (seconds) => {
    if (!seconds || isNaN(seconds)) return '0:00'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const handleLike = async () => {
    if (!canInteract || loadingLike) return

    setLoadingLike(true)
    try {
      const id = dbTrackId ?? (await materializeCurrentTrack())
      if (id) await toggleTrackLike(id)
    } catch (error) {
      console.error('Error toggling like:', error)
    } finally {
      setLoadingLike(false)
    }
  }

  const isLiked = dbTrackId ? likedTrackIds.includes(dbTrackId) : false
  const queueLabel = queue.length > 1 ? `${currentIndex + 1} из ${queue.length}` : 'Трек'

  return (
    <div className="fullscreen-player">
      <div className="fullscreen-header">
        <button className="fullscreen-icon" onClick={closeFullScreen} aria-label="Закрыть">
          <ChevronDown size={22} />
        </button>
        <div className="fullscreen-title">
          <div className="fullscreen-subtitle">{queueLabel}</div>
          <div className="fullscreen-track">{currentTrack.title}</div>
        </div>
        <button className="fullscreen-icon" type="button" aria-label="Очередь">
          <ListMusic size={20} />
        </button>
      </div>

      <div className="fullscreen-art">
        <img src={coverUrl} alt={currentTrack.title} />
      </div>

      <div className="fullscreen-info">
        <div>
          <div className="fullscreen-track-name">{currentTrack.title}</div>
          <div className="fullscreen-artist">{currentTrack.artist}</div>
        </div>
        <div className="fullscreen-actions">
          {canInteract && (
            <button
              type="button"
              className={`fullscreen-icon fullscreen-like ${isLiked ? 'active' : ''}`}
              onClick={handleLike}
              disabled={loadingLike}
              aria-label={isLiked ? 'Убрать из понравившихся' : 'Добавить в понравившиеся'}
            >
              <Heart size={20} fill={isLiked ? 'currentColor' : 'none'} />
            </button>
          )}
          {isExternalTrack && currentTrack.download_allowed && currentTrack.download_url && (
            <a
              className="fullscreen-icon"
              href={currentTrack.download_url}
              target="_blank"
              rel="noreferrer"
              aria-label="Скачать"
            >
              <Download size={20} />
            </a>
          )}
        </div>
      </div>

      <div className="fullscreen-progress">
        <div className="fullscreen-progress-bar">
          <div className="fullscreen-progress-fill" style={{ width: `${progressPercent}%` }} />
        </div>
        <div className="fullscreen-progress-time">
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      <div className="fullscreen-controls">
        <button
          type="button"
          className={`fullscreen-icon ${isShuffle ? 'active' : ''}`}
          onClick={toggleShuffle}
          aria-label={isShuffle ? 'Выключить случайный порядок' : 'Случайный порядок'}
        >
          <Shuffle size={20} />
        </button>
        <button className="fullscreen-icon" onClick={previousTrack} aria-label="Назад">
          <SkipBack size={20} />
        </button>
        <button className="fullscreen-play" onClick={togglePlayPause} aria-label="Play/Pause">
          {isPlaying ? <Pause size={24} /> : <Play size={24} />}
        </button>
        <button className="fullscreen-icon" onClick={nextTrack} aria-label="Вперёд">
          <SkipForward size={20} />
        </button>
        <button
          type="button"
          className={`fullscreen-icon ${isRepeatOne ? 'active' : ''}`}
          onClick={toggleRepeatOne}
          aria-label={isRepeatOne ? 'Выключить повтор трека' : 'Повторять трек'}
        >
          <Repeat1 size={20} />
        </button>
      </div>
    </div>
  )
}

export default FullScreenPlayer
