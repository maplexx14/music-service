import { useState, useEffect } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { Users, Music, Activity, ShieldBan, Trash2 } from 'lucide-react'
import api from '../services/api'
import './Admin.css'

function Admin() {
  const { user } = useAuthStore()
  const [stats, setStats] = useState(null)
  const [users, setUsers] = useState([])
  const [tracks, setTracks] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [searchUsers, setSearchUsers] = useState('')
  const [searchTracks, setSearchTracks] = useState('')

  useEffect(() => {
    if (!user?.is_admin) return

    const fetchAdminData = async () => {
      try {
        setLoading(true)
        const [statsRes, searchRes] = await Promise.all([
          api.get('/admin/stats'),
          // Use the existing search endpoint to get users and tracks with a wide query
          api.get('/search', { params: { q: 'a', limit: 100 } })
        ])

        setStats(statsRes.data)
        // Extract users and limit for display initially
        setUsers(searchRes.data.users || [])
        setTracks(searchRes.data.tracks || [])
      } catch (err) {
        setError('Не удалось загрузить панель: ' + (err.response?.data?.detail || err.message))
      } finally {
        setLoading(false)
      }
    }

    fetchAdminData()
  }, [user])

  const handleSearchUsers = async (e) => {
    e.preventDefault()
    if (!searchUsers.trim()) return
    try {
      const res = await api.get('/search', { params: { q: searchUsers, limit: 50 } })
      setUsers(res.data.users || [])
    } catch (err) {
      console.error(err)
    }
  }

  const handleSearchTracks = async (e) => {
    e.preventDefault()
    if (!searchTracks.trim()) return
    try {
      const res = await api.get('/search', { params: { q: searchTracks, limit: 50 } })
      setTracks(res.data.tracks || [])
    } catch (err) {
      console.error(err)
    }
  }

  const handleBanUser = async (userId, isBanned) => {
    try {
      if (isBanned) {
        await api.put(`/admin/users/${userId}/unban`)
      } else {
        await api.put(`/admin/users/${userId}/ban`)
      }
      // Update local state
      setUsers(users.map(u => u.id === userId ? { ...u, is_active: isBanned } : u))
    } catch (err) {
      alert(err.response?.data?.detail || 'Действие не выполнено')
    }
  }

  const handleDeleteTrack = async (trackId) => {
    if (!window.confirm('Вы уверены, что хотите удалить этот трек?')) return

    try {
      await api.delete(`/admin/tracks/${trackId}`)
      // Update local state
      setTracks(tracks.filter(t => t.id !== trackId))
      setStats(prev => ({ ...prev, total_tracks: prev.total_tracks - 1 }))
    } catch (err) {
      alert(err.response?.data?.detail || 'Ошибка при удалении')
    }
  }

  if (!user?.is_admin) {
    return <Navigate to="/" replace />
  }

  if (loading) {
    return <div className="admin-container"><div className="admin-loading">Загрузка панели...</div></div>
  }

  if (error) {
    return <div className="admin-container"><div className="admin-error">{error}</div></div>
  }

  return (
    <div className="admin-container">
      <h1 className="admin-title">Панель Администратора</h1>

      <div className="admin-stats">
        <div className="stat-card">
          <Users size={32} className="stat-icon" />
          <div className="stat-info">
            <span className="stat-value">{stats?.total_users || 0}</span>
            <span className="stat-label">Всего пользователей</span>
          </div>
        </div>
        <div className="stat-card">
          <Music size={32} className="stat-icon" />
          <div className="stat-info">
            <span className="stat-value">{stats?.total_tracks || 0}</span>
            <span className="stat-label">Всего треков</span>
          </div>
        </div>
        <div className="stat-card">
          <Activity size={32} className="stat-icon" />
          <div className="stat-info">
            <span className="stat-value">{stats?.online_users || 0}</span>
            <span className="stat-label">Пользователей онлайн</span>
          </div>
        </div>
      </div>

      <div className="admin-sections">
        <div className="admin-section">
          <h2>Управление пользователями</h2>
          <form className="admin-search" onSubmit={handleSearchUsers}>
            <input
              type="text"
              placeholder="Поиск пользователей..."
              value={searchUsers}
              onChange={e => setSearchUsers(e.target.value)}
            />
            <button type="submit" className="admin-btn">Найти</button>
          </form>

          <div className="admin-list">
            {users.map(u => (
              <div key={u.id} className="admin-list-item">
                <div className="admin-item-info">
                  <span className="admin-item-name">{u.username}</span>
                  <span className="admin-item-sub">{u.email} {u.is_admin ? '(Админ)' : ''}</span>
                </div>
                {!u.is_admin && (
                  <button
                    onClick={() => handleBanUser(u.id, !u.is_active)}
                    className={`admin-action-btn ${!u.is_active ? 'unban' : 'ban'}`}
                  >
                    <ShieldBan size={16} />
                    {u.is_active ? 'Заблокировать' : 'Разблокировать'}
                  </button>
                )}
              </div>
            ))}
            {users.length === 0 && <div className="admin-empty">Пользователи не найдены</div>}
          </div>
        </div>

        <div className="admin-section">
          <h2>Управление треками</h2>
          <form className="admin-search" onSubmit={handleSearchTracks}>
            <input
              type="text"
              placeholder="Поиск треков..."
              value={searchTracks}
              onChange={e => setSearchTracks(e.target.value)}
            />
            <button type="submit" className="admin-btn">Найти</button>
          </form>

          <div className="admin-list">
            {tracks.map(t => (
              <div key={t.id} className="admin-list-item">
                <div className="admin-item-info">
                  <span className="admin-item-name">{t.title}</span>
                  <span className="admin-item-sub">{t.artist}</span>
                </div>
                <button
                  onClick={() => handleDeleteTrack(t.id)}
                  className="admin-action-btn delete"
                >
                  <Trash2 size={16} />
                  Удалить
                </button>
              </div>
            ))}
            {tracks.length === 0 && <div className="admin-empty">Треки не найдены</div>}
          </div>
        </div>
      </div>
    </div>
  )
}

export default Admin
