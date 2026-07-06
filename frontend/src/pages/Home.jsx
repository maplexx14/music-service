import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Search, Play, Pause, Settings, Shield, Home as HomeIcon, History } from 'lucide-react'
import { usePlayerStore } from '../store/playerStore'
import { useWaveSettingsStore } from '../store/waveSettingsStore'
import { useUiSettingsStore } from '../store/uiSettingsStore'
import api from '../services/api'
import defaultCover from '../assets/default-cover.svg'
import { resolveCoverUrl, handleCoverError } from '../utils/media'
import Grainient from '../components/Grainient'
import Spinner from '../components/Spinner'
import './Home.css'

function Home() {
  const [recommendations, setRecommendations] = useState({ tracks: [], playlists: [] })
  const [trending, setTrending] = useState([])
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [activeTab, setActiveTab] = useState('home')
  const { playPlaylist, isPlaying, source, togglePlayPause } = usePlayerStore()
  const waveGif = useWaveSettingsStore((s) => s.waveGif)
  const liteMode = useUiSettingsStore((s) => s.liteMode)
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false)
  const navigate = useNavigate()

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

  const fetchHistory = async () => {
    setHistoryLoading(true)
    try {
      const response = await api.get('/tracks/me/history', { params: { limit: 30 } })
      setHistory(response.data)
    } catch (error) {
      console.error('Error fetching history:', error)
    } finally {
      setHistoryLoading(false)
    }
  }

  const handlePlayTrack = (track, queue) => {
    const { playTrack } = usePlayerStore.getState()
    playTrack(track, queue, 'wave')
  }

  const handlePlayPlaylist = (playlist) => {
    if (playlist.tracks && playlist.tracks.length > 0) {
      playPlaylist(playlist.tracks, 0, 'wave')
    }
  }

  const isWavePlaying = isPlaying && source === 'wave'
  const waveTracks = recommendations.tracks.length > 0 ? recommendations.tracks : trending
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
        <Spinner />
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
              <Link to="/admin" className="mobile-profile-item">
                <Shield size={20} />
                Админ
              </Link>
            </div>
          )}
        </div>
      </div>
      <div className="hero-section">
        <div className="hero-grainient">
          {liteMode ? (
            <div className="hero-grainient-static" />
          ) : (
            <Grainient
              color1="#e0c3ff"
              color2="#a259ff"
              color3="#6a3093"
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
          )}
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

      <div className="home-tabs">
        <button
          type="button"
          className={`home-tab-card ${activeTab === 'home' ? 'active' : ''}`}
          onClick={() => setActiveTab('home')}
        >
          <span className="home-tab-icon">
            <HomeIcon size={20} />
          </span>
          <span className="home-tab-text">
            <span className="home-tab-title">Главная</span>
            <span className="home-tab-subtitle">Рекомендации и подборки</span>
          </span>
        </button>
        <button
          type="button"
          className={`home-tab-card ${activeTab === 'history' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('history')
            if (history.length === 0 && !historyLoading) {
              fetchHistory()
            }
          }}
        >
          <span className="home-tab-icon">
            <History size={20} />
          </span>
          <span className="home-tab-text">
            <span className="home-tab-title">История</span>
            <span className="home-tab-subtitle">Недавно слушали</span>
          </span>
        </button>
      </div>

      {activeTab === 'home' ? (
        <>
          <div className="content-section">
            <h2 className="section-title">Рекомендуем новинки</h2>
            <div className="tracks-grid">
              {recommendations.tracks.slice(0, 12).map((track) => (
                <div key={track.id} className="track-card" onClick={() => handlePlayTrack(track, recommendations.tracks)}>
                  <img
                    src={resolveCoverUrl(track.cover_url) || defaultCover}
                    alt={track.title}
                    className="track-cover"
                    onError={handleCoverError}
                  />
                  <div className="track-info">
                    <div className="track-title">{track.title}</div>
                    <div className="track-artist">{track.artist}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="content-section">
            <h2 className="section-title">Тренды</h2>
            <div className="tracks-grid">
              {trending.slice(0, 12).map((track) => (
                <div key={track.id} className="track-card" onClick={() => handlePlayTrack(track, trending)}>
                  <img
                    src={resolveCoverUrl(track.cover_url) || defaultCover}
                    alt={track.title}
                    className="track-cover"
                    onError={handleCoverError}
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
                  <div
                    key={playlist.id}
                    className="playlist-card"
                    onClick={() => handlePlayPlaylist(playlist)}
                  >
                    <img
                      src={resolveCoverUrl(playlist.cover_url) || defaultCover}
                      alt={playlist.name}
                      className="playlist-cover"
                      onError={handleCoverError}
                    />
                    <div className="playlist-info">
                      <div className="playlist-name">{playlist.name}</div>
                      {playlist.description && (
                        <div className="playlist-description">{playlist.description}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="content-section">
          <h2 className="section-title">История прослушиваний</h2>
          {historyLoading ? (
            <Spinner />
          ) : history.length === 0 ? (
            <div className="home-empty">Пока нет истории прослушивания</div>
          ) : (
            <div className="tracks-grid">
              {history.map((track) => (
                <div key={track.id} className="track-card" onClick={() => handlePlayTrack(track, history)}>
                  <img
                    src={resolveCoverUrl(track.cover_url) || defaultCover}
                    alt={track.title}
                    className="track-cover"
                    onError={handleCoverError}
                  />
                  <div className="track-info">
                    <div className="track-title">{track.title}</div>
                    <div className="track-artist">{track.artist}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

    
    </div>
  )
}

export default Home
