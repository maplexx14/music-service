import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { usePlayerStore } from '../store/playerStore'
import { Heart, ChevronRight, Plus, Music } from 'lucide-react'
import api from '../services/api'
import defaultCover from '../assets/default-cover.svg'
import { resolveCoverUrl } from '../utils/media'
import './LikedSongs.css'

function LikedSongs() {
  const [tracks, setTracks] = useState([])
  const [playlists, setPlaylists] = useState([])
  const [likedPlaylists, setLikedPlaylists] = useState([])
  const [likedArtists, setLikedArtists] = useState([])
  const [loading, setLoading] = useState(true)
  const [playlistTab, setPlaylistTab] = useState('created') // 'created' | 'liked'
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [newPlaylistName, setNewPlaylistName] = useState('')
  const [coverFile, setCoverFile] = useState(null)
  const { playPlaylist } = usePlayerStore()

  useEffect(() => {
    fetchData()
  }, [])

  const fetchData = async () => {
    try {
      const [tracksRes, playlistsRes, likedPlRes, artistsRes] = await Promise.all([
        api.get('/tracks/me/liked'),
        api.get('/playlists/me'),
        api.get('/playlists/me/liked'),
        api.get('/users/me/liked/artists'),
      ])
      setTracks([...tracksRes.data].reverse())
      setPlaylists(playlistsRes.data)
      setLikedPlaylists(likedPlRes.data)
      setLikedArtists(artistsRes.data)
    } catch (error) {
      console.error('Error fetching data:', error)
    } finally {
      setLoading(false)
    }
  }

  const formatTime = (seconds) => {
    if (!seconds) return '0:00'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const handlePlay = () => {
    if (tracks.length > 0) {
      playPlaylist(tracks, 0)
    }
  }

  const handlePlayTrack = (track, index) => {
    playPlaylist(tracks, index)
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

  const handleCreatePlaylist = async (e) => {
    e.preventDefault()
    if (!newPlaylistName.trim()) return

    try {
      const response = await api.post('/playlists', {
        name: newPlaylistName,
        is_public: true,
      })
      let createdPlaylist = response.data
      if (coverFile) {
        const coverForm = new FormData()
        coverForm.append('cover', coverFile)
        const coverResponse = await api.post(`/playlists/${response.data.id}/cover`, coverForm, {
          headers: { 'Content-Type': 'multipart/form-data' },
        })
        createdPlaylist = coverResponse.data
      }
      setPlaylists([...playlists, createdPlaylist])
      setNewPlaylistName('')
      setCoverFile(null)
      setShowCreateForm(false)
    } catch (error) {
      console.error('Error creating playlist:', error)
    }
  }

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading">Загрузка...</div>
      </div>
    )
  }

  // Show max 4 tracks in the compact liked section, with 2 columns
  const previewTracks = tracks.slice(0, 8)

  return (
    <div className="page-container collection-page">
      <header className="collection-header">
        <h1 className="collection-title">Коллекция</h1>
        <p className="collection-subtitle">У вашей музыки есть <span className="highlight">цвет</span></p>
      </header>

      {/* ===== LIKED TRACKS SECTION ===== */}
      <section className="liked-hub-section">
        <Link to="/liked-all" className="liked-hub-card">
          <div className="liked-hub-icon">
            <Heart size={32} fill="currentColor" />
          </div>
          <div className="liked-hub-content">
            <h2 className="liked-hub-title">
              Мне нравится
              <ChevronRight size={20} className="chevron-icon" />
            </h2>
            <span className="liked-hub-count">{tracks.length} треков</span>
          </div>
        </Link>

        {previewTracks.length > 0 ? (
          <div className="collection-tracks-list">
            {previewTracks.map((track, index) => (
              <div
                key={track.id}
                className="collection-track-item"
                onClick={() => handlePlayTrack(track, index)}
              >
                <img
                  src={resolveCoverUrl(track.cover_url) || defaultCover}
                  alt={track.title}
                  className="collection-track-cover"
                />
                <div className="collection-track-info">
                  <div className="collection-track-name">{track.title}</div>
                  <div className="collection-track-artist">{track.artist}</div>
                </div>
                <button
                  className={`collection-track-heart ${unlikedIds.has(track.id) ? 'unliked' : ''}`}
                  onClick={(e) => handleToggleLike(e, track.id)}
                  title={unlikedIds.has(track.id) ? 'Удалено из понравившихся' : 'Убрать из понравившихся'}
                >
                  <Heart size={22} fill={unlikedIds.has(track.id) ? 'none' : 'currentColor'} />
                </button>
                <span className="collection-track-duration">{formatTime(track.duration)}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="liked-empty">
            <p>У вас пока нет понравившихся треков</p>
          </div>
        )}
      </section>

      {/* ===== PLAYLISTS SECTION ===== */}
      <section className="playlists-section">
        <div className="playlists-section-header">
          <Link to="/playlists" className="playlists-section-title-link">
            <h2 className="playlists-section-title">
              Мои плейлисты
              <ChevronRight size={22} className="chevron-icon" />
            </h2>
          </Link>
        </div>

        <div className="playlist-tabs">
          <button
            className={`playlist-tab ${playlistTab === 'created' ? 'active' : ''}`}
            onClick={() => setPlaylistTab('created')}
          >
            Вы собрали
          </button>
          <button
            className={`playlist-tab ${playlistTab === 'liked' ? 'active' : ''}`}
            onClick={() => setPlaylistTab('liked')}
          >
            Вам понравилось
          </button>
        </div>

        {showCreateForm && (
          <form onSubmit={handleCreatePlaylist} className="create-form-inline">
            <input
              type="text"
              placeholder="Название плейлиста"
              value={newPlaylistName}
              onChange={(e) => setNewPlaylistName(e.target.value)}
              autoFocus
            />
            <input
              type="file"
              accept="image/*"
              onChange={(e) => setCoverFile(e.target.files?.[0] || null)}
            />
            <div className="create-form-actions">
              <button type="submit" className="create-form-submit">Создать</button>
              <button
                type="button"
                className="create-form-cancel"
                onClick={() => {
                  setShowCreateForm(false)
                  setNewPlaylistName('')
                  setCoverFile(null)
                }}
              >
                Отмена
              </button>
            </div>
          </form>
        )}

        {playlistTab === 'created' && (
          <div className="playlists-scroll-grid">
            <div
              className="playlist-card-sm create-card"
              onClick={() => setShowCreateForm(true)}
            >
              <div className="create-card-icon">
                <Plus size={36} />
              </div>
            </div>
            {playlists.map((playlist) => (
              <Link key={playlist.id} to={`/playlists/${playlist.id}`} className="playlist-card-sm">
                <img
                  src={resolveCoverUrl(playlist.cover_url) || defaultCover}
                  alt={playlist.name}
                  className="playlist-card-cover"
                />
                <div className="playlist-card-name">{playlist.name}</div>
              </Link>
            ))}
            {playlists.length === 0 && (
              <div className="playlists-empty-hint">
                <p>Создайте свой первый плейлист</p>
              </div>
            )}
            {/* Added a dummy card to match the image's music note icon */}
            <div className="playlist-card-sm dummy-card">
              <div className="dummy-card-icon">
                <Music size={36} />
              </div>
            </div>
          </div>
        )}

        {playlistTab === 'liked' && (
          <div className="playlists-scroll-grid">
            {likedPlaylists.length > 0 ? (
              likedPlaylists.map((lp) => {
                const pl = lp.playlist
                if (!pl) return null
                return (
                  <Link key={lp.id} to={`/playlists/${pl.id}`} className="playlist-card-sm">
                    <img
                      src={resolveCoverUrl(pl.cover_url) || defaultCover}
                      alt={pl.name}
                      className="playlist-card-cover"
                    />
                    <div className="playlist-card-name">{pl.name}</div>
                  </Link>
                )
              })
            ) : (
              <div className="playlists-empty-hint">
                <Music size={32} />
                <p>Понравившиеся плейлисты будут здесь</p>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  )
}

export default LikedSongs
