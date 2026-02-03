import { useMemo } from 'react'
import { X, Heart, Share2, MoreHorizontal, SkipBack, SkipForward, Play, Pause } from 'lucide-react'
import { usePlayerStore } from '../store/playerStore'
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
  } = usePlayerStore()

  const progressPercent = useMemo(() => {
    if (!duration) return 0
    return Math.min(100, (currentTime / duration) * 100)
  }, [currentTime, duration])

  if (!currentTrack) return null

  const formatTime = (seconds) => {
    if (!seconds || isNaN(seconds)) return '0:00'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  return (
    <div className="fullscreen-player">
      <div className="fullscreen-header">
        <button className="fullscreen-icon" onClick={closeFullScreen} aria-label="Закрыть">
          <X size={18} />
        </button>
        <div className="fullscreen-title">
          <div className="fullscreen-subtitle">Сейчас играет</div>
          <div className="fullscreen-track">{currentTrack.title}</div>
        </div>
        <button className="fullscreen-icon" aria-label="Меню">
          <MoreHorizontal size={18} />
        </button>
      </div>

      <div className="fullscreen-art">
        {currentTrack.cover_url ? (
          <img src={currentTrack.cover_url} alt={currentTrack.title} />
        ) : (
          <div className="fullscreen-art-placeholder">♪</div>
        )}
      </div>

      <div className="fullscreen-info">
        <div>
          <div className="fullscreen-track-name">{currentTrack.title}</div>
          <div className="fullscreen-artist">{currentTrack.artist}</div>
        </div>
        <div className="fullscreen-actions">
          <button className="fullscreen-icon" aria-label="Нравится">
            <Heart size={18} />
          </button>
          <button className="fullscreen-icon" aria-label="Поделиться">
            <Share2 size={18} />
          </button>
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
        <button className="fullscreen-icon" onClick={previousTrack} aria-label="Назад">
          <SkipBack size={22} />
        </button>
        <button className="fullscreen-play" onClick={togglePlayPause} aria-label="Play/Pause">
          {isPlaying ? <Pause size={22} /> : <Play size={22} />}
        </button>
        <button className="fullscreen-icon" onClick={nextTrack} aria-label="Вперёд">
          <SkipForward size={22} />
        </button>
      </div>
    </div>
  )
}

export default FullScreenPlayer
