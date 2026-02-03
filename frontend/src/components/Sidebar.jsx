import { useState, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Home, Search, Library, Heart, LogOut, Upload, Settings, ChevronLeft, ChevronRight } from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import './Sidebar.css'

function Sidebar() {
  const location = useLocation()
  const { logout, user } = useAuthStore()
  const [isCollapsed, setIsCollapsed] = useState(() => {
    const saved = localStorage.getItem('sidebar-collapsed')
    return saved ? JSON.parse(saved) : false
  })

  useEffect(() => {
    localStorage.setItem('sidebar-collapsed', JSON.stringify(isCollapsed))
    // Dispatch custom event to notify Layout
    window.dispatchEvent(new Event('sidebarToggle'))
  }, [isCollapsed])

  const handleLogout = () => {
    logout()
    window.location.href = '/login'
  }

  const toggleCollapse = () => {
    setIsCollapsed(!isCollapsed)
  }

  const navItems = [
    { path: '/', icon: Home, label: 'Главная' },
    { path: '/search', icon: Search, label: 'Поиск' },
    { path: '/playlists', icon: Library, label: 'Моя музыка' },
    { path: '/liked', icon: Heart, label: 'Понравившиеся' },
    { path: '/upload', icon: Upload, label: 'Загрузить трек' },
    { path: '/settings', icon: Settings, label: 'Настройки' },
  ]

  return (
    <div className={`sidebar ${isCollapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-header">
        <div className="logo">
          <span className="logo-icon">♪</span>
          {!isCollapsed && <span className="logo-text">BoltMusic</span>}
        </div>
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
            >
              <Icon size={24} />
              {!isCollapsed && <span>{item.label}</span>}
            </Link>
          )
        })}
      </nav>

      <div className="sidebar-footer">
        {!isCollapsed && (
          <div className="user-info">
            {user?.avatar_url && (
              <img src={user.avatar_url} alt={user.username} className="user-avatar" />
            )}
            <div className="user-details">
              <div className="user-name">{user?.full_name || user?.username}</div>
              <div className="user-email">{user?.email}</div>
            </div>
          </div>
        )}
        {isCollapsed && user?.avatar_url && (
          <img src={user.avatar_url} alt={user.username} className="user-avatar-collapsed" />
        )}
        <button onClick={handleLogout} className="logout-btn" title="Выйти">
          <LogOut size={20} />
        </button>
      </div>
    </div>
  )
}

export default Sidebar
