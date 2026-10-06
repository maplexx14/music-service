import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Pause, Play } from 'lucide-react'
import { usePlayerStore, trackLikeKey } from '../store/playerStore'
import api from '../services/api'
import Spinner from '../components/Spinner'
import ArtistLink from '../components/ArtistLink'
import LikeHeart from '../components/LikeHeart'
import { haptic, HAPTIC } from '../utils/haptics'
import { formatDuration } from '../utils/format'
import defaultCover from '../assets/default-cover.webp'
import { handleCoverError, resolveCoverUrl } from '../utils/media'
import './PlaylistDetail.css'

// Страница одного трека — сюда ведёт «Поделиться» из полноэкранного плеера
// (/track/:id, id записи в БД: внешний трек перед шарингом материализуется).
// Автозапуска нет: браузер не даст включить звук без жеста пользователя.
function Track() {
  const { id } = useParams()
  const [track, setTrack] = useState(null)
  const [loading, setLoading] = useState(true)
  const [missing, setMissing] = useState(false)
  const playTrack = usePlayerStore((s) => s.playTrack)
  const togglePlayPause = usePlayerStore((s) => s.togglePlayPause)
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const likedTrackIds = usePlayerStore((s) => s.likedTrackIds)
  const pendingLikeKeys = usePlayerStore((s) => s.pendingLikeKeys)
  const toggleLikeForTrack = usePlayerStore((s) => s.toggleLikeForTrack)
  const fetchLikedTracks = usePlayerStore((s) => s.fetchLikedTracks)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setMissing(false)
    api
      .get(`/tracks/${id}`, { skipErrorToast: true })
      .then(({ data }) => {
        if (!cancelled) setTrack(data)
      })
      .catch(() => {
        if (!cancelled) setMissing(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [id])

  useEffect(() => {
    fetchLikedTracks().catch(() => {})
  }, [fetchLikedTracks])

  if (loading) return <Spinner page />

  if (missing || !track) {
    return (
      <div className="page-container">
        <div className="empty-playlist">
          <p>Трек не найден</p>
        </div>
      </div>
    )
  }

  const isCurrent = currentTrack?.id === track.id || currentTrack?.db_id === track.id
  const isLiked = likedTrackIds.includes(track.id) || pendingLikeKeys.includes(trackLikeKey(track))

  const handlePlay = () => {
    if (isCurrent) togglePlayPause()
    else playTrack(track, [track])
  }

  const handleLike = () => {
    haptic(HAPTIC.success)
    toggleLikeForTrack(track).catch((error) => console.error('Error toggling like:', error))
  }

  return (
    <div className="page-container">
      <div className="playlist-header">
        <img
          src={resolveCoverUrl(track.cover_url, true) || defaultCover}
          alt={track.title}
          className="playlist-header-cover"
          onError={handleCoverError}
        />
        <div className="playlist-header-info">
          <div className="playlist-type">Трек</div>
          <h1 className="playlist-title">{track.title}</h1>
          <div className="playlist-meta">
            {track.artist && <ArtistLink artist={track.artist} />}
            {track.album && (
              <>
                <span>•</span>
                <span>{track.album}</span>
              </>
            )}
            {track.duration > 0 && (
              <>
                <span>•</span>
                <span>{formatDuration(track.duration)}</span>
              </>
            )}
          </div>
          <div className="playlist-actions">
            <button className="play-button-large" onClick={handlePlay}>
              {isCurrent && isPlaying ? (
                <Pause size={24} fill="currentColor" />
              ) : (
                <Play size={24} fill="currentColor" />
              )}
              {isCurrent && isPlaying ? 'Пауза' : 'Слушать'}
            </button>
            <button
              className="play-button-large secondary"
              onClick={handleLike}
              aria-pressed={isLiked}
            >
              <LikeHeart size={20} liked={isLiked} />
              {isLiked ? 'В понравившихся' : 'Нравится'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default Track
