import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Download, Heart, ListMusic, SkipBack, SkipForward, Play, Pause, Shuffle, Repeat1 } from 'lucide-react'
import { usePlayerStore } from '../store/playerStore'
import defaultCover from '../assets/default-cover.png'
import { resolveCoverUrl, handleCoverError, upscaleCover } from '../utils/media'
import './FullScreenPlayer.css'

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

// Прогресс-блок вынесен в отдельный компонент: только он подписан на
// currentTime (тикает ~4 раза/сек). Остальной полноэкранный плеер (обложка,
// кнопки, жесты) не перерисовывается на каждом тике воспроизведения.
function FullScreenProgress() {
  const currentTime = usePlayerStore((s) => s.currentTime)
  const duration = usePlayerStore((s) => s.duration)
  const seekTo = usePlayerStore((s) => s.seekTo)

  const progressPercent = duration ? Math.min(100, (currentTime / duration) * 100) : 0

  const handleSeek = (e) => {
    if (!duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    seekTo(ratio * duration)
  }

  return (
    <div className="fullscreen-progress">
      <div
        className="fullscreen-progress-bar"
        onClick={handleSeek}
        role="slider"
        aria-label="Перемотка"
        aria-valuemin={0}
        aria-valuemax={Math.floor(duration || 0)}
        aria-valuenow={Math.floor(currentTime || 0)}
      >
        <div className="fullscreen-progress-fill" style={{ width: `${progressPercent}%` }} />
      </div>
      <div className="fullscreen-progress-time">
        <span>{formatTime(currentTime)}</span>
        <span>{formatTime(duration)}</span>
      </div>
    </div>
  )
}

function FullScreenPlayer() {
  // Атомарные селекторы вместо подписки на весь store — без currentTime/
  // duration, чтобы компонент не перерисовывался на каждом тике
  // воспроизведения (см. FullScreenProgress выше).
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const togglePlayPause = usePlayerStore((s) => s.togglePlayPause)
  const previousTrack = usePlayerStore((s) => s.previousTrack)
  const nextTrack = usePlayerStore((s) => s.nextTrack)
  const closeFullScreen = usePlayerStore((s) => s.closeFullScreen)
  const isRepeatOne = usePlayerStore((s) => s.isRepeatOne)
  const isShuffle = usePlayerStore((s) => s.isShuffle)
  const toggleRepeatOne = usePlayerStore((s) => s.toggleRepeatOne)
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle)
  const queue = usePlayerStore((s) => s.queue)
  const currentIndex = usePlayerStore((s) => s.currentIndex)
  const likedTrackIds = usePlayerStore((s) => s.likedTrackIds)
  const fetchLikedTracks = usePlayerStore((s) => s.fetchLikedTracks)
  const toggleTrackLike = usePlayerStore((s) => s.toggleTrackLike)
  const materializeCurrentTrack = usePlayerStore((s) => s.materializeCurrentTrack)
  const [loadingLike, setLoadingLike] = useState(false)
  const [dragY, setDragY] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const gestureRef = useRef(null)

  // Тач-жесты (только сенсорные экраны — обработчики через onTouch*):
  //  • свайп вниз «прилипает» к пальцу и закрывает плеер при достаточном сдвиге;
  //  • горизонтальный свайп по любому месту (включая обложку) меняет трек.
  // Ось жеста фиксируется по первому заметному сдвигу, чтобы вертикальное
  // перетаскивание не путалось с горизонтальным переключением.
  const handleTouchStart = (e) => {
    if (e.touches.length !== 1) return
    const t = e.touches[0]
    gestureRef.current = { x: t.clientX, y: t.clientY, axis: null }
  }

  const handleTouchMove = (e) => {
    const g = gestureRef.current
    if (!g) return
    const t = e.touches[0]
    const dx = t.clientX - g.x
    const dy = t.clientY - g.y
    if (!g.axis && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
      g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
      if (g.axis === 'y') setIsDragging(true)
    }
    // Тянем вниз — двигаем плеер за пальцем (вверх не уводим).
    if (g.axis === 'y' && dy > 0) setDragY(dy)
  }

  const handleTouchEnd = (e) => {
    const g = gestureRef.current
    if (!g) return
    const t = e.changedTouches[0]
    const dx = t.clientX - g.x
    const dy = t.clientY - g.y
    gestureRef.current = null
    setIsDragging(false)
    setDragY(0)
    if (g.axis === 'x' && Math.abs(dx) >= 60) {
      if (dx < 0) nextTrack()
      else previousTrack()
    } else if (g.axis === 'y' && dy >= 120) {
      closeFullScreen()
    }
  }

  const isExternalTrack = ['jamendo', 'soulseek', 'ytmusic', 'soundcloud'].includes(currentTrack?.source)
  const dbTrackId =
    currentTrack?.db_id ?? (typeof currentTrack?.id === 'number' ? currentTrack.id : null)
  const canInteract = dbTrackId !== null || isExternalTrack

  const coverUrl = useMemo(
    () => {
      if (isExternalTrack) {
        return upscaleCover(currentTrack?.cover_url) || defaultCover
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

  // Лёгкое затемнение по мере перетаскивания вниз — визуальный отклик жеста.
  const dragOpacity = Math.max(0.4, 1 - dragY / 700)

  return (
    <div
      className="fullscreen-player"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      style={{
        transform: dragY ? `translateY(${dragY}px)` : undefined,
        opacity: dragY ? dragOpacity : undefined,
        transition: isDragging ? 'none' : 'transform 0.3s ease, opacity 0.3s ease',
      }}
    >
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
        <img src={coverUrl} alt={currentTrack.title} onError={handleCoverError} />
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

      <FullScreenProgress />

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
