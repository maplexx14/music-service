import { useState, useEffect } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Home, Search, Library, Heart, Upload, ArrowLeft } from 'lucide-react'
import { usePlayerStore } from '../store/playerStore'
import Sidebar from './Sidebar'
import Player from './Player'
import FullScreenPlayer from './FullScreenPlayer'
import ToastContainer from './Toast'
import './Layout.css'

function Layout({ children }) {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem('sidebar-collapsed')
    return saved && JSON.parse(saved) ? 72 : 240
  })
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.innerWidth <= 768
  })
  const isFullScreen = usePlayerStore((state) => state.isFullScreen)
  const location = useLocation()
  const navigate = useNavigate()

  useEffect(() => {
    const handleStorageChange = () => {
      const saved = localStorage.getItem('sidebar-collapsed')
      setSidebarWidth(saved && JSON.parse(saved) ? 72 : 240)
    }
    
    window.addEventListener('storage', handleStorageChange)
    // Also listen for custom event from Sidebar
    const handleSidebarToggle = () => {
      const saved = localStorage.getItem('sidebar-collapsed')
      setSidebarWidth(saved && JSON.parse(saved) ? 72 : 240)
    }
    window.addEventListener('sidebarToggle', handleSidebarToggle)
    
    return () => {
      window.removeEventListener('storage', handleStorageChange)
      window.removeEventListener('sidebarToggle', handleSidebarToggle)
    }
  }, [])

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth <= 768)
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const showMobileBack = isMobile && location.pathname !== '/'

  return (
    <div className="layout" style={{ '--sidebar-width': isMobile ? '0px' : `${sidebarWidth}px` }}>
      <Sidebar />
      {showMobileBack && (
        <div className="mobile-topbar">
          <button
            type="button"
            className="mobile-back-btn"
            onClick={() => navigate(-1)}
            aria-label="Назад"
          >
            <ArrowLeft size={20} />
          </button>
          <div className="mobile-topbar-title" aria-hidden="true">
        
          </div>
          <div className="mobile-topbar-spacer" />
        </div>
      )}
      <main
        className={`main-content ${showMobileBack ? 'has-mobile-topbar' : ''}`}
        style={{ marginLeft: isMobile ? 0 : `${sidebarWidth}px` }}
      >
        {children}
      </main>
      <Player />
      <ToastContainer />
      {isFullScreen && <FullScreenPlayer />}
      {isMobile && (
        <nav className="mobile-nav-global" aria-label="Нижняя навигация">
          {[
            { to: '/', icon: Home, label: 'Главная' },
            { to: '/search', icon: Search, label: 'Поиск' },
            { to: '/upload', icon: Upload, label: 'Загрузка' },
            { to: '/liked', icon: Heart, label: 'Любимое' },
            { to: '/playlists', icon: Library, label: 'Моя музыка' },
          ].map(({ to, icon: Icon, label }) => {
            const isActive =
              to === '/'
                ? location.pathname === '/'
                : location.pathname.startsWith(to)
            return (
              <Link
                key={to}
                to={to}
                className={`mobile-nav-global-item ${isActive ? 'active' : ''}`}
                aria-current={isActive ? 'page' : undefined}
                aria-label={label}
              >
                <span className="mobile-nav-global-icon">
                  <Icon size={22} />
                </span>
              </Link>
            )
          })}
        </nav>
      )}
    </div>
  )
}

export default Layout
