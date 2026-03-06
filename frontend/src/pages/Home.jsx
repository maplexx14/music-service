import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Search, Play, Pause, Settings, MoreHorizontal } from 'lucide-react'
import { usePlayerStore } from '../store/playerStore'
import { useWaveSettingsStore } from '../store/waveSettingsStore'
import api from '../services/api'
import defaultCover from '../assets/default-cover.svg'
import { resolveCoverUrl } from '../utils/media'
import Grainient from '../components/Grainient'
import './Home.css'

function Home() {
  const [recommendations, setRecommendations] = useState({ tracks: [], playlists: [] })
  const [trending, setTrending] = useState([])
  const [loading, setLoading] = useState(true)
  const { playPlaylist, isPlaying, source, togglePlayPause } = usePlayerStore()
  const waveGif = useWaveSettingsStore((s) => s.waveGif)
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false)
  const navigate = useNavigate()

  const streamColors = useMemo(() => {
    const s = getComputedStyle(document.documentElement)
    return {
      color1: s.getPropertyValue('--stream-color-1').trim() || '#aef0b1',
      color2: s.getPropertyValue('--stream-color-2').trim() || '#7d98a8',
      color3: s.getPropertyValue('--stream-color-3').trim() || '#B19EEF',
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [])

  const fetchData = async () => {
    try {
      const [recResponse, tracksResponse] = await Promise.all([
        api.get('/recommendations'),
        api.get('/tracks?limit=20'),
      ])
      setRecommendations(recResponse.data)
      setTrending(tracksResponse.data)
    } catch (error) {
      console.error('Error fetching data:', error)
    } finally {
      setLoading(false)
    }
  }

  const waveTracks = useMemo(() => {
    const merged = [...recommendations.tracks, ...trending]
    const unique = []
    const seen = new Set()
    for (const track of merged) {
      const key = track?.id ?? `${track?.title ?? ''}:${track?.artist ?? ''}`
      if (!seen.has(key)) {
        seen.add(key)
        unique.push(track)
      }
    }
    return unique
  }, [recommendations.tracks, trending])

  const handlePlayTrack = (track) => {
    const { playTrack } = usePlayerStore.getState()
    playTrack(track, waveTracks, 'wave')
  }

  const handlePlayPlaylist = (playlist) => {
    if (playlist.tracks && playlist.tracks.length > 0) {
      playPlaylist(playlist.tracks, 0, 'wave')
    }
  }

  const isWavePlaying = isPlaying && source === 'wave'
  const waveReady = waveTracks.length > 0
  const upcomingText = useMemo(() => {
    if (!waveTracks.length) return ''
    return waveTracks.slice(0, 4).map((track) => track.title).join(', ')
  }, [waveTracks])
  const handleWaveClick = () => {
    if (!waveReady) return
    if (isWavePlaying) {
      togglePlayPause()
      return
    }
    handlePlayPlaylist({ tracks: waveTracks })
  }

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading">Загрузка...</div>
      </div>
    )
  }

  return (
    <div className="page-container">
      <div className="mobile-header">
        <button
          className="icon-btn"
          type="button"
          aria-label="Поиск"
          onClick={() => navigate('/search')}
        >
          <Search size={20} />
        </button>

        <span className="mobile-logo">BoltMusic</span>
        <div className="mobile-profile">
          <button
            className="mobile-avatar"
            type="button"
            aria-label="Профиль"
            onClick={() => setIsProfileMenuOpen((prev) => !prev)}
          >
            <span>BM</span>
          </button>
          {isProfileMenuOpen && (
            <div className="mobile-profile-menu">
              <Link to="/settings" className="mobile-profile-item">
                <Settings size={20} />
                Настройки
              </Link>
            </div>
          )}
        </div>
      </div>
      <div className="hero-section">
        <div className="hero-grainient">
          <Grainient
            color1={streamColors.color1}
            color2={streamColors.color2}
            color3={streamColors.color3}
            timeSpeed={5}
            colorBalance={-0.32}
            warpStrength={1.4}
            warpFrequency={5}
            warpSpeed={2}
            warpAmplitude={50}
            blendAngle={-49}
            blendSoftness={0.05}
            rotationAmount={500}
            noiseScale={1.95}
            grainAmount={0}
            grainScale={0.2}
            grainAnimated={false}
            contrast={1.5}
            gamma={1}
            saturation={1}
            centerX={0}
            centerY={0}
            zoom={0.9}
            active={isWavePlaying}
          />
        </div>
        <div className={`wave-widget ${isWavePlaying ? 'is-playing' : ''}`}>
          <div className="wave-center">
            {waveGif ? (
              <button type="button" onClick={handleWaveClick} className="wave-gif-button" aria-label="поток рекомендаций">
                <img
                  src={isWavePlaying ? waveGif : `${waveGif}${waveGif.includes('#') ? '&' : '#'}paused`}
                  alt="поток рекомендаций"
                />
                <span className="wave-gif-icon">
                  {isWavePlaying ? <Pause size={20} /> : <Play size={20} />}
                </span>
              </button>
            ) : (
              <button type="button" onClick={handleWaveClick} className="wave-title">
                {isWavePlaying ? <Pause size={20} /> : <Play size={20} />}
                <span>поток</span>
              </button>
            )}

          </div>
        </div>
      </div>

      <div className="content-section">
        <h2 className="section-title">Рекомендуем новинки</h2>
        <div className="tracks-grid">
          {recommendations.tracks.slice(0, 12).map((track) => (
            <div key={track.id} className="track-card" onClick={() => handlePlayTrack(track)}>
              <img
                src={resolveCoverUrl(track.cover_url) || defaultCover}
                alt={track.title}
                className="track-cover"
              />
              <div className="track-info">
                <div className="track-title">{track.title}</div>
                <div className="track-artist">{track.artist}</div>
              </div>
              <button className="track-more-btn" onClick={(e) => e.stopPropagation()}>
                <MoreHorizontal size={20} />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="content-section">
        <h2 className="section-title">Тренды</h2>
        <div className="tracks-grid">
          {trending.slice(0, 12).map((track) => (
            <div key={track.id} className="track-card" onClick={() => handlePlayTrack(track)}>
              <img
                src={resolveCoverUrl(track.cover_url) || defaultCover}
                alt={track.title}
                className="track-cover"
              />
              <div className="track-info">
                <div className="track-title">{track.title}</div>
                <div className="track-artist">{track.artist}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {recommendations.playlists.length > 0 && (
        <div className="content-section">
          <h2 className="section-title">Рекомендуемые плейлисты</h2>
          <div className="playlists-grid">
            {recommendations.playlists.map((playlist) => (
              <Link
                key={playlist.id}
                to={`/playlists/${playlist.id}`}
                className="playlist-card"
              >
                <img
                  src={resolveCoverUrl(playlist.cover_url) || defaultCover}
                  alt={playlist.name}
                  className="playlist-cover"
                />
                <div className="playlist-info">
                  <div className="playlist-name">{playlist.name}</div>
                  {playlist.description && (
                    <div className="playlist-description">{playlist.description}</div>
                  )}
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}


    </div>
  )
}

export default Home
