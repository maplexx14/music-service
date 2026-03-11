import { useEffect, useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePlayerStore } from '../store/playerStore'
import { Play, Heart, ChevronLeft, Shuffle, Search } from 'lucide-react'
import api from '../services/api'
import defaultCover from '../assets/default-cover.svg'
import { resolveCoverUrl } from '../utils/media'
import './LikedSongsDetail.css'

function LikedSongsDetail() {
  const [tracks, setTracks] = useState([])
  const [loading, setLoading] = useState(true)
  const { playPlaylist, currentTrack } = usePlayerStore()
  const navigate = useNavigate()
  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    api.get('/tracks/me/liked')
      .then(res => setTracks([...res.data].reverse()))
      .catch(err => console.error('Error fetching liked tracks:', err))
      .finally(() => setLoading(false))
  }, [])

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

  const filteredTracks = useMemo(() => {
    if (!searchQuery.trim()) return tracks
    const q = searchQuery.toLowerCase()
    return tracks.filter(t =>
      t.title?.toLowerCase().includes(q) ||
      t.artist?.toLowerCase().includes(q)
    )
  }, [tracks, searchQuery])

  const handlePlayTrack = (track) => {
    const realIndex = tracks.findIndex(t => t.id === track.id)
    if (realIndex !== -1) playPlaylist(tracks, realIndex)
  }

  const [unlikedIds, setUnlikedIds] = useState(new Set())

  const handleToggleLike = async (e, trackId) => {
    e.stopPropagation()
    const isUnliked = unlikedIds.has(trackId)
    try {
      if (isUnliked) {
        await api.post(`/tracks/${trackId}/like`)
        setUnlikedIds(prev => { const next = new Set(prev); next.delete(trackId); return next })
      } else {
        await api.delete(`/tracks/${trackId}/like`)
        setUnlikedIds(prev => new Set(prev).add(trackId))
      }
    } catch (error) {
      console.error('Error toggling like:', error)
    }
  }

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading">Загрузка...</div>
      </div>
    )
  }

  return (
    <div className="page-container liked-detail-page">
      <header className="liked-detail-header">
        <button className="liked-detail-back" onClick={() => navigate(-1)}>
          <ChevronLeft size={24} />
        </button>
        <div className="liked-detail-hero">
          <div className="liked-detail-icon">
            <Heart size={40} fill="currentColor" />
          </div>
          <div className="liked-detail-info">
            <h1 className="liked-detail-title">Мне нравится</h1>
            <span className="liked-detail-count">{tracks.length} треков</span>
          </div>
        </div>
        <div className="liked-detail-actions">
          <button className="liked-detail-play-btn" onClick={handlePlayAll}>
            <Play size={20} fill="white" color="white" />
          </button>
          <button className="liked-detail-shuffle-btn" onClick={handleShuffle}>
            <Shuffle size={20} />
          </button>
        </div>
      </header>

      {tracks.length > 3 && (
        <div className="liked-detail-search-wrap">
          <Search size={16} className="liked-detail-search-icon" />
          <input
            type="text"
            className="liked-detail-search-input"
            placeholder="Найти в понравившихся..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      )}

      <div className="liked-detail-list">
        {filteredTracks.map((track, index) => {
          const isActive = currentTrack?.id === track.id
          return (
            <div
              key={track.id}
              className={`liked-detail-track ${isActive ? 'active' : ''}`}
              onClick={() => handlePlayTrack(track)}
            >
              <span className="liked-detail-track-index">{index + 1}</span>
              <img
                src={resolveCoverUrl(track.cover_url) || defaultCover}
                alt={track.title}
                className="liked-detail-track-cover"
              />
              <div className="liked-detail-track-info">
                <div className={`liked-detail-track-name ${isActive ? 'active' : ''}`}>
                  {track.title}
                </div>
                <div className="liked-detail-track-artist">{track.artist}</div>
              </div>
              <button
                className={`liked-detail-track-heart-btn ${unlikedIds.has(track.id) ? 'unliked' : ''}`}
                onClick={(e) => handleToggleLike(e, track.id)}
                title={unlikedIds.has(track.id) ? 'Удалено из понравившихся' : 'Убрать из понравившихся'}
              >
                <Heart size={22} fill={unlikedIds.has(track.id) ? 'none' : 'currentColor'} />
              </button>
              <span className="liked-detail-track-duration">{formatTime(track.duration)}</span>
            </div>
          )
        })}
      </div>

      {tracks.length === 0 && (
        <div className="liked-detail-empty">
          <Heart size={48} />
          <p>У вас пока нет понравившихся треков</p>
        </div>
      )}

      {searchQuery && filteredTracks.length === 0 && tracks.length > 0 && (
        <div className="liked-detail-empty">
          <Search size={36} />
          <p>Ничего не найдено</p>
        </div>
      )}
    </div>
  )
}

export default LikedSongsDetail
