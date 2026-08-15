import { useEffect, useMemo, useState } from 'react'
import api from '../services/api'
import { toast } from '../store/toastStore'
import Spinner from '../components/Spinner'
import defaultCover from '../assets/default-cover.svg'
import { resolveCoverUrl, handleCoverError } from '../utils/media'
import './Admin.css'

function Admin() {
  const [stats, setStats] = useState({ users_count: 0, online_users_count: 0, tracks_count: 0, artists_count: 0 })
  const [users, setUsers] = useState([])
  const [tracks, setTracks] = useState([])
  const [loading, setLoading] = useState(true)
  const [deletingId, setDeletingId] = useState(null)
  const [searchTerm, setSearchTerm] = useState('')

  const fetchAdminData = async () => {
    setLoading(true)
    try {
      const [dashboardResponse, tracksResponse] = await Promise.all([
        api.get('/users/admin/dashboard'),
        api.get('/tracks?limit=200'),
      ])
      setStats(dashboardResponse.data)
      setUsers(dashboardResponse.data.users || [])
      setTracks(tracksResponse.data || [])
    } catch (error) {
      console.error('Error fetching admin data:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchAdminData()
  }, [])

  const filteredTracks = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    if (!term) return tracks
    return tracks.filter((track) => {
      const title = track.title?.toLowerCase() || ''
      const artist = track.artist?.toLowerCase() || ''
      return title.includes(term) || artist.includes(term)
    })
  }, [tracks, searchTerm])

  const handleDelete = async (trackId) => {
    if (!trackId) return
    const confirmed = window.confirm('Удалить трек? Это действие нельзя отменить.')
    if (!confirmed) return
    setDeletingId(trackId)
    try {
      await api.delete(`/tracks/${trackId}`)
      setTracks((prev) => prev.filter((track) => track.id !== trackId))
      toast.success('Трек удалён')
    } catch (error) {
      console.error('Error deleting track:', error)
    } finally {
      setDeletingId(null)
    }
  }

  if (loading) {
    return (
      <div className="page-container">
        <Spinner />
      </div>
    )
  }

  return (
    <div className="page-container admin-page">
      <div className="admin-header">
        <div>
          <h1 className="admin-title">Админ панель</h1>
          <div className="admin-subtitle">Сводка по сервису</div>
        </div>
        <button type="button" className="admin-refresh" onClick={fetchAdminData}>
          Обновить
        </button>
      </div>

      <div className="admin-stats">
        {[
          ['Пользователи', stats.users_count],
          ['Сейчас онлайн', stats.online_users_count],
          ['Треки', stats.tracks_count],
          ['Артисты', stats.artists_count],
        ].map(([label, value]) => <div className="admin-stat" key={label}><strong>{value}</strong><span>{label}</span></div>)}
      </div>

      <div className="admin-section">
        <div className="admin-section-title">Профили пользователей</div>
        <div className="admin-users">
          {users.map((user) => <div className="admin-user" key={user.id}>
            <div className="admin-user-main"><strong>{user.username}</strong><span>{user.email}</span></div>
            <div className="admin-user-preferences"><span>Жанры: {(user.preferred_genres || []).join(', ') || 'не указаны'}</span><span>Артисты: {(user.preferred_artists || []).join(', ') || 'не указаны'}</span><span className="admin-user-detected">Определены системой: {(user.detected_artists || []).join(', ') || 'нет данных'}</span></div>
          </div>)}
        </div>
      </div>

      <div className="admin-section">
        <div className="admin-section-head">
          <div className="admin-section-title">Треки</div>
          <input
            type="text"
            className="admin-search-input"
            placeholder="Поиск по названию или артисту"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        {filteredTracks.length === 0 ? (
          <div className="admin-empty">Треки не найдены</div>
        ) : (
          <div className="admin-tracks">
            {filteredTracks.map((track) => (
              <div key={track.id} className="admin-track">
                <img
                  src={resolveCoverUrl(track.cover_url) || defaultCover}
                  alt={track.title}
                  className="admin-track-cover"
                  loading="lazy"
                  decoding="async"
                  onError={handleCoverError}
                />
                <div className="admin-track-info">
                  <div className="admin-track-title">{track.title}</div>
                  <div className="admin-track-artist">{track.artist}</div>
                </div>
                <button
                  type="button"
                  className="admin-delete"
                  onClick={() => handleDelete(track.id)}
                  disabled={deletingId === track.id}
                >
                  {deletingId === track.id ? 'Удаление...' : 'Удалить'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default Admin
