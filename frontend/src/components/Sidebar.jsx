import { useState, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Home, Search, Library, Heart, ChevronLeft, ChevronRight, Shield, Settings2, MessageCircle } from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import { prefetchRouteChunk } from './Layout'
import TasteAvatar from './TasteAvatar'
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

      {/* Связь с разработчиком — раздел настроек; здесь ссылка на виду, чтобы
          не искать её в меню. */}
      <Link
        to="/settings/contact"
        className={`nav-item nav-item-contact${location.pathname === '/settings/contact' ? ' active' : ''}`}
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
          className={`profile-trigger${location.pathname.startsWith('/settings') && location.pathname !== '/settings/contact' ? ' active' : ''}`}
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
