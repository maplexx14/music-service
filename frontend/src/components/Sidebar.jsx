import { useState, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Home, Search, Heart, LogOut, Upload, Settings, ChevronLeft, ChevronRight, ShieldCheck, User } from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import './Sidebar.css'

function Sidebar() {
  const location = useLocation()
  const { logout, user } = useAuthStore()
  const [isCollapsed, setIsCollapsed] = useState(() => {
    const saved = localStorage.getItem('sidebar-collapsed')
    return saved ? JSON.parse(saved) : false
  })
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false)

  useEffect(() => {
    localStorage.setItem('sidebar-collapsed', JSON.stringify(isCollapsed))
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
    { path: '/liked', icon: Heart, label: 'Моя музыка' },
    { path: '/upload', icon: Upload, label: 'Загрузить трек' },
  ]

  if (user?.is_admin) {
    navItems.push({ path: '/admin', icon: ShieldCheck, label: 'Админ Панель' })
  }

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
              <Icon
                size={24}
                strokeWidth={isActive ? 2.5 : 2}
              />
              {!isCollapsed && <span>{item.label}</span>}
            </Link>
          )
        })}
      </nav>

      <div className="sidebar-footer">
        <div className="profile-container">
          <button
            className={`profile-toggle ${isUserMenuOpen ? 'active' : ''}`}
            onClick={() => setIsUserMenuOpen(!isUserMenuOpen)}
          >
            {user?.avatar_url ? (
              <img
                src={user.avatar_url}
                alt={user.username}
                className={isCollapsed ? "user-avatar-collapsed" : "user-avatar"}
              />
            ) : (
              <div className={isCollapsed ? "user-avatar-collapsed placeholder" : "user-avatar placeholder"}>
                <User size={isCollapsed ? 20 : 24} />
              </div>
            )}

            {!isCollapsed && (
              <div className="user-details">
                <div className="user-name">{user?.full_name || user?.username}</div>
              </div>
            )}
          </button>

          {isUserMenuOpen && (
            <div className="profile-dropdown">
              <Link to="/settings" className="dropdown-item" onClick={() => setIsUserMenuOpen(false)}>
                <Settings size={18} />
                <span>Настройки</span>
              </Link>
              <button className="dropdown-item logout" onClick={handleLogout}>
                <LogOut size={18} />
                <span>Выйти</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default Sidebar
