import { useEffect, useMemo, useState } from 'react'
import api from '../services/api'
import { toast } from '../store/toastStore'
import Spinner from '../components/Spinner'
import defaultCover from '../assets/default-cover.svg'
import { resolveCoverUrl, handleCoverError } from '../utils/media'
import './Admin.css'

const USERS_PAGE_SIZE = 50

function formatLastSeen(value) {
  if (!value) return 'нет данных'
  const diff = Date.now() - new Date(value).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'только что'
  if (minutes < 60) return `${minutes} мин назад`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} ч назад`
  return new Date(value).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function Admin() {
  const [stats, setStats] = useState({ users_count: 0, online_users_count: 0, tracks_count: 0, artists_count: 0 })
  const [users, setUsers] = useState([])
  const [usersTotal, setUsersTotal] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
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
      setUsersTotal(dashboardResponse.data.users_total ?? (dashboardResponse.data.users || []).length)
      setTracks(tracksResponse.data || [])
    } catch (error) {
      console.error('Error fetching admin data:', error)
    } finally {
      setLoading(false)
    }
  }

  const loadMoreUsers = async () => {
    setLoadingMore(true)
    try {
      const response = await api.get(`/users/admin/users?limit=${USERS_PAGE_SIZE}&offset=${users.length}`)
      const page = response.data.users || []
      setUsers((prev) => {
        const seen = new Set(prev.map((user) => user.id))
        return [...prev, ...page.filter((user) => !seen.has(user.id))]
      })
      setUsersTotal(response.data.total ?? users.length)
    } catch (error) {
      console.error('Error loading more users:', error)
    } finally {
      setLoadingMore(false)
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
        <div className="admin-section-head">
          <div>
            <div className="admin-section-title">Профили пользователей</div>
            <div className="admin-section-subtitle">
              Отсортированы по последнему входу — кто в сети, те выше
            </div>
          </div>
        </div>
        <div className="admin-users">
          {users.map((user) => <div className="admin-user" key={user.id}>
            <div className="admin-user-main">
              <div className="admin-user-name">
                <strong>{user.username}</strong>
                {user.is_online && <span className="admin-user-online"><span className="admin-user-online-dot" />онлайн</span>}
                <span className="admin-user-email">{user.email}</span>
              </div>
              <span className="admin-user-seen">
                {user.is_online ? 'сейчас в сети' : `был(а) в сети: ${formatLastSeen(user.last_seen)}`}
              </span>
            </div>
            <div className="admin-user-preferences"><span>Жанры: {(user.preferred_genres || []).join(', ') || 'не указаны'}</span><span>Артисты: {(user.preferred_artists || []).join(', ') || 'не указаны'}</span><span className="admin-user-detected">Определены системой: {(user.detected_artists || []).join(', ') || 'нет данных'}</span></div>
          </div>)}
        </div>
        {users.length < usersTotal && (
          <button
            type="button"
            className="admin-load-more"
            onClick={loadMoreUsers}
            disabled={loadingMore}
          >
            {loadingMore ? 'Загрузка...' : `Показать ещё (${usersTotal - users.length})`}
          </button>
        )}
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
