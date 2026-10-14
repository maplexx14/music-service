import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Pause, Play, RotateCcw } from 'lucide-react'
import api from '../services/api'
import { API_URL } from '../config'
import Spinner from '../components/Spinner'
import { formatDuration } from '../utils/format'
import { withQuality } from '../utils/streamQuality'
import defaultCover from '../assets/default-cover.webp'
import { handleCoverError, resolveCoverUrl } from '../utils/media'
import './Auth.css'
import './GuestTrack.css'

// Трек из «Поделиться» для незалогиненного: послушать можно сразу, без
// регистрации. Плеер приложения (очередь, Media Session, телеметрия) живёт в
// Layout и завязан на аккаунт, поэтому здесь свой <audio> — только этот трек.
// Дослушал до конца — предлагаем зарегистрироваться.
function GuestTrack() {
  const { id } = useParams()
  const audioRef = useRef(null)
  const [track, setTrack] = useState(null)
  const [loading, setLoading] = useState(true)
  const [missing, setMissing] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [finished, setFinished] = useState(false)

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
    if (!track) return undefined
    const title = track.artist ? `${track.artist} — ${track.title}` : track.title
    const previous = document.title
    document.title = `${title} · bolt`
    return () => {
      document.title = previous
    }
  }, [track])

  if (loading) return <Spinner page />

  if (missing || !track) {
    return (
      <div className="auth-container">
        <div className="auth-card guest-track-card">
          <p className="guest-track-missing">Трек не найден</p>
          <Link className="btn btn--primary btn--lg btn--block" to="/register">
            Зарегистрироваться
          </Link>
        </div>
      </div>
    )
  }

  // Длительность из БД: в ADTS (iOS) duration элемента оценочная и плывёт.
  const duration = track.duration > 0 ? track.duration : audioRef.current?.duration || 0
  const progress = duration > 0 ? Math.min(1, position / duration) : 0
  const loginPath = `/login?next=${encodeURIComponent(`/track/${track.id}`)}`

  const toggle = () => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) {
      audio.play().catch((error) => console.error('Guest playback failed:', error))
    } else {
      audio.pause()
    }
  }

  const replay = () => {
    setFinished(false)
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = 0
    audio.play().catch((error) => console.error('Guest playback failed:', error))
  }

  const seek = (event) => {
    const audio = audioRef.current
    if (!audio || !duration) return
    audio.currentTime = Number(event.target.value)
    setPosition(audio.currentTime)
  }

  return (
    <div className="auth-container">
      <div className="auth-card guest-track-card">
        <img
          src={resolveCoverUrl(track.cover_url, true) || defaultCover}
          alt={track.title}
          className="guest-track-cover"
          onError={handleCoverError}
        />
        <div className="guest-track-info">
          <h1 className="guest-track-title">{track.title}</h1>
          {track.artist && <p className="guest-track-artist">{track.artist}</p>}
        </div>

        <audio
          ref={audioRef}
          src={withQuality(`${API_URL}/tracks/${track.id}/stream`)}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
          onEnded={() => {
            setPlaying(false)
            setFinished(true)
          }}
        />

        <div className="guest-track-progress">
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={Math.min(position, duration || 0)}
            onChange={seek}
            aria-label="Позиция в треке"
            style={{ '--progress': `${progress * 100}%` }}
          />
          <div className="guest-track-times">
            <span>{formatDuration(Math.floor(position))}</span>
            <span>{duration ? formatDuration(Math.round(duration)) : '—'}</span>
          </div>
        </div>

        <button type="button" className="btn btn--primary btn--lg btn--block" onClick={toggle}>
          {playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
          {playing ? 'Пауза' : 'Слушать'}
        </button>

        <p className="guest-track-footer">
          Уже есть аккаунт? <Link to={loginPath}>Войти</Link>
        </p>
      </div>

      {finished && (
        <div className="guest-track-backdrop">
          <div className="guest-track-dialog" role="dialog" aria-modal="true" aria-labelledby="guest-signup-title">
            <h2 id="guest-signup-title">Понравилось?</h2>
            <p>
              Зарегистрируйтесь — и слушайте дальше: волна под ваш вкус, лайки и плейлисты.
            </p>
            <Link className="btn btn--primary btn--lg btn--block" to="/register">
              Зарегистрироваться
            </Link>
            <Link className="btn btn--secondary btn--lg btn--block" to={loginPath}>
              Войти
            </Link>
            <button type="button" className="btn btn--lg btn--block guest-track-replay" onClick={replay}>
              <RotateCcw size={18} />
              Послушать ещё раз
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default GuestTrack
