import { useEffect, useRef, useState, useCallback } from 'react'
import { usePlayerStore } from '../store/playerStore'
import { Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Volume2, Heart, Plus } from 'lucide-react'
import api from '../services/api'
import defaultCover from '../assets/default-cover.svg'
import { resolveCoverUrl, resolveTrackUrl } from '../utils/media'
import './Player.css'

function Player() {
  const {
    currentTrack,
    isPlaying,
    volume,
    currentTime,
    duration,
    togglePlayPause,
    nextTrack,
    previousTrack,
    setCurrentTime,
    setDuration,
    setVolume,
    openFullScreen,
    isRepeatOne,
    isShuffle,
    toggleRepeatOne,
    toggleShuffle,
    queue,
    currentIndex,
    shuffledOrder,
    currentShuffleIndex,
  } = usePlayerStore()

  const audioRef = useRef(null)
  const [isLiked, setIsLiked] = useState(false)
  const [loadingLike, setLoadingLike] = useState(false)
  const [showAddToPlaylist, setShowAddToPlaylist] = useState(false)
  const [playlists, setPlaylists] = useState([])
  const [selectedPlaylistId, setSelectedPlaylistId] = useState('')
  const [loadingPlaylists, setLoadingPlaylists] = useState(false)
  const [addError, setAddError] = useState('')

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const updateTime = () => setCurrentTime(audio.currentTime)
    const updateDuration = () => setDuration(audio.duration)
    const handleEnded = () => {
      if (usePlayerStore.getState().isRepeatOne) {
        audio.currentTime = 0
        audio.play().catch(() => { })
      } else {
        nextTrack()
      }
    }

    audio.addEventListener('timeupdate', updateTime)
    audio.addEventListener('loadedmetadata', updateDuration)
    audio.addEventListener('ended', handleEnded)

    return () => {
      audio.removeEventListener('timeupdate', updateTime)
      audio.removeEventListener('loadedmetadata', updateDuration)
      audio.removeEventListener('ended', handleEnded)
    }
  }, [currentTrack?.id, setCurrentTime, setDuration, nextTrack])

  // Check if track is liked when it changes
  useEffect(() => {
    const checkLikedStatus = async () => {
      if (!currentTrack) return
      try {
        const response = await api.get('/tracks/me/liked')
        const likedTracks = response.data
        setIsLiked(likedTracks.some(t => t.id === currentTrack.id))
      } catch (error) {
        console.error('Error checking liked status:', error)
      }
    }
    checkLikedStatus()
  }, [currentTrack])

  // Reload audio when track changes
  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !currentTrack) return

    // Reset audio when track changes
    audio.load()
    setCurrentTime(0)
    setDuration(0)
    setShowAddToPlaylist(false)
    setAddError('')
    setSelectedPlaylistId('')
  }, [currentTrack?.id, setCurrentTime, setDuration])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !currentTrack) return

    const handleLoad = () => {
      console.log('Audio metadata loaded, duration:', audio.duration)
      setDuration(audio.duration)
    }

    const handleCanPlay = () => {
      console.log('Audio can play')
      if (isPlaying) {
        audio.play().catch(err => {
          console.error('Error playing audio:', err)
        })
      }
    }

    const handleError = (e) => {
      console.error('Audio error:', e)
      console.error('Audio error code:', audio.error?.code)
      console.error('Audio error message:', audio.error?.message)
      console.error('Audio src:', audio.src)
      console.error('Current track:', currentTrack)
    }

    const handleLoadedData = () => {
      console.log('Audio data loaded')
    }

    audio.addEventListener('loadedmetadata', handleLoad)
    audio.addEventListener('canplay', handleCanPlay)
    audio.addEventListener('error', handleError)
    audio.addEventListener('loadeddata', handleLoadedData)

    if (isPlaying && audio.readyState >= 2) {
      audio.play().catch(err => {
        console.error('Error playing audio:', err)
      })
    } else if (!isPlaying) {
      audio.pause()
    }

    return () => {
      audio.removeEventListener('loadedmetadata', handleLoad)
      audio.removeEventListener('canplay', handleCanPlay)
      audio.removeEventListener('error', handleError)
      audio.removeEventListener('loadeddata', handleLoadedData)
    }
  }, [isPlaying, currentTrack, setDuration])

  useEffect(() => {
    const audio = audioRef.current
    if (audio) {
      audio.volume = volume
    }
  }, [volume, currentTrack?.id])

  const playerRef = useRef(null)
  const touchStartRef = useRef(null)
  const swipingRef = useRef(false)
  const [swipeX, setSwipeX] = useState(0)
  const [swipeAnim, setSwipeAnim] = useState(false)
  const swipeThreshold = 50

  const getAdjacentTrack = useCallback((direction) => {
    if (queue.length === 0) return null
    if (isShuffle && shuffledOrder.length > 0) {
      const si = direction === 'next'
        ? currentShuffleIndex + 1
        : currentShuffleIndex - 1
      if (si < 0 || si >= shuffledOrder.length) return null
      return queue[shuffledOrder[si]] || null
    }
    const ni = direction === 'next' ? currentIndex + 1 : currentIndex - 1
    if (ni < 0 || ni >= queue.length) return null
    return queue[ni] || null
  }, [queue, currentIndex, isShuffle, shuffledOrder, currentShuffleIndex])

  const peekDirection = swipeX < 0 ? 'next' : swipeX > 0 ? 'prev' : null
  const peekTrack = peekDirection ? getAdjacentTrack(peekDirection === 'next' ? 'next' : 'prev') : null

  const handleTouchStart = useCallback((e) => {
    if (swipeAnim) return
    touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
    swipingRef.current = false
  }, [swipeAnim])

  const handleTouchMove = useCallback((e) => {
    if (!touchStartRef.current || swipeAnim) return
    const dx = e.touches[0].clientX - touchStartRef.current.x
    const dy = e.touches[0].clientY - touchStartRef.current.y
    if (!swipingRef.current) {
      if (Math.abs(dy) > Math.abs(dx)) {
        touchStartRef.current = null
        return
      }
      if (Math.abs(dx) > 8) swipingRef.current = true
    }
    if (swipingRef.current) {
      e.preventDefault()
      setSwipeX(dx)
    }
  }, [swipeAnim])

  const handleTouchEnd = useCallback((e) => {
    if (!touchStartRef.current || swipeAnim) {
      touchStartRef.current = null
      return
    }
    const dx = e.changedTouches[0].clientX - touchStartRef.current.x
    touchStartRef.current = null

    if (!swipingRef.current || Math.abs(dx) < swipeThreshold) {
      swipingRef.current = false
      setSwipeX(0)
      return
    }

    const goNext = dx < 0
    const target = getAdjacentTrack(goNext ? 'next' : 'prev')
    if (!target) {
      swipingRef.current = false
      setSwipeX(0)
      return
    }

    setSwipeAnim(true)
    const playerW = playerRef.current?.offsetWidth || window.innerWidth
    setSwipeX(goNext ? -playerW : playerW)

    setTimeout(() => {
      if (goNext) nextTrack()
      else previousTrack()
      setSwipeX(0)
      setSwipeAnim(false)
      swipingRef.current = false
    }, 250)
  }, [nextTrack, previousTrack, swipeAnim, getAdjacentTrack])

  if (!currentTrack) {
    return null
  }

  const formatTime = (seconds) => {
    if (!seconds || isNaN(seconds)) return '0:00'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const handleSeek = (e) => {
    const audio = audioRef.current
    if (!audio) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const percentage = x / rect.width
    const newTime = percentage * duration
    audio.currentTime = newTime
    setCurrentTime(newTime)
  }

  const handleLike = async () => {
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
    } catch (error) {
      console.error('Error toggling like:', error)
      // Revert state on error
      setIsLiked(!isLiked)
    } finally {
      setLoadingLike(false)
    }
  }

  const handleOpenAddToPlaylist = async () => {
    if (!currentTrack) return
    setShowAddToPlaylist((prev) => !prev)
    setAddError('')

    if (playlists.length === 0 && !loadingPlaylists) {
      setLoadingPlaylists(true)
      try {
        const response = await api.get('/playlists/me')
        setPlaylists(response.data)
      } catch (error) {
        setAddError('Не удалось загрузить плейлисты')
      } finally {
        setLoadingPlaylists(false)
      }
    }
  }

  const handleAddToPlaylist = async () => {
    if (!currentTrack || !selectedPlaylistId) {
      setAddError('Выберите плейлист')
      return
    }
    setAddError('')
    try {
      await api.post(`/playlists/${selectedPlaylistId}/tracks/${currentTrack.id}`)
      setShowAddToPlaylist(false)
    } catch (error) {
      setAddError(error.response?.data?.detail || 'Не удалось добавить трек')
    }
  }

  const playerWidth = playerRef.current?.offsetWidth || 0

  const renderTrackSlide = (track) => (
    <div className="player-slide" style={{ minWidth: '100%' }}>
      <button
        type="button"
        className="player-cover-wrap"
        onClick={openFullScreen}
        aria-label="Открыть плеер на весь экран"
      >
        <img
          src={resolveCoverUrl(track.cover_url) || defaultCover}
          alt={track.title}
          className="player-cover"
        />
      </button>
      <div className="player-info">
        <div className="player-track-title">{track.title}</div>
        <div className="player-track-artist">{track.artist}</div>
      </div>
    </div>
  )

  return (
    <div
      className="player"
      ref={playerRef}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <audio
        ref={audioRef}
        key={currentTrack.id}
        src={resolveTrackUrl(currentTrack)}
        preload="auto"
        onError={(e) => {
          console.error('Audio element error:', e)
          console.error('Audio src:', audioRef.current?.src)
        }}
        onCanPlay={() => {
          if (isPlaying) {
            audioRef.current?.play().catch(() => {})
          }
        }}
      />

      <div className="player-left">
        <div
          className="player-swipe-rail"
          style={{
            transform: peekDirection === 'prev' && peekTrack
              ? `translateX(calc(-100% + ${swipeX}px))`
              : `translateX(${swipeX}px)`,
            transition: swipeAnim ? 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)' : (swipingRef.current ? 'none' : 'transform 0.2s ease-out'),
          }}
        >
          {peekDirection === 'prev' && peekTrack && renderTrackSlide(peekTrack)}
          {renderTrackSlide(currentTrack)}
          {peekDirection === 'next' && peekTrack && renderTrackSlide(peekTrack)}
        </div>
        <div className="player-actions-fixed">
          <button
            className={`like-btn ${isLiked ? 'liked' : ''}`}
            onClick={(event) => { event.stopPropagation(); handleLike() }}
            disabled={loadingLike}
            title={isLiked ? 'Убрать из понравившихся' : 'Добавить в понравившиеся'}
          >
            <Heart size={24} fill={isLiked ? 'currentColor' : 'none'} />
          </button>
          <button
            className="add-btn"
            onClick={(event) => { event.stopPropagation(); handleOpenAddToPlaylist() }}
            title="Добавить в плейлист"
          >
            <Plus size={20} />
          </button>
        </div>
      </div>

      {showAddToPlaylist && (
        <div className="playlist-add-panel">
          <div className="playlist-add-title">Добавить в плейлист</div>
          {loadingPlaylists ? (
            <div className="playlist-add-loading">Загрузка...</div>
          ) : playlists.length === 0 ? (
            <div className="playlist-add-empty">Нет плейлистов</div>
          ) : (
            <select
              className="playlist-add-select"
              value={selectedPlaylistId}
              onChange={(e) => setSelectedPlaylistId(e.target.value)}
            >
              <option value="">Выберите плейлист</option>
              {playlists.map((playlist) => (
                <option key={playlist.id} value={playlist.id}>
                  {playlist.name}
                </option>
              ))}
            </select>
          )}
          {addError && <div className="playlist-add-error">{addError}</div>}
          <div className="playlist-add-actions">
            <button className="playlist-add-cancel" onClick={() => setShowAddToPlaylist(false)}>
              Отмена
            </button>
            <button className="playlist-add-confirm" onClick={handleAddToPlaylist}>
              Добавить
            </button>
          </div>
        </div>
      )}

      <div className="player-center">
        <div className="player-controls">
          <button
            type="button"
            className={`control-btn ${isShuffle ? 'active' : ''}`}
            onClick={toggleShuffle}
            title={isShuffle ? 'Выключить случайный порядок' : 'Случайный порядок'}
          >
            <Shuffle size={20} />
          </button>
          <button type="button" className="control-btn" onClick={previousTrack} aria-label="Предыдущий">
            <SkipBack size={20} />
          </button>
          <button className="play-pause-btn" onClick={togglePlayPause} aria-label={isPlaying ? 'Пауза' : 'Играть'}>
            {isPlaying ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" />}
          </button>
          <button type="button" className="control-btn" onClick={nextTrack} aria-label="Следующий">
            <SkipForward size={20} />
          </button>
          <button
            type="button"
            className={`control-btn ${isRepeatOne ? 'active' : ''}`}
            onClick={toggleRepeatOne}
            title={isRepeatOne ? 'Выключить повтор трека' : 'Повторять трек'}
          >
            <Repeat size={20} />
          </button>
        </div>
        <div className="player-progress">
          <span className="time-text">{formatTime(currentTime)}</span>
          <div className="progress-bar" onClick={handleSeek}>
            <div
              className="progress-fill"
              style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }}
            />
          </div>
          <span className="time-text">{formatTime(duration)}</span>
        </div>
      </div>

      <div className="player-right">
        <div className="volume-control">
          <Volume2 size={20} />
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={volume}
            onChange={(e) => setVolume(parseFloat(e.target.value))}
            className="volume-slider"
          />
        </div>
      </div>
    </div>
  )
}

export default Player
