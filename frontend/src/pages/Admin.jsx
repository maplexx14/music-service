import { useEffect, useMemo, useRef, useState } from 'react'
import api from '../services/api'
import { toast } from '../store/toastStore'
import Spinner from '../components/Spinner'
import { useScreen } from '../hooks/useScreen'
import defaultCover from '../assets/default-cover.svg'
import { resolveCoverUrl, handleCoverError } from '../utils/media'
import './Admin.css'

const USERS_PAGE_SIZE = 50
const NOW_PLAYING_POLL_MS = 15000

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

// Позиция приходит со снимком из пульса (раз в 30 с) — у играющего трека
// досчитываем прошедшее с updated_at, чтобы время не стояло между опросами.
function livePosition(state) {
  if (!state.is_playing) return state.position
  const elapsed = (Date.now() - new Date(state.updated_at).getTime()) / 1000
  const position = state.position + Math.max(0, elapsed)
  return state.duration ? Math.min(position, state.duration) : position
}

function NowPlaying({ state }) {
  return (
    <div className="admin-now-playing">
      <img
        src={resolveCoverUrl(state.cover_url, 'thumb') || defaultCover}
        alt=""
        className="admin-now-playing-cover"
        loading="lazy"
        decoding="async"
        onError={handleCoverError}
      />
      <div className="admin-now-playing-info">
        <div className="admin-now-playing-title">
          {state.title}{state.artist ? ` — ${state.artist}` : ''}
        </div>
        <div className="admin-now-playing-meta">
          {state.is_playing ? 'Слушает сейчас' : 'На паузе'}
          {' · '}
          {formatClock(livePosition(state))}{state.duration ? ` / ${formatClock(state.duration)}` : ''}
          {state.source ? ` · ${state.source}` : ''}
        </div>
      </div>
    </div>
  )
}

const CENSOR_STATUS_LABEL = { suggested: 'Подсказка', confirmed: 'Играет оригинал', rejected: 'Отклонено' }

