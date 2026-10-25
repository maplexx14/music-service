import { useState, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Home, Search, Library, Heart, ChevronLeft, ChevronRight, Shield, Settings2, MessageCircle } from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import { prefetchRouteChunk } from './Layout'
import TasteAvatar from './TasteAvatar'
import api from '../services/api'
import {
  peekCache,
  writeCache,
  subscribeCache,
  intentPrefetchHandlers,
  prefetchPlaylist,
  LIBRARY_CACHE_KEY,
} from '../services/pageCache'
import { useImportStore } from '../store/importStore'
import defaultCover from '../assets/default-cover.webp'
import { resolveCoverUrl, handleCoverError } from '../utils/media'
import { plural } from '../utils/format'
import './Sidebar.css'

function Sidebar() {
  const location = useLocation()
  const user = useAuthStore((s) => s.user)
  const [isCollapsed, setIsCollapsed] = useState(() => {
    const saved = localStorage.getItem('sidebar-collapsed')
    return saved ? JSON.parse(saved) : false
  })

  useEffect(() => {
    localStorage.setItem('sidebar-collapsed', JSON.stringify(isCollapsed))
    // Dispatch custom event to notify Layout
    window.dispatchEvent(new Event('sidebarToggle'))
  }, [isCollapsed])

  // Плейлисты медиатеки — тот же список и кэш, что у вкладки «Медиатека»:
  // создание и удаление там сразу видны здесь. null — ещё не загрузили:
  // подсказку «пусто» не показываем, пока ответ не пришёл.
  const [playlists, setPlaylists] = useState(() => peekCache(LIBRARY_CACHE_KEY) ?? null)
  const importsCompleted = useImportStore((s) => s.completed)
  useEffect(() => subscribeCache(LIBRARY_CACHE_KEY, setPlaylists), [])
  useEffect(() => {
    api
      .get('/playlists/me', { skipErrorToast: true })
      .then((response) => writeCache(LIBRARY_CACHE_KEY, response.data))
      .catch(() => {})
  }, [importsCompleted])

  const toggleCollapse = () => {
    setIsCollapsed(!isCollapsed)
  }

  const navItems = [
    { path: '/', icon: Home, label: 'Главная' },
    { path: '/search', icon: Search, label: 'Поиск' },
    { path: '/playlists', icon: Library, label: 'Медиатека' },
    { path: '/liked', icon: Heart, label: 'Понравившиеся' },
    ...(user?.is_admin ? [{ path: '/admin', icon: Shield, label: 'Админ' }] : []),
  ]

  return (
    <div className={`sidebar ${isCollapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-header">
        <Link to="/" className="logo" aria-label="На главную">
          {!isCollapsed && <img src="/logoBolt1.webp" alt="" className="logo-img" />}
        </Link>
        <button className="collapse-btn" onClick={toggleCollapse} title={isCollapsed ? 'Развернуть' : 'Свернуть'}>
          {isCollapsed ? <ChevronRight size={20} /> : <ChevronLeft size={20} />}
        </button>
      </div>
      
      <nav className="sidebar-nav">
        {navItems.map((item) => {
          const Icon = item.icon
          const isActive = location.pathname === item.path
          return (
            <Link
              key={item.path}
              to={item.path}
              className={`nav-item ${isActive ? 'active' : ''}`}
              title={isCollapsed ? item.label : ''}
              onPointerEnter={() => prefetchRouteChunk(item.path)}
              onPointerDown={() => prefetchRouteChunk(item.path)}
            >
              <Icon size={24} fill={isActive ? 'currentColor' : 'none'} />
              {!isCollapsed && <span>{item.label}</span>}
            </Link>
          )
        })}
      </nav>

      <div className="sidebar-playlists">
        {!isCollapsed && (
          <Link to="/playlists" className="sidebar-section-title">
            Плейлисты
          </Link>
        )}
        {!isCollapsed && playlists?.length === 0 && (
          <Link to="/playlists" className="sidebar-playlists-empty">
            Создайте свой первый плейлист
          </Link>
        )}
        <div className="sidebar-playlists-list">
          {(playlists ?? []).map((playlist) => {
            const count = playlist.track_count ?? 0
            const path = `/playlists/${playlist.id}`
            return (
              <Link
                key={playlist.id}
                to={path}
                className={`sidebar-playlist${location.pathname === path ? ' active' : ''}`}
                title={isCollapsed ? playlist.name : undefined}
                {...intentPrefetchHandlers(() => prefetchPlaylist(playlist.id))}
              >
                <img
                  src={resolveCoverUrl(playlist.cover_url) || defaultCover}
                  alt=""
                  className="sidebar-playlist-cover"
                  loading="lazy"
                  decoding="async"
                  onError={handleCoverError}
                />
                {!isCollapsed && (
                  <div className="sidebar-playlist-text">
                    <div className="sidebar-playlist-name">{playlist.name}</div>
                    <div className="sidebar-playlist-meta">
                      {count} {plural(count, 'трек', 'трека', 'треков')}
                    </div>
                  </div>
                )}
              </Link>
            )
          })}
        </div>
      </div>

      {/* Связь с разработчиком — раздел настроек; здесь ссылка на виду, чтобы
          не искать её в меню. */}
      <Link
        to="/settings/feedback"
        className={`nav-item nav-item-contact${location.pathname === '/settings/feedback' ? ' active' : ''}`}
        title={isCollapsed ? 'Связь с разработчиком' : ''}
        onPointerEnter={() => prefetchRouteChunk('/settings')}
        onPointerDown={() => prefetchRouteChunk('/settings')}
      >
        <MessageCircle size={24} />
        {!isCollapsed && <span>Связь с разработчиком</span>}
      </Link>

      {/* Профиль ведёт сразу в настройки: там же выход и админка. Раньше по
          нажатию открывалось меню из двух пунктов — лишний шаг до того же. */}
      <div className="sidebar-footer">
        <Link
          to="/settings"
          className={`profile-trigger${location.pathname.startsWith('/settings') && location.pathname !== '/settings/feedback' ? ' active' : ''}`}
          title={isCollapsed ? 'Профиль и настройки' : undefined}
          aria-label="Профиль и настройки"
          onPointerEnter={() => prefetchRouteChunk('/settings')}
          onPointerDown={() => prefetchRouteChunk('/settings')}
        >
          {!isCollapsed && (
            <div className="user-info">
              <TasteAvatar user={user} className="user-avatar" />
              <div className="user-details">
                <div className="user-name">{user?.full_name || user?.username}</div>
              </div>
              <Settings2 size={16} className="profile-chevron" aria-hidden="true" />
            </div>
          )}
          {isCollapsed && (
            <TasteAvatar user={user} className="user-avatar-collapsed" />
          )}
        </Link>
      </div>
    </div>
  )
}

export default Sidebar
