import { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { usePlayerStore } from '../store/playerStore'
import { Play, ChevronLeft, Shuffle, Search, Music, Heart, Plus, Check, X, Trash2, Share2, Camera } from 'lucide-react'
import api from '../services/api'
import defaultCover from '../assets/default-cover.svg'
import { resolveCoverUrl } from '../utils/media'
import './PlaylistDetail.css'

function PlaylistDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [playlist, setPlaylist] = useState(null)
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [isLiked, setIsLiked] = useState(false)
  const [isOwner, setIsOwner] = useState(false)
  const { playPlaylist, currentTrack } = usePlayerStore()

  const coverInputRef = useRef(null)
  const [uploadingCover, setUploadingCover] = useState(false)

  const [addMode, setAddMode] = useState(false)
  const [addQuery, setAddQuery] = useState('')
  const [addResults, setAddResults] = useState([])
  const [addLoading, setAddLoading] = useState(false)
  const [addedIds, setAddedIds] = useState(new Set())

  const fetchPlaylist = useCallback(() => {
    return api.get(`/playlists/${id}`).then(res => {
      setPlaylist(res.data)
      return res.data
    })
  }, [id])

  useEffect(() => {
    setLoading(true)
    Promise.all([
      fetchPlaylist(),
      api.get('/playlists/me/liked').catch(() => ({ data: [] })),
      api.get('/users/me').catch(() => ({ data: null })),
    ]).then(([pl, likedRes, userRes]) => {
      setIsLiked(likedRes.data.some(lp => lp.playlist_id === parseInt(id)))
      if (userRes.data && pl) {
        setIsOwner(pl.owner_id === userRes.data.id)
      }
    }).catch(() => navigate('/playlists'))
      .finally(() => setLoading(false))
  }, [id, navigate, fetchPlaylist])

  const handleToggleLike = async () => {
    try {
      if (isLiked) {
        await api.delete(`/playlists/${id}/like`)
        setIsLiked(false)
      } else {
        await api.post(`/playlists/${id}/like`)
        setIsLiked(true)
      }
    } catch (err) {
      console.error('Error toggling playlist like:', err)
    }
  }

  const tracks = playlist?.tracks || []
  const trackIds = useMemo(() => new Set(tracks.map(t => t.id)), [tracks])

  const filteredTracks = useMemo(() => {
    if (!searchQuery.trim()) return tracks
    const q = searchQuery.toLowerCase()
    return tracks.filter(t =>
      t.title?.toLowerCase().includes(q) ||
      t.artist?.toLowerCase().includes(q)
    )
  }, [tracks, searchQuery])

  const formatTime = (seconds) => {
    if (!seconds) return '0:00'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const handlePlayAll = () => {
    if (tracks.length > 0) playPlaylist(tracks, 0)
  }

  const handleShuffle = () => {
    if (tracks.length === 0) return
    const shuffled = [...tracks].sort(() => Math.random() - 0.5)
    playPlaylist(shuffled, 0)
  }

  const handlePlayTrack = (track) => {
    const realIndex = tracks.findIndex(t => t.id === track.id)
    if (realIndex !== -1) playPlaylist(tracks, realIndex)
  }

  const handleRemoveTrack = async (e, trackId) => {
    e.stopPropagation()
    try {
      await api.delete(`/playlists/${id}/tracks/${trackId}`)
      setPlaylist(prev => ({
        ...prev,
        tracks: prev.tracks.filter(t => t.id !== trackId)
      }))
    } catch (err) {
      console.error('Error removing track:', err)
    }
  }

  // --- Add tracks logic ---

  useEffect(() => {
    if (!addMode) {
      setAddQuery('')
      setAddResults([])
      setAddedIds(new Set())
      return
    }
  }, [addMode])

  useEffect(() => {
    if (!addQuery.trim()) {
      setAddResults([])
      return
    }
    const timeout = setTimeout(async () => {
      setAddLoading(true)
      try {
        const res = await api.get('/search', { params: { q: addQuery, limit: 20 } })
        setAddResults(res.data.tracks || [])
      } catch {
        setAddResults([])
      } finally {
        setAddLoading(false)
      }
    }, 300)
    return () => clearTimeout(timeout)
  }, [addQuery])

  const handleAddTrack = async (track) => {
    try {
      await api.post(`/playlists/${id}/tracks/${track.id}`)
      setAddedIds(prev => new Set(prev).add(track.id))
      setPlaylist(prev => ({
        ...prev,
        tracks: [...(prev.tracks || []), track]
      }))
    } catch (err) {
      if (err.response?.status === 400) {
        setAddedIds(prev => new Set(prev).add(track.id))
      }
      console.error('Error adding track:', err)
    }
  }

  const handleShare = async () => {
    if (!playlist?.uuid) return
    const url = `${window.location.origin}/shared/${playlist.uuid}`
    try {
      if (navigator.share) {
        await navigator.share({ title: playlist.name, url })
      } else {
        await navigator.clipboard.writeText(url)
        alert('Ссылка скопирована!')
      }
    } catch {
      // user cancelled share dialog
    }
  }

  const handleCoverClick = () => {
    if (isOwner && coverInputRef.current) {
      coverInputRef.current.click()
    }
  }

  const handleCoverChange = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadingCover(true)
    try {
      const form = new FormData()
      form.append('cover', file)
      const res = await api.post(`/playlists/${id}/cover`, form, {
        headers: { 'Content-Type': 'multipart/form-data' }
      })
      setPlaylist(prev => ({ ...prev, cover_url: res.data.cover_url }))
    } catch (err) {
      console.error('Error uploading cover:', err)
    } finally {
      setUploadingCover(false)
      if (coverInputRef.current) coverInputRef.current.value = ''
    }
  }

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading">Загрузка...</div>
      </div>
    )
  }

  if (!playlist) return null

  const firstTrackCover = tracks[0]?.cover_url ? resolveCoverUrl(tracks[0].cover_url) : null
  const coverSrc = resolveCoverUrl(playlist.cover_url) || firstTrackCover || defaultCover

  return (
    <div className="page-container pd-page">
      <header className="pd-header">
        <button className="pd-back" onClick={() => navigate(-1)}>
          <ChevronLeft size={24} />
        </button>

        <div className="pd-hero">
          <div className={`pd-cover-wrap ${isOwner ? 'editable' : ''}`} onClick={handleCoverClick}>
            <img src={coverSrc} alt={playlist.name} className="pd-cover" />
            {isOwner && (
              <div className="pd-cover-overlay">
                <Camera size={20} />
              </div>
            )}
            {uploadingCover && <div className="pd-cover-loading" />}
          </div>
          <input
            ref={coverInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={handleCoverChange}
          />
          <div className="pd-info">
            <h1 className="pd-title">{playlist.name}</h1>
            {playlist.description && (
              <p className="pd-description">{playlist.description}</p>
            )}
            <span className="pd-count">{tracks.length} треков</span>
          </div>
        </div>

        <div className="pd-actions">
          <button className="pd-play-btn" onClick={handlePlayAll}>
            <Play size={20} fill="white" color="white" />
          </button>
          <button className="pd-shuffle-btn" onClick={handleShuffle}>
            <Shuffle size={20} />
          </button>
          <button
            className={`pd-like-btn ${isLiked ? 'liked' : ''}`}
            onClick={handleToggleLike}
          >
            <Heart size={22} fill={isLiked ? 'currentColor' : 'none'} />
          </button>
          <button className="pd-share-btn" onClick={handleShare} aria-label="Поделиться">
            <Share2 size={20} />
          </button>
          {isOwner && (
            <button
              className={`pd-add-toggle ${addMode ? 'active' : ''}`}
              onClick={() => setAddMode(!addMode)}
              aria-label="Добавить треки"
            >
              {addMode ? <X size={20} /> : <Plus size={20} />}
            </button>
          )}
        </div>
      </header>

      {/* Add tracks panel */}
      {addMode && (
        <div className="pd-add-panel">
          <div className="pd-add-header">Добавить треки</div>
          <div className="pd-search-wrap">
            <Search size={16} className="pd-search-icon" />
            <input
              type="text"
              className="pd-search-input"
              placeholder="Поиск треков..."
              value={addQuery}
              onChange={(e) => setAddQuery(e.target.value)}
              autoFocus
            />
          </div>

          {addLoading && <div className="pd-add-loading">Поиск...</div>}

          <div className="pd-add-results">
            {addResults.map(track => {
              const alreadyIn = trackIds.has(track.id) || addedIds.has(track.id)
              return (
                <div key={track.id} className="pd-add-item">
                  <img
                    src={resolveCoverUrl(track.cover_url) || defaultCover}
                    alt={track.title}
                    className="pd-track-cover"
                  />
                  <div className="pd-track-info">
                    <div className="pd-track-name">{track.title}</div>
                    <div className="pd-track-artist">{track.artist}</div>
                  </div>
                  <button
                    className={`pd-add-btn ${alreadyIn ? 'added' : ''}`}
                    onClick={() => !alreadyIn && handleAddTrack(track)}
                    disabled={alreadyIn}
                  >
                    {alreadyIn ? <Check size={18} /> : <Plus size={18} />}
                  </button>
                </div>
              )
            })}
          </div>

          {addQuery && !addLoading && addResults.length === 0 && (
            <div className="pd-add-no-results">Ничего не найдено</div>
          )}
        </div>
      )}

      {/* Search within playlist */}
      {!addMode && tracks.length > 3 && (
        <div className="pd-search-wrap">
          <Search size={16} className="pd-search-icon" />
          <input
            type="text"
            className="pd-search-input"
            placeholder="Найти в плейлисте..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      )}

      {!addMode && (
        <>
          <div className="pd-track-list">
            {filteredTracks.map((track, index) => {
              const isActive = currentTrack?.id === track.id
              return (
                <div
                  key={track.id}
                  className={`pd-track ${isActive ? 'active' : ''}`}
                  onClick={() => handlePlayTrack(track)}
                >
                  <span className="pd-track-index">{index + 1}</span>
                  <img
                    src={resolveCoverUrl(track.cover_url) || defaultCover}
                    alt={track.title}
                    className="pd-track-cover"
                  />
                  <div className="pd-track-info">
                    <div className={`pd-track-name ${isActive ? 'active' : ''}`}>
                      {track.title}
                    </div>
                    <div className="pd-track-artist">{track.artist}</div>
                  </div>
                  {isOwner && (
                    <button
                      className="pd-remove-btn"
                      onClick={(e) => handleRemoveTrack(e, track.id)}
                      aria-label="Удалить из плейлиста"
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                  <span className="pd-track-duration">{formatTime(track.duration)}</span>
                </div>
              )
            })}
          </div>

          {tracks.length === 0 && !addMode && (
            <div className="pd-empty">
              <Music size={48} />
              <p>В этом плейлисте пока нет треков</p>
              {isOwner && (
                <button className="pd-empty-add-btn" onClick={() => setAddMode(true)}>
                  <Plus size={18} />
                  Добавить треки
                </button>
              )}
            </div>
          )}

          {searchQuery && filteredTracks.length === 0 && tracks.length > 0 && (
            <div className="pd-empty">
              <Search size={36} />
              <p>Ничего не найдено</p>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default PlaylistDetail
