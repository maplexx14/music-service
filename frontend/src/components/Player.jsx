import { useEffect, useRef, useState } from 'react'
import { usePlayerStore } from '../store/playerStore'
import { Play, Pause, SkipBack, SkipForward, Shuffle, Repeat1, Volume2, Heart, ListPlus, Download } from 'lucide-react'
import api from '../services/api'
import defaultCover from '../assets/default-cover.svg'
import { resolveCoverUrl } from '../utils/media'
import { API_URL, SERVER_URL } from '../config'
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
    likedTrackIds,
    fetchLikedTracks,
    toggleTrackLike,
  } = usePlayerStore()

  const audioRef = useRef(null)
  const blobUrlRef = useRef(null)
  const lastRecordedTrackIdRef = useRef(null)
  const [audioSrc, setAudioSrc] = useState(null)
  const [loadingLike, setLoadingLike] = useState(false)
  const [showAddToPlaylist, setShowAddToPlaylist] = useState(false)
  const [playlists, setPlaylists] = useState([])
  const [selectedPlaylistId, setSelectedPlaylistId] = useState('')
  const [loadingPlaylists, setLoadingPlaylists] = useState(false)
  const [addError, setAddError] = useState('')
  const isExternalTrack = currentTrack?.source === 'jamendo'
  const localTrackId = !isExternalTrack ? currentTrack?.id : null

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const updateTime = () => setCurrentTime(audio.currentTime)
    const updateDuration = () => setDuration(audio.duration)
    const handleEnded = () => {
      if (usePlayerStore.getState().isRepeatOne) {
        audio.currentTime = 0
        audio.play().catch(() => {})
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

  useEffect(() => {
    if (localTrackId) {
      fetchLikedTracks().catch((error) => {
        console.error('Error checking liked status:', error)
      })
    }
  }, [localTrackId, fetchLikedTracks])

  // Resolve audio URL: для Tuna/внешнего API используем fetch с tuna-skip-browser-warning
  useEffect(() => {
    if (!currentTrack) {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
        blobUrlRef.current = null
      }
      setAudioSrc(undefined)
      return
    }

    const rawUrl = isExternalTrack
      ? currentTrack.stream_url
      : currentTrack.id
      ? `${API_URL}/tracks/${currentTrack.id}/stream`
      : currentTrack.file_path?.startsWith('http')
        ? currentTrack.file_path
        : currentTrack.file_path
          ? `${SERVER_URL}${currentTrack.file_path.startsWith('/') ? '' : '/'}${currentTrack.file_path}`
          : undefined

    if (!rawUrl) {
      setAudioSrc(undefined)
      return
    }

    const isOurApi = !isExternalTrack && (rawUrl.startsWith(API_URL) || rawUrl.startsWith(SERVER_URL))
    if (isOurApi) {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
        blobUrlRef.current = null
      }
      setAudioSrc(null)
      fetch(rawUrl, { headers: { 'tuna-skip-browser-warning': '1' } })
        .then((r) => r.blob())
        .then((blob) => {
          const url = URL.createObjectURL(blob)
          blobUrlRef.current = url
          setAudioSrc(url)
        })
        .catch(() => setAudioSrc(rawUrl))
    } else {
      setAudioSrc(rawUrl)
    }

    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
        blobUrlRef.current = null
      }
    }
  }, [currentTrack?.id, currentTrack?.file_path, currentTrack?.stream_url, isExternalTrack, API_URL, SERVER_URL])

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
      setDuration(audio.duration)
    }

    const handleCanPlay = () => {
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

    audio.addEventListener('loadedmetadata', handleLoad)
    audio.addEventListener('canplay', handleCanPlay)
    audio.addEventListener('error', handleError)

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
    }
  }, [isPlaying, currentTrack, setDuration])

  useEffect(() => {
    if (!localTrackId) {
      lastRecordedTrackIdRef.current = null
      return
    }
    if (!isPlaying) return
    if (lastRecordedTrackIdRef.current === localTrackId) return
    lastRecordedTrackIdRef.current = localTrackId
    api.post(`/tracks/${localTrackId}/play`).catch(() => {})
  }, [localTrackId, isPlaying])

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
    if (!localTrackId || loadingLike) return
    
    setLoadingLike(true)
    try {
      await toggleTrackLike(localTrackId)
    } catch (error) {
      console.error('Error toggling like:', error)
    } finally {
      setLoadingLike(false)
    }
  }

  const isLiked = localTrackId ? likedTrackIds.includes(localTrackId) : false

  const handleOpenAddToPlaylist = async () => {
    if (!localTrackId) return
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
    if (!localTrackId || !selectedPlaylistId) {
      setAddError('Выберите плейлист')
      return
    }
    setAddError('')
    try {
      await api.post(`/playlists/${selectedPlaylistId}/tracks/${localTrackId}`)
      setShowAddToPlaylist(false)
    } catch (error) {
      setAddError(error.response?.data?.detail || 'Не удалось добавить трек')
    }
  }

  return (
    <div className="player">
      <audio
        ref={audioRef}
        key={currentTrack?.id}
        src={audioSrc || undefined}
        preload="auto"
        crossOrigin="anonymous"
        onError={(e) => {
          console.error('Audio element error:', e)
          console.error('Track:', currentTrack)
          console.error('File path:', currentTrack.file_path)
          console.error('Audio src:', audioRef.current?.src)
          console.error('Audio error details:', audioRef.current?.error)
        }}
        onCanPlay={() => {
          if (isPlaying) {
            audioRef.current?.play().catch(err => {
              console.error('Play error:', err)
            })
          }
        }}
      />
      
      <div className="player-left">
        <button
          type="button"
          className="player-cover-wrap"
          onClick={openFullScreen}
          aria-label="Открыть плеер на весь экран"
        >
          <img
            src={isExternalTrack ? currentTrack.cover_url || defaultCover : resolveCoverUrl(currentTrack.cover_url) || defaultCover}
            alt={currentTrack.title}
            className="player-cover"
          />
        </button>
        <div className="player-info">
          <div className="player-track-title">{currentTrack.title}</div>
          <div className="player-track-artist">{currentTrack.artist}</div>
        </div>
        {!isExternalTrack && (
          <>
            <button
              className={`like-btn ${isLiked ? 'liked' : ''}`}
              onClick={(event) => {
                event.stopPropagation()
                handleLike()
              }}
              disabled={loadingLike}
              title={isLiked ? 'Убрать из понравившихся' : 'Добавить в понравившиеся'}
            >
              <Heart size={18} fill={isLiked ? 'currentColor' : 'none'} />
            </button>
            <button
              className="add-btn"
              onClick={(event) => {
                event.stopPropagation()
                handleOpenAddToPlaylist()
              }}
              title="Добавить в плейлист"
            >
              <ListPlus size={18} />
            </button>
          </>
        )}
        {isExternalTrack && currentTrack.download_allowed && currentTrack.download_url && (
          <a
            className="add-btn"
            href={currentTrack.download_url}
            target="_blank"
            rel="noreferrer"
            title="Скачать"
            onClick={(event) => event.stopPropagation()}
          >
            <Download size={18} />
          </a>
        )}
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
            {isPlaying ? (
              <Pause size={24} fill="currentColor" />
            ) : (
              <Play size={24} fill="currentColor" style={{ marginLeft: 2 }} />
            )}
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
            <Repeat1 size={20} />
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
