import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import api from '../services/api'
import { toast } from '../store/toastStore'
import Spinner from '../components/Spinner'
import { useScreen } from '../hooks/useScreen'
import defaultCover from '../assets/default-cover.svg'
import { resolveCoverUrl, handleCoverError } from '../utils/media'
import './Admin.css'

const USERS_PAGE_SIZE = 50
const NOW_PLAYING_POLL_MS = 15000
const OPEN_PANELS_KEY = 'admin-open-panels'
const DEFAULT_OPEN_PANELS = ['users']

function readOpenPanels() {
  try {
    const stored = JSON.parse(localStorage.getItem(OPEN_PANELS_KEY))
    return Array.isArray(stored) ? stored : DEFAULT_OPEN_PANELS
  } catch {
    return DEFAULT_OPEN_PANELS
  }
}

// Раскрывающийся раздел панели. Тело монтируется при первом раскрытии и
// дальше только прячется: тяжёлые разделы (200 треков) не грузятся, пока их
// не открыли, а раз открытые не теряют поиск и прокрутку при сворачивании.
function AdminPanel({ title, subtitle, badge, accent, open, onToggle, actions, children }) {
  const bodyId = useId()
  const [mounted, setMounted] = useState(open)
  useEffect(() => {
    if (open) setMounted(true)
  }, [open])

  return (
    <section className={`admin-panel${open ? ' is-open' : ''}`}>
      <div className="admin-panel-head">
        <button
          type="button"
          className="admin-panel-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <ChevronDown size={18} className="admin-panel-chevron" aria-hidden="true" />
          <span className="admin-panel-titles">
            <span className="admin-panel-title">
              {title}
              {badge ? <span className={`admin-panel-badge${accent ? ' is-accent' : ''}`}>{badge}</span> : null}
            </span>
            {subtitle && <span className="admin-panel-subtitle">{subtitle}</span>}
          </span>
        </button>
        {open && actions}
      </div>
      <div id={bodyId} className="admin-panel-body" hidden={!open}>
        {mounted && children}
      </div>
    </section>
  )
}

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

