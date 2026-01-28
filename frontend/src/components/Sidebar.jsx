import { Link, useLocation } from 'react-router-dom'
import { Home, Search, Library, Heart, LogOut, Upload } from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import './Sidebar.css'

function Sidebar() {
  const location = useLocation()
  const { logout, user } = useAuthStore()

  const handleLogout = () => {
    logout()
    window.location.href = '/login'
  }

  const navItems = [
    { path: '/', icon: Home, label: 'Главная' },
    { path: '/search', icon: Search, label: 'Поиск' },
    { path: '/playlists', icon: Library, label: 'Моя музыка' },
    { path: '/liked', icon: Heart, label: 'Понравившиеся' },
    { path: '/upload', icon: Upload, label: 'Загрузить трек' },
  ]

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="logo">
          <span className="logo-icon">♪</span>
          <span className="logo-text">Music</span>
        </div>
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
            >
              <Icon size={24} />
              <span>{item.label}</span>
            </Link>
          )
        })}
      </nav>

      <div className="sidebar-footer">
        <div className="user-info">
          {user?.avatar_url && (
            <img src={user.avatar_url} alt={user.username} className="user-avatar" />
          )}
          <div className="user-details">
            <div className="user-name">{user?.full_name || user?.username}</div>
            <div className="user-email">{user?.email}</div>
          </div>
        </div>
        <button onClick={handleLogout} className="logout-btn">
          <LogOut size={20} />
        </button>
      </div>
    </div>
  )
}

export default Sidebar
