import { useEffect, useRef, useState } from 'react'
import { usePlayerStore } from '../store/playerStore'
import { Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Volume2, Heart } from 'lucide-react'
import api from '../services/api'
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
  } = usePlayerStore()

  const audioRef = useRef(null)
  const [isLiked, setIsLiked] = useState(false)
  const [loadingLike, setLoadingLike] = useState(false)

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
  }, [setCurrentTime, setDuration, nextTrack])

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
      
      <div className="player-left">
        {currentTrack.cover_url && (
          <img src={currentTrack.cover_url} alt={currentTrack.title} className="player-cover" />
        )}
        <div className="player-info">
          <div className="player-track-title">{currentTrack.title}</div>
          <div className="player-track-artist">{currentTrack.artist}</div>
        </div>
        <button
          className={`like-btn ${isLiked ? 'liked' : ''}`}
          onClick={handleLike}
          disabled={loadingLike}
          title={isLiked ? 'Убрать из понравившихся' : 'Добавить в понравившиеся'}
        >
          <Heart size={16} fill={isLiked ? 'currentColor' : 'none'} />
        </button>
      </div>

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
