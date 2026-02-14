import { useState, useEffect, useRef } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Home, Search, Library, Heart, LogOut, Upload, Settings, ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import './Sidebar.css'

function Sidebar() {
  const location = useLocation()
  const { logout, user } = useAuthStore()
  const dropdownRef = useRef(null)
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false)
  const [isCollapsed, setIsCollapsed] = useState(() => {
    const saved = localStorage.getItem('sidebar-collapsed')
    return saved ? JSON.parse(saved) : false
  })

  useEffect(() => {
    localStorage.setItem('sidebar-collapsed', JSON.stringify(isCollapsed))
    // Dispatch custom event to notify Layout
    window.dispatchEvent(new Event('sidebarToggle'))
  }, [isCollapsed])

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setIsProfileMenuOpen(false)
      }
    }
    if (isProfileMenuOpen) {
      document.addEventListener('click', handleClickOutside)
    }
    return () => document.removeEventListener('click', handleClickOutside)
  }, [isProfileMenuOpen])

  const handleLogout = () => {
    setIsProfileMenuOpen(false)
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
  ]

  return (
    <div className={`sidebar ${isCollapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-header">
        <div className="logo">
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

      <div
        className={`sidebar-footer ${isProfileMenuOpen ? 'menu-open' : ''}`}
        ref={dropdownRef}
      >
        <button
          type="button"
          className="profile-trigger"
          onClick={() => setIsProfileMenuOpen((prev) => !prev)}
          aria-expanded={isProfileMenuOpen}
          aria-haspopup="true"
          aria-label="Меню профиля"
        >
          {!isCollapsed && (
            <div className="user-info">
              {user?.avatar_url ? (
                <img src={user.avatar_url} alt={user.username} className="user-avatar" />
              ) : (
                <div className="user-avatar user-avatar-placeholder">
                  {(user?.username || 'U').charAt(0).toUpperCase()}
                </div>
              )}
              <div className="user-details">
                <div className="user-name">{user?.full_name || user?.username}</div>
                <div className="user-email">{user?.email}</div>
              </div>
              <ChevronDown size={16} className={`profile-chevron ${isProfileMenuOpen ? 'open' : ''}`} />
            </div>
          )}
          {isCollapsed && (
            user?.avatar_url ? (
              <img src={user.avatar_url} alt={user.username} className="user-avatar-collapsed" />
            ) : (
              <div className="user-avatar-collapsed user-avatar-placeholder">
                {(user?.username || 'U').charAt(0).toUpperCase()}
              </div>
            )
          )}
        </button>
        {isProfileMenuOpen && (
          <div className={`profile-dropdown ${isCollapsed ? 'collapsed' : ''}`}>
            <Link
              to="/settings"
              className={`profile-dropdown-item ${location.pathname === '/settings' ? 'active' : ''}`}
              onClick={() => setIsProfileMenuOpen(false)}
            >
              <Settings size={20} />
              <span>Настройки</span>
            </Link>
            <button type="button" className="profile-dropdown-item" onClick={handleLogout}>
              <LogOut size={20} />
              <span>Выйти</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default Sidebar