// Зацензуренные по закону РФ треки и их оригиналы на SoundCloud (см. backend
// app/censorship.py). Сервис сам проверяет русские треки при прослушивании:
// надёжный оригинал привязывает сразу («автоматически» — такую привязку стоит
// глянуть и при ошибке снять), сомнительный оставляет подсказкой. Привязать
// трек вручную — «Оригинал без цензуры» в меню трека или в плеере.
function CensorOverrides() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)

  const load = async () => {
    try {
      const response = await api.get('/censorship/overrides', { skipErrorToast: true, dedupe: false })
      setItems(response.data || [])
    } catch (error) {
      console.error('Error loading censor overrides:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const act = async (item, action) => {
    setBusyId(item.id)
    try {
      const response = await api.post(`/censorship/overrides/${item.id}/${action}`)
      setItems((prev) => prev.map((row) => (row.id === item.id ? response.data : row)))
    } catch (error) {
      console.error('Error updating censor override:', error)
    } finally {
      setBusyId(null)
    }
  }

  // Сначала то, что ждёт решения, потом действующие; отклонённые — в конце.
  const order = { suggested: 0, confirmed: 1, rejected: 2 }
  const sorted = [...items].sort((a, b) => order[a.status] - order[b.status])

  return (
    <div className="admin-section">
      <div className="admin-section-title">Цензура</div>
      <div className="admin-section-subtitle">
        Треки, зацензуренные по закону РФ, и их оригиналы на SoundCloud
      </div>
      {loading ? (
        <Spinner />
      ) : sorted.length === 0 ? (
        <div className="admin-empty">Пока пусто. Привязать трек — «Оригинал без цензуры» в меню трека</div>
      ) : (
        <div className="admin-censor-list">
          {sorted.map((item) => (
            <div key={item.id} className={`admin-censor is-${item.status}`}>
              <div className="admin-censor-info">
                <div className="admin-censor-pair">
                  <span className="admin-censor-censored">{item.censored_artist} — {item.censored_title}</span>
                  <span aria-hidden="true">→</span>
                  <a href={item.original_permalink} target="_blank" rel="noreferrer">
                    {item.original_title}
                  </a>
                </div>
                <div className="admin-censor-meta">
                  {CENSOR_STATUS_LABEL[item.status]}
                  {item.status === 'confirmed' && item.auto ? ' (автоматически)' : ''}
                  {' · '}{item.original_artist}
                  {' · '}{formatClock(item.original_duration)}
                </div>
                {item.evidence?.segments?.length > 0 && (
                  <div className="admin-censor-meta">
                    По звуку: {item.evidence.segments.map(([start, length, db]) => (
                      `${formatClock(start)} — ${length} с, ${db > 0 ? '+' : ''}${db} дБ`
                    )).join('; ')}
                  </div>
                )}
              </div>
              <div className="admin-censor-actions">
                {item.status !== 'confirmed' && (
                  <button type="button" className="admin-refresh" disabled={busyId === item.id} onClick={() => act(item, 'confirm')}>
                    Подтвердить
                  </button>
                )}
                {item.status !== 'rejected' && (
                  <button type="button" className="admin-refresh" disabled={busyId === item.id} onClick={() => act(item, 'reject')}>
                    {item.status === 'confirmed' ? 'Снять' : 'Отклонить'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

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
  const { active: screenActive } = useScreen()
  const screenActiveRef = useRef(screenActive)
  screenActiveRef.current = screenActive
  const [stats, setStats] = useState({ users_count: 0, online_users_count: 0, tracks_count: 0, artists_count: 0 })
  const [users, setUsers] = useState([])
  const [usersTotal, setUsersTotal] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [tracks, setTracks] = useState([])
  const [loading, setLoading] = useState(true)
  const [tracksLoading, setTracksLoading] = useState(true)
  const [deletingId, setDeletingId] = useState(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [nowPlaying, setNowPlaying] = useState({})

  // Профиль вкуса («Определены системой») — самая дорогая часть панели: на
  // бэке это полдесятка запросов на каждого юзера. Поэтому карточки приходят
  // без него (taste=false) и рисуются сразу, а detected_* догружаются следом
  // одним пакетом и вливаются в уже показанные карточки.
  const loadTaste = async (page) => {
    const ids = page.map((user) => user.id)
    if (ids.length === 0) return
    try {
      const response = await api.get('/users/admin/users/taste', {
        params: { ids: ids.join(',') },
        skipErrorToast: true,
      })
      const profiles = response.data.profiles || {}
      setUsers((prev) => prev.map((user) => (
        profiles[user.id] ? { ...user, ...profiles[user.id] } : user
      )))
    } catch (error) {
      console.error('Error loading taste profiles:', error)
    }
  }

  // Треки грузятся независимо от сводки: 200 карточек не должны держать
  // спиннер над статистикой и профилями.
  const fetchTracks = async () => {
    setTracksLoading(true)
    try {
      const response = await api.get('/tracks?limit=200')
      setTracks(response.data || [])
    } catch (error) {
      console.error('Error fetching admin tracks:', error)
    } finally {
      setTracksLoading(false)
    }
  }

  const fetchAdminData = async () => {
    fetchTracks()
    try {
      const response = await api.get('/users/admin/dashboard', { params: { taste: false } })
      const page = response.data.users || []
      setStats(response.data)
      setUsers(page)
      setUsersTotal(response.data.users_total ?? page.length)
      setLoading(false)
      loadTaste(page)
    } catch (error) {
      console.error('Error fetching admin data:', error)
      setLoading(false)
    }
  }

  const loadMoreUsers = async () => {
    setLoadingMore(true)
    try {
      const response = await api.get(`/users/admin/users?limit=${USERS_PAGE_SIZE}&offset=${users.length}&taste=false`)
      const page = response.data.users || []
      setUsers((prev) => {
        const seen = new Set(prev.map((user) => user.id))
        return [...prev, ...page.filter((user) => !seen.has(user.id))]
      })
      setUsersTotal(response.data.total ?? users.length)
      loadTaste(page)
    } catch (error) {
      console.error('Error loading more users:', error)
    } finally {
      setLoadingMore(false)
    }
  }

  const fetchNowPlaying = async () => {
    try {
      const response = await api.get('/users/admin/now-playing', { skipErrorToast: true, dedupe: false })
      setNowPlaying(response.data.now_playing || {})
    } catch (error) {
      console.error('Error fetching now playing:', error)
    }
  }

  useEffect(() => {
    fetchAdminData()
  }, [])

  // Отдельный частый опрос: эндпоинт читает только Redis, а перезапрашивать
  // ради него весь дашборд с профилями было бы в разы дороже.
  useEffect(() => {
    fetchNowPlaying()
    const interval = window.setInterval(() => {
      // Экран скрыт под другим вложенным (ScreenStack) — не опрашиваем.
      if (document.visibilityState === 'visible' && screenActiveRef.current) fetchNowPlaying()
    }, NOW_PLAYING_POLL_MS)
    return () => window.clearInterval(interval)
  }, [])

  const listeningCount = useMemo(
    () => Object.values(nowPlaying).filter((state) => state.is_playing).length,
    [nowPlaying],
  )

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
      <Spinner page />
    )
  }

  return (
    <div className="page-container admin-page">
      <div className="admin-header">
        <div>
          <h1 className="admin-title">Админ панель</h1>
          <div className="admin-subtitle">Сводка по сервису</div>
        </div>
        <button type="button" className="admin-refresh" onClick={() => { fetchAdminData(); fetchNowPlaying() }}>
          Обновить
        </button>
      </div>

      <div className="admin-stats">
        {[
          ['Пользователи', stats.users_count],
          ['Сейчас онлайн', stats.online_users_count],
          ['Сейчас слушают', listeningCount],
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
            {nowPlaying[user.id] && <NowPlaying state={nowPlaying[user.id]} />}
            <div className="admin-user-preferences"><span>Жанры: {(user.preferred_genres || []).join(', ') || 'не указаны'}</span><span>Артисты: {(user.preferred_artists || []).join(', ') || 'не указаны'}</span><span className="admin-user-detected">Определены системой: {user.detected_artists === undefined ? 'загрузка…' : user.detected_artists.join(', ') || 'нет данных'}</span></div>
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

      <CensorOverrides />

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
        {tracksLoading ? (
          <Spinner />
        ) : filteredTracks.length === 0 ? (
          <div className="admin-empty">Треки не найдены</div>
        ) : (
          <div className="admin-tracks">
            {filteredTracks.map((track) => (
              <div key={track.id} className="admin-track">
                <img
                  src={resolveCoverUrl(track.cover_url, 'thumb') || defaultCover}
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
