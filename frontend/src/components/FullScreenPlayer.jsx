import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Download, Heart, ListMusic, SkipBack, SkipForward, Play, Pause, Shuffle, Repeat1, ThumbsDown, AlignLeft, X } from 'lucide-react'
import {
  invalidateFlowPreload,
  postRecommendationEvent,
  usePlayerStore,
} from '../store/playerStore'
import { useLyrics } from '../hooks/useLyrics'
import defaultCover from '../assets/default-cover.webp'
import { resolveCoverUrl, handleCoverError } from '../utils/media'
import LyricsPanel from './LyricsPanel'
import ArtistLink from './ArtistLink'
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
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const togglePlayPause = usePlayerStore((s) => s.togglePlayPause)
  const previousTrack = usePlayerStore((s) => s.previousTrack)
  const nextTrack = usePlayerStore((s) => s.nextTrack)
  const resolvedPrefetchVersion = usePlayerStore((s) => s.resolvedPrefetchVersion)
  const closeFullScreen = usePlayerStore((s) => s.closeFullScreen)
  const isRepeatOne = usePlayerStore((s) => s.isRepeatOne)
  const isShuffle = usePlayerStore((s) => s.isShuffle)
  const toggleRepeatOne = usePlayerStore((s) => s.toggleRepeatOne)
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle)
  const likedTrackIds = usePlayerStore((s) => s.likedTrackIds)
  const fetchLikedTracks = usePlayerStore((s) => s.fetchLikedTracks)
  const toggleTrackLike = usePlayerStore((s) => s.toggleTrackLike)
  const dislikedTrackIds = usePlayerStore((s) => s.dislikedTrackIds)
  const fetchDislikedTracks = usePlayerStore((s) => s.fetchDislikedTracks)
  const toggleTrackDislike = usePlayerStore((s) => s.toggleTrackDislike)
  const materializeCurrentTrack = usePlayerStore((s) => s.materializeCurrentTrack)
  const karaokeMode = usePlayerStore((s) => s.karaokeMode)
  const [loadingLike, setLoadingLike] = useState(false)
  const [loadingDislike, setLoadingDislike] = useState(false)
  const [dragY, setDragY] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const [lyricsMode, setLyricsMode] = useState(false)
  const gestureRef = useRef(null)

  // Keep the initial layout in sync with the way fullscreen was opened.
  // Karaoke mode always starts with lyrics; a plain cover click always resets them.
  useEffect(() => {
    setLyricsMode(Boolean(karaokeMode))
  }, [karaokeMode])

  const { syncedLines, plainText, loading: lyricsLoading } = useLyrics(currentTrack)
  const hasLyrics = syncedLines.length > 0 || plainText.length > 0

  const startClose = () => {
    if (isClosing) return
    setIsClosing(true)
    setTimeout(closeFullScreen, 350)
  }

  const handleTouchStart = (e) => {
    if (e.touches.length !== 1) return
    const t = e.touches[0]
    gestureRef.current = { x: t.clientX, y: t.clientY, axis: null, t0: performance.now() }
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
    if (g.axis === 'y' && dy > 0) setDragY(dy)
  }

  const handleTouchEnd = (e) => {
    const g = gestureRef.current
    if (!g) return
    const t = e.changedTouches[0]
    const dx = t.clientX - g.x
    const dy = t.clientY - g.y
    const elapsed = performance.now() - g.t0
    gestureRef.current = null
    setIsDragging(false)
    if (g.axis === 'x' && Math.abs(dx) >= 60) {
      setDragY(0)
      if (dx < 0) handleSkipForward()
      else previousTrack()
    } else if (g.axis === 'y' && (dy >= 120 || (dy > 30 && dy / elapsed > 0.11))) {
      startClose()
    } else {
      setDragY(0)
    }
  }

  const isExternalTrack = ['jamendo', 'soulseek', 'ytmusic', 'soundcloud'].includes(currentTrack?.source)
  const dbTrackId =
    currentTrack?.db_id ?? (typeof currentTrack?.id === 'number' ? currentTrack.id : null)
  const canInteract = dbTrackId !== null || Boolean(currentTrack?.source)

  const canSkipNext = resolvedPrefetchVersion >= 0 && usePlayerStore.getState().isNextTrackReady()
  const handleSkipForward = async () => {
    // Очередь может быть короче плейлиста: страница грузит треки постранично
    // (см. queuePager в playerStore). Дотягиваем хвост, иначе на его границе
    // кнопка молча ничего не делала бы. Тот же хвост может ждать отложенный
    // переход в Player — просыпаемся вместе, поэтому сверяем, что трек за
    // время запроса не сменился: иначе промотали бы лишний.
    if (!usePlayerStore.getState().getNextTrack(1) && usePlayerStore.getState().queuePager) {
      const fromId = usePlayerStore.getState().currentTrack?.id
      if (!(await usePlayerStore.getState().extendQueueIfNeeded(true))) return
      if (usePlayerStore.getState().currentTrack?.id !== fromId) return
    }
    if (!usePlayerStore.getState().isNextTrackReady()) return
    nextTrack()
  }

  const coverUrl = useMemo(
    () => resolveCoverUrl(currentTrack?.cover_url, true) || defaultCover,
    [currentTrack?.cover_url],
  )

  useEffect(() => {
    const checkLikedStatus = async () => {
      if (!dbTrackId) return
      try {
        await fetchLikedTracks()
        await fetchDislikedTracks()
      } catch (error) {
        console.error('Error checking liked status:', error)
      }
    }

    checkLikedStatus()
  }, [dbTrackId, fetchLikedTracks, fetchDislikedTracks])

  if (!currentTrack) return null

  const handleLike = async () => {
    if (!canInteract || loadingLike) return

    setLoadingLike(true)
    postRecommendationEvent(currentTrack, isLiked ? 'unlike' : 'like')
    invalidateFlowPreload()
    try {
      const id = dbTrackId ?? (await materializeCurrentTrack())
      if (id) await toggleTrackLike(id, currentTrack)
    } catch (error) {
      console.error('Error toggling like:', error)
    } finally {
      setLoadingLike(false)
    }
  }

  // Дизлайк: помечаем и уходим на следующий трек (как в Player.jsx). Повторное
  // нажатие только снимает метку — пользователь мог передумать.
  const handleDislike = async () => {
    if (!canInteract || loadingDislike) return

    setLoadingDislike(true)
    postRecommendationEvent(currentTrack, isDisliked ? 'undislike' : 'dislike')
    invalidateFlowPreload()
    try {
      const id = dbTrackId ?? (await materializeCurrentTrack())
      if (!id) return
      const wasDisliked = usePlayerStore.getState().dislikedTrackIds.includes(id)
      await toggleTrackDislike(id, currentTrack)
      if (!wasDisliked) nextTrack()
    } catch (error) {
      console.error('Error toggling dislike:', error)
    } finally {
      setLoadingDislike(false)
    }
  }

  const isLiked = dbTrackId ? likedTrackIds.includes(dbTrackId) : false
  const isDisliked = dbTrackId ? dislikedTrackIds.includes(dbTrackId) : false

  const dragOpacity = Math.max(0.4, 1 - dragY / 700)

  return (
    <div
      className={`fullscreen-player${isClosing ? ' is-closing' : ''}${lyricsMode ? ' has-lyrics' : ''}`}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      style={{
        transform: dragY && !isClosing ? `translateY(${dragY}px)` : undefined,
        opacity: dragY && !isClosing ? dragOpacity : undefined,
        transition: isDragging ? 'none' : undefined,
      }}
    >
      <div className="fullscreen-header">
        <button className="fullscreen-icon" onClick={startClose} aria-label="Закрыть">
          <ChevronDown size={22} />
        </button>
        <img className="fullscreen-logo" src="/logoBolt.PNG" alt="Логотип" />
        {(
          <button
            className={`fullscreen-icon fullscreen-lyrics-toggle${hasLyrics ? ' active' : ''}`}
            onClick={() => setLyricsMode((prev) => !prev)}
            disabled={!hasLyrics && !lyricsLoading}
            aria-label={lyricsMode ? 'Скрыть текст' : 'Показать текст'}
            title={hasLyrics ? (lyricsMode ? 'Скрыть текст' : 'Показать текст') : 'Текст не найден'}
          >
            {lyricsMode ? <X size={20} /> : <AlignLeft size={20} />}
          </button>
        )}
      </div>

      <div className="fullscreen-body">
        <div className="fullscreen-content">
          <div className={`fullscreen-art${lyricsMode ? ' compact' : ''}`}>
            <img src={coverUrl} alt={currentTrack.title} onError={handleCoverError} />
          </div>

          <div className="fullscreen-info">
            <div>
              <div className="fullscreen-track-name">{currentTrack.title}</div>
              <ArtistLink
                artist={currentTrack.artist}
                className="fullscreen-artist"
                onNavigate={startClose}
              />
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
              {canInteract && (
                <button
                  type="button"
                  className={`fullscreen-icon fullscreen-dislike ${isDisliked ? 'active' : ''}`}
                  onClick={handleDislike}
                  disabled={loadingDislike}
                  aria-pressed={isDisliked}
                  aria-label={isDisliked ? 'Убрать отметку «не нравится»' : 'Не нравится'}
                >
                  <ThumbsDown size={20} fill={isDisliked ? 'currentColor' : 'none'} />
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

          {/* Desktop: lyrics appear to the right of art+info */}
          {lyricsMode && (
            <div className="fullscreen-lyrics-desktop">
              <LyricsPanel />
            </div>
          )}
        </div>

        {/* Mobile: lyrics appear below info, above progress */}
        {lyricsMode && (
          <div className="fullscreen-lyrics-mobile">
            <LyricsPanel showOnlyText />
          </div>
        )}
      </div>

      <FullScreenProgress />

      <div className="fullscreen-controls">
        <button
          type="button"
          className={`fullscreen-icon ${isShuffle ? 'active' : ''}`}
          onClick={toggleShuffle}
          aria-label={isShuffle ? 'Выключить случайный порядок' : 'Случайный порядок'}
        >
          <Shuffle size={20} fill={isShuffle ? 'currentColor' : 'none'} />
        </button>
        <button className="fullscreen-icon" onClick={previousTrack} aria-label="Назад">
          <SkipBack size={20} />
        </button>
        <button className="fullscreen-play" onClick={togglePlayPause} aria-label="Play/Pause">
          {isPlaying ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" />}
        </button>
        <button
          className="fullscreen-icon"
          onClick={handleSkipForward}
          disabled={!canSkipNext}
          aria-label="Вперёд"
          title={canSkipNext ? 'Вперёд' : 'Следующий трек ещё загружается'}
        >
          <SkipForward size={20} />
        </button>
        <button
          type="button"
          className={`fullscreen-icon ${isRepeatOne ? 'active' : ''}`}
          onClick={toggleRepeatOne}
          aria-label={isRepeatOne ? 'Выключить повтор трека' : 'Повторять трек'}
        >
          <Repeat1 size={20} fill={isRepeatOne ? 'currentColor' : 'none'} />
        </button>
      </div>

      <div className="fullscreen-mobile-tools">
        <button
          type="button"
          className={`fullscreen-mobile-lyrics${lyricsMode ? ' active' : ''}`}
          onClick={() => setLyricsMode((prev) => !prev)}
          disabled={!hasLyrics && !lyricsLoading}
          aria-label={lyricsMode ? 'Hide lyrics' : 'Show lyrics'}
          title={hasLyrics ? (lyricsMode ? 'Hide lyrics' : 'Show lyrics') : 'Lyrics not found'}
        >
          <AlignLeft size={24} />
        </button>
      </div>
    </div>
  )
}

export default FullScreenPlayer



