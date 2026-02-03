import { useEffect, useRef, useState } from 'react'
import { usePlayerStore } from '../store/playerStore'
import { Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Volume2, Heart, Plus } from 'lucide-react'
import api from '../services/api'
import defaultCover from '../assets/default-cover.svg'
import { resolveCoverUrl } from '../utils/media'
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
    const handleEnded = () => nextTrack()

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
  }, [volume])

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

  return (
    <div className="player">
      <audio
        ref={audioRef}
        key={currentTrack.id}
        src={currentTrack.id
          ? `http://localhost:8000/api/tracks/${currentTrack.id}/stream`
          : currentTrack.file_path?.startsWith('http')
            ? currentTrack.file_path
            : currentTrack.file_path
              ? `http://localhost:8000${currentTrack.file_path.startsWith('/') ? '' : '/'}${currentTrack.file_path}`
              : undefined}
        preload="auto"
        crossOrigin="anonymous"
        onError={(e) => {
          console.error('Audio element error:', e)
          console.error('Track:', currentTrack)
          console.error('File path:', currentTrack.file_path)
          console.error('Audio src:', audioRef.current?.src)
          console.error('Audio error details:', audioRef.current?.error)
        }}
        onLoadStart={() => {
          console.log('Audio loading started:', currentTrack.title, 'src:', audioRef.current?.src)
        }}
        onCanPlay={() => {
          console.log('Audio can play:', currentTrack.title)
          if (isPlaying) {
            audioRef.current?.play().catch(err => {
              console.error('Play error:', err)
            })
          }
        }}
        onLoadedMetadata={() => {
          console.log('Metadata loaded for:', currentTrack.title)
        }}
      />
      
      <div className="player-left" onClick={openFullScreen} role="button" tabIndex={0}>
        <img
          src={resolveCoverUrl(currentTrack.cover_url) || defaultCover}
          alt={currentTrack.title}
          className="player-cover"
        />
        <div className="player-info">
          <div className="player-track-title">{currentTrack.title}</div>
          <div className="player-track-artist">{currentTrack.artist}</div>
        </div>
        <button
          className={`like-btn ${isLiked ? 'liked' : ''}`}
          onClick={(event) => {
            event.stopPropagation()
            handleLike()
          }}
          disabled={loadingLike}
          title={isLiked ? 'Убрать из понравившихся' : 'Добавить в понравившиеся'}
        >
          <Heart size={16} fill={isLiked ? 'currentColor' : 'none'} />
        </button>
        <button
          className="add-btn"
          onClick={(event) => {
            event.stopPropagation()
            handleOpenAddToPlaylist()
          }}
          title="Добавить в плейлист"
        >
          <Plus size={16} />
        </button>
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
          <button className="control-btn">
            <Shuffle size={18} />
          </button>
          <button className="control-btn" onClick={previousTrack}>
            <SkipBack size={20} />
          </button>
          <button className="play-pause-btn" onClick={togglePlayPause}>
            {isPlaying ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" />}
          </button>
          <button className="control-btn" onClick={nextTrack}>
            <SkipForward size={20} />
          </button>
          <button className="control-btn">
            <Repeat size={18} />
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
          <Volume2 size={18} />
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
