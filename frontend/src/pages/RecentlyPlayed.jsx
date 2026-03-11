import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Clock, ChevronLeft, Trash2, Play } from 'lucide-react'
import api from '../services/api'
import defaultCover from '../assets/default-cover.svg'
import { resolveCoverUrl } from '../utils/media'
import { usePlayerStore } from '../store/playerStore'
import { buildRecentPlaylist, formatTimeAgo, normalizeLastPlayed, WINDOW_HOURS_DEFAULT } from '../utils/recentlyPlayed'
import './RecentlyPlayed.css'

const PAGE_SIZE = 30

function RecentlyPlayed() {
  const [tracks, setTracks] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [error, setError] = useState('')
  const sentinelRef = useRef(null)
  const pageRef = useRef(0)
  const navigate = useNavigate()
  const { playPlaylist, currentTrack } = usePlayerStore()

  const fetchPage = useCallback(async (page, { append } = {}) => {
    const skip = page * PAGE_SIZE
    try {
      const response = await api.get('/tracks/me/recent', {
        params: {
          limit: PAGE_SIZE,
          skip,
          since_hours: WINDOW_HOURS_DEFAULT,
        },
      })
      const payload = response.data || []
      const mapped = payload.map((track) => ({
        ...track,
        lastPlayedAt: track.last_played || track.lastPlayedAt,
      }))
      setTracks((prev) => (append ? [...prev, ...mapped] : mapped))
      setHasMore(mapped.length === PAGE_SIZE)
      setError('')
    } catch (err) {
      setError(err.response?.data?.detail || 'Не удалось загрузить историю')
    }
  }, [])

  const loadInitial = useCallback(async () => {
    setLoading(true)
    pageRef.current = 0
    await fetchPage(0, { append: false })
    setLoading(false)
  }, [fetchPage])

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    pageRef.current += 1
    await fetchPage(pageRef.current, { append: true })
    setLoadingMore(false)
  }, [fetchPage, hasMore, loadingMore])

  useEffect(() => {
    loadInitial()
  }, [loadInitial])

  useEffect(() => {
    if (!sentinelRef.current || !hasMore) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          loadMore()
        }
      },
      { rootMargin: '200px' }
    )
    observer.observe(sentinelRef.current)
    return () => observer.disconnect()
  }, [loadMore, hasMore, tracks.length])

  const recentPlaylist = useMemo(() => {
    return buildRecentPlaylist(tracks)
  }, [tracks])

  const handlePlayAll = () => {
    if (recentPlaylist.length > 0) {
      playPlaylist(recentPlaylist, 0, 'recent')
    }
  }

  const handlePlayTrack = (track) => {
    const index = recentPlaylist.findIndex((t) => t.id === track.id)
    if (index >= 0) playPlaylist(recentPlaylist, index, 'recent')
  }

  const handleClearHistory = async () => {
    const ok = window.confirm('Очистить историю прослушиваний за последние 2 дня?')
    if (!ok) return
    try {
      await api.delete('/tracks/me/recent')
      setTracks([])
      setHasMore(false)
      pageRef.current = 0
    } catch (err) {
      setError(err.response?.data?.detail || 'Не удалось очистить историю')
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
    <div className="page-container recent-page">
      <header className="recent-header">
        <button className="recent-back" onClick={() => navigate(-1)}>
          <ChevronLeft size={24} />
        </button>
        <div className="recent-hero">
          <div className="recent-icon">
            <Clock size={36} />
          </div>
          <div className="recent-info">
            <h1 className="recent-title">Недавно прослушанные</h1>
            <span className="recent-subtitle">Последние 48 часов</span>
          </div>
        </div>
        <div className="recent-actions">
          <button className="recent-play-btn" onClick={handlePlayAll} disabled={recentPlaylist.length === 0}>
            <Play size={18} fill="white" color="white" />
            Слушать
          </button>
          <button className="recent-clear-btn" onClick={handleClearHistory} disabled={recentPlaylist.length === 0}>
            <Trash2 size={18} />
            Очистить историю
          </button>
        </div>
      </header>

      {error && <div className="recent-error">{error}</div>}

      {recentPlaylist.length === 0 && !error && (
        <div className="recent-empty">
          <Clock size={42} />
          <p>За последние 48 часов нет прослушиваний</p>
        </div>
      )}

      <div className="recent-list">
        {recentPlaylist.map((track, index) => {
          const isActive = currentTrack?.id === track.id
          const lastPlayedMs = normalizeLastPlayed(track)
          return (
            <div
              key={`${track.id}-${track.lastPlayedAt || track.last_played || index}`}
              className={`recent-item ${isActive ? 'active' : ''}`}
              onClick={() => handlePlayTrack(track)}
            >
              <span className="recent-index">{index + 1}</span>
              <img
                src={resolveCoverUrl(track.cover_url) || defaultCover}
                alt={track.title}
                className="recent-cover"
              />
              <div className="recent-track-info">
                <div className={`recent-track-title ${isActive ? 'active' : ''}`}>{track.title}</div>
                <div className="recent-track-artist">{track.artist}</div>
              </div>
              <span className="recent-played-label">{formatTimeAgo(lastPlayedMs)}</span>
            </div>
          )
        })}
      </div>

      {loadingMore && <div className="recent-loading-more">Загрузка...</div>}
      {hasMore && <div ref={sentinelRef} className="recent-sentinel" />}
    </div>
  )
}

export default RecentlyPlayed
