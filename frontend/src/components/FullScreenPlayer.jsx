import { useMemo, useRef, useState, useEffect, useCallback } from 'react'
import { X, Heart, SkipBack, SkipForward, Play, Pause, Shuffle, Repeat } from 'lucide-react'
import { usePlayerStore } from '../store/playerStore'
import api from '../services/api'
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
    setCurrentTime,
  } = usePlayerStore()

  const progressBarRef = useRef(null)
  const [isDragging, setIsDragging] = useState(false)
  const [dragTime, setDragTime] = useState(0)
  const [isLiked, setIsLiked] = useState(false)
  const [loadingLike, setLoadingLike] = useState(false)

  const displayTime = isDragging ? dragTime : currentTime

  const progressPercent = useMemo(() => {
    if (!duration) return 0
    return Math.min(100, (displayTime / duration) * 100)
  }, [displayTime, duration])

  useEffect(() => {
    if (!currentTrack) return
    api.get('/tracks/me/liked')
      .then(res => setIsLiked(res.data.some(t => t.id === currentTrack.id)))
      .catch(() => {})
  }, [currentTrack?.id])

  const handleToggleLike = async () => {
    if (!currentTrack || loadingLike) return
    setLoadingLike(true)
    try {
      if (isLiked) {
        await api.delete(`/tracks/${currentTrack.id}/like`)
        setIsLiked(false)
      } else {
        await api.post(`/tracks/${currentTrack.id}/like`)
        setIsLiked(true)
      }
    } catch (err) {
      console.error('Error toggling like:', err)
    } finally {
      setLoadingLike(false)
    }
  }

  const getAudioElement = () => document.querySelector('audio')

  const calcTimeFromEvent = useCallback((e) => {
    const bar = progressBarRef.current
    if (!bar || !duration) return 0
    const rect = bar.getBoundingClientRect()
    const clientX = e.touches ? e.touches[0].clientX : e.clientX
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width))
    return (x / rect.width) * duration
  }, [duration])

  const handleSeekStart = useCallback((e) => {
    e.preventDefault()
    setIsDragging(true)
    setDragTime(calcTimeFromEvent(e))
  }, [calcTimeFromEvent])

  useEffect(() => {
    if (!isDragging) return

    const handleMove = (e) => {
      e.preventDefault()
      setDragTime(calcTimeFromEvent(e))
    }

    const handleEnd = (e) => {
      const finalTime = calcTimeFromEvent(e.changedTouches ? e : e)
      const audio = getAudioElement()
      if (audio) {
        audio.currentTime = finalTime
      }
      setCurrentTime(finalTime)
      setIsDragging(false)
    }

    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleEnd)
    window.addEventListener('touchmove', handleMove, { passive: false })
    window.addEventListener('touchend', handleEnd)

    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleEnd)
      window.removeEventListener('touchmove', handleMove)
      window.removeEventListener('touchend', handleEnd)
    }
  }, [isDragging, calcTimeFromEvent, setCurrentTime])

  const handleBarClick = (e) => {
    if (isDragging) return
    const newTime = calcTimeFromEvent(e)
    const audio = getAudioElement()
    if (audio) {
      audio.currentTime = newTime
    }
    setCurrentTime(newTime)
  }

  if (!currentTrack) return null

  const formatTime = (seconds) => {
    if (!seconds || isNaN(seconds)) return '0:00'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const coverSrc = resolveCoverUrl(currentTrack.cover_url) || defaultCover

  return (
    <div className="fullscreen-player">
      <div className="fullscreen-header">
        <button className="fullscreen-close-btn" onClick={closeFullScreen} aria-label="Закрыть">
          <X size={22} />
        </button>
        <div className="fullscreen-title">
          <div className="fullscreen-subtitle">Сейчас играет</div>
        </div>
        <div style={{ width: 40 }} />
      </div>

      <div className="fullscreen-art">
        <img src={coverSrc} alt={currentTrack.title} />
      </div>

      <div className="fullscreen-bottom">
        <div className="fullscreen-info">
          <div className="fullscreen-info-text">
            <div className="fullscreen-track-name">{currentTrack.title}</div>
            <div className="fullscreen-artist">{currentTrack.artist}</div>
          </div>
          <button
            className={`fullscreen-like-btn ${isLiked ? 'liked' : ''}`}
            onClick={handleToggleLike}
            disabled={loadingLike}
            aria-label={isLiked ? 'Убрать из понравившихся' : 'Добавить в понравившиеся'}
          >
            <Heart size={24} fill={isLiked ? 'currentColor' : 'none'} />
          </button>
        </div>

        <div className="fullscreen-progress">
          <div
            className="fullscreen-progress-bar"
            ref={progressBarRef}
            onClick={handleBarClick}
            onMouseDown={handleSeekStart}
            onTouchStart={handleSeekStart}
          >
            <div className="fullscreen-progress-fill" style={{ width: `${progressPercent}%` }}>
              <div className="fullscreen-progress-thumb" />
            </div>
          </div>
          <div className="fullscreen-progress-time">
            <span>{formatTime(displayTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>

        <div className="fullscreen-controls">
          <button
            type="button"
            className={`fullscreen-ctrl-btn ${isShuffle ? 'active' : ''}`}
            onClick={toggleShuffle}
            aria-label="Случайный порядок"
          >
            <Shuffle size={22} />
          </button>
          <button className="fullscreen-ctrl-btn" onClick={previousTrack} aria-label="Назад">
            <SkipBack size={26} fill="currentColor" />
          </button>
          <button className="fullscreen-play-btn" onClick={togglePlayPause} aria-label="Play/Pause">
            {isPlaying ? <Pause size={30} fill="currentColor" /> : <Play size={30} fill="currentColor" />}
          </button>
          <button className="fullscreen-ctrl-btn" onClick={nextTrack} aria-label="Вперёд">
            <SkipForward size={26} fill="currentColor" />
          </button>
          <button
            type="button"
            className={`fullscreen-ctrl-btn ${isRepeatOne ? 'active' : ''}`}
            onClick={toggleRepeatOne}
            aria-label="Повтор"
          >
            <Repeat size={22} />
          </button>
        </div>
      </div>
    </div>
  )
}

export default FullScreenPlayer