// Позиция приходит со снимком только на событиях (смена трека, пауза,
// перемотка — пульса нет, см. hooks/useNowPlayingReporter) — у играющего трека
// досчитываем прошедшее с updated_at, иначе время стояло бы весь трек.
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
function CensorOverrides({ onCount }) {
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
  const pending = items.filter((item) => item.status === 'suggested').length

  useEffect(() => {
    onCount?.(pending)
  }, [pending])

  return (
    <>
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
    </>
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

// Сообщения из «Связь с разработчиком» (настройки). Новые подсвечены, пока
// админ не отметит прочитанным.
function DeveloperMessages({ onCount }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)

  useEffect(() => {
    api.get('/feedback', { skipErrorToast: true, dedupe: false })
      .then((response) => setItems(response.data || []))
      .catch((error) => console.error('Error loading developer messages:', error))
      .finally(() => setLoading(false))
  }, [])

  const markRead = async (item) => {
    setBusyId(item.id)
    try {
      const response = await api.post(`/feedback/${item.id}/read`)
      setItems((prev) => prev.map((row) => (row.id === item.id ? response.data : row)))
    } catch (error) {
      console.error('Error marking developer message read:', error)
    } finally {
      setBusyId(null)
    }
  }

  const unread = items.filter((item) => !item.is_read).length

  useEffect(() => {
    onCount?.(unread)
  }, [unread])

  return (
    <>
      {loading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <div className="admin-empty">Сообщений пока нет</div>
      ) : (
        <div className="admin-censor-list">
          {items.map((item) => (
            <div key={item.id} className={`admin-censor admin-message${item.is_read ? ' is-read' : ' is-unread'}`}>
              <div className="admin-censor-info">
                <div className="admin-message-text">{item.message}</div>
                <div className="admin-censor-meta">
                  {item.user ? `${item.user.username}${item.user.email ? ` · ${item.user.email}` : ''}` : 'удалённый пользователь'}
                  {' · '}{formatLastSeen(item.created_at)}
                  {item.context?.build ? ` · сборка ${item.context.build}` : ''}
                </div>
                {item.context?.userAgent && (
                  <div className="admin-censor-meta">{item.context.userAgent}</div>
                )}
              </div>
              {!item.is_read && (
                <div className="admin-censor-actions">
                  <button type="button" className="admin-refresh" disabled={busyId === item.id} onClick={() => markRead(item)}>
                    Прочитано
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function UserCard({ user, nowPlaying }) {
  const [expanded, setExpanded] = useState(false)
  // Засчитанный трек (user_track_plays) и последний включённый (now-playing).
  // Включённый показываем, если он свежее: вернувшийся юзер мог уйти до
  // порога засчитывания, и карточка застряла бы на старом треке.
  const heardAt = Date.parse(user.last_heard?.played_at ?? '')
  // Тот же трек не подменяем: пауза после засчитывания тоже пишет now-playing.
  const heardIsNewer =
    Boolean(user.last_heard) &&
    (!user.last_track ||
      (user.last_heard.title !== user.last_track.title &&
        heardAt > Date.parse(user.last_track.played_at ?? '')))
  const lastTrack = heardIsNewer ? null : user.last_track
  const lastHeard = heardIsNewer ? user.last_heard : null

  return (
    <div className={`admin-user${expanded ? ' is-expanded' : ''}`}>
      <button
        type="button"
        className="admin-user-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="admin-user-name">
          {user.is_online && <span className="admin-user-online-dot" role="img" aria-label="онлайн" />}
          <strong>{user.username}</strong>
        </span>
        <span className="admin-user-seen">
          {user.is_online ? 'в сети' : formatLastSeen(user.last_seen)}
        </span>
        <ChevronDown size={16} className="admin-user-chevron" aria-hidden="true" />
      </button>
      <div className="admin-user-facts">
        <span title={user.last_user_agent || undefined}>
          {user.last_device || 'устройство неизвестно'}
        </span>
        {!nowPlaying && (
          <span className="admin-user-last-track">
            {lastTrack
              ? `${lastTrack.title}${lastTrack.artist ? ` — ${lastTrack.artist}` : ''} · ${formatLastSeen(lastTrack.played_at)}`
              : lastHeard
                ? `включал(а): ${lastHeard.title}${lastHeard.artist ? ` — ${lastHeard.artist}` : ''} · ${formatLastSeen(lastHeard.played_at)}, не дослушал(а)`
                : 'ещё ничего не слушал(а)'}
          </span>
        )}
      </div>
      {nowPlaying && <NowPlaying state={nowPlaying} />}
      {expanded && (
        <div className="admin-user-preferences">
          <span>Почта: {user.email}</span>
          <span>Регистрация: {formatLastSeen(user.created_at)}</span>
          {user.last_user_agent && <span className="admin-user-ua">{user.last_user_agent}</span>}
          <span>Жанры: {(user.preferred_genres || []).join(', ') || 'не указаны'}</span>
          <span>Артисты: {(user.preferred_artists || []).join(', ') || 'не указаны'}</span>
          <span className="admin-user-detected">
            Определены системой: {user.detected_artists === undefined ? 'загрузка…' : user.detected_artists.join(', ') || 'нет данных'}
          </span>
        </div>
      )}
    </div>
  )
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
  const [userFilter, setUserFilter] = useState('')
  const [openPanels, setOpenPanels] = useState(readOpenPanels)
  const [unreadMessages, setUnreadMessages] = useState(0)
  const [pendingCensor, setPendingCensor] = useState(0)

  const togglePanel = (id) => {
    setOpenPanels((prev) => {
      const next = prev.includes(id) ? prev.filter((panel) => panel !== id) : [...prev, id]
      try {
        localStorage.setItem(OPEN_PANELS_KEY, JSON.stringify(next))
      } catch {
        // Без хранилища раскрытые разделы просто не запомнятся.
      }
      return next
    })
  }

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
      const response = await api.get('/tracks/?limit=200')
      setTracks(response.data || [])
    } catch (error) {
      console.error('Error fetching admin tracks:', error)
    } finally {
      setTracksLoading(false)
    }
  }

  const fetchAdminData = async () => {
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

  // Треки грузятся только когда раздел раскрыт впервые.
  const tracksOpen = openPanels.includes('tracks')
  const tracksRequested = useRef(false)
  useEffect(() => {
    if (tracksOpen && !tracksRequested.current) {
      tracksRequested.current = true
      fetchTracks()
    }
  }, [tracksOpen])

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

  const filteredUsers = useMemo(() => {
    const term = userFilter.trim().toLowerCase()
    if (!term) return users
    return users.filter((user) => (
      user.username?.toLowerCase().includes(term) || user.email?.toLowerCase().includes(term)
    ))
  }, [users, userFilter])

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
        <button type="button" className="admin-refresh" onClick={() => {
          fetchAdminData()
          fetchNowPlaying()
          if (tracksRequested.current) fetchTracks()
        }}>
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

      <AdminPanel
        title="Пользователи"
        subtitle="По последнему входу — кто в сети, те выше"
        badge={usersTotal}
        open={openPanels.includes('users')}
        onToggle={() => togglePanel('users')}
      >
        <input
          type="search"
          className="admin-search-input admin-panel-search"
          placeholder="Имя или почта"
          aria-label="Найти пользователя"
          value={userFilter}
          onChange={(e) => setUserFilter(e.target.value)}
        />
        {filteredUsers.length === 0 ? (
          <div className="admin-empty">Среди загруженных никого не нашлось</div>
        ) : (
          <div className="admin-users">
            {filteredUsers.map((user) => (
              <UserCard key={user.id} user={user} nowPlaying={nowPlaying[user.id]} />
            ))}
          </div>
        )}
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
      </AdminPanel>

      <AdminPanel
        title="Сообщения"
        subtitle="Из «Связь с разработчиком» в настройках"
        badge={unreadMessages}
        accent
        open={openPanels.includes('messages')}
        onToggle={() => togglePanel('messages')}
      >
        <DeveloperMessages onCount={setUnreadMessages} />
      </AdminPanel>

      <AdminPanel
        title="Цензура"
        subtitle="Треки, зацензуренные по закону РФ, и их оригиналы на SoundCloud"
        badge={pendingCensor}
        accent
        open={openPanels.includes('censor')}
        onToggle={() => togglePanel('censor')}
      >
        <CensorOverrides onCount={setPendingCensor} />
      </AdminPanel>

      <AdminPanel
        title="Треки"
        subtitle="200 самых прослушиваемых"
        open={tracksOpen}
        onToggle={() => togglePanel('tracks')}
      >
        <input
          type="search"
          className="admin-search-input admin-panel-search"
          placeholder="Поиск по названию или артисту"
          aria-label="Найти трек"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
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
      </AdminPanel>
    </div>
  )
}

export default Admin
