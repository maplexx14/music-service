import { useEffect, useState } from 'react'
import { usePlayerStore } from '../store/playerStore'
import api from '../services/api'
import './Home.css'

function Home() {
  const [recommendations, setRecommendations] = useState({ tracks: [], playlists: [] })
  const [trending, setTrending] = useState([])
  const [loading, setLoading] = useState(true)
  const { playPlaylist } = usePlayerStore()

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

  const handlePlayTrack = (track) => {
    const { playTrack } = usePlayerStore.getState()
    playTrack(track, recommendations.tracks)
  }

  const handlePlayPlaylist = (playlist) => {
    if (playlist.tracks && playlist.tracks.length > 0) {
      playPlaylist(playlist.tracks, 0)
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
    <div className="page-container">
      <div className="hero-section">
        <div className="hero-content">
          <h1>Моя волна</h1>
          <p>Персонализированная подборка музыки для вас</p>
          <button className="play-button" onClick={() => handlePlayPlaylist({ tracks: recommendations.tracks })}>
            ▶ Воспроизвести
          </button>
        </div>
      </div>

      <div className="content-section">
        <h2 className="section-title">Рекомендуем новинки</h2>
        <div className="tracks-grid">
          {recommendations.tracks.slice(0, 12).map((track) => (
            <div key={track.id} className="track-card" onClick={() => handlePlayTrack(track)}>
              {track.cover_url ? (
                <img src={track.cover_url} alt={track.title} className="track-cover" />
              ) : (
                <div className="track-cover placeholder">♪</div>
              )}
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
            <div key={track.id} className="track-card" onClick={() => handlePlayTrack(track)}>
              {track.cover_url ? (
                <img src={track.cover_url} alt={track.title} className="track-cover" />
              ) : (
                <div className="track-cover placeholder">♪</div>
              )}
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
                {playlist.cover_url ? (
                  <img src={playlist.cover_url} alt={playlist.name} className="playlist-cover" />
                ) : (
                  <div className="playlist-cover placeholder">♪</div>
                )}
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
    </div>
  )
}

export default Home
