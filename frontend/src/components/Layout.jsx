import { lazy, Suspense, useState, useEffect } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Home, Search, Library, Heart, Upload, ArrowLeft } from 'lucide-react'
import { usePlayerStore } from '../store/playerStore'
import Sidebar from './Sidebar'
import Player from './Player'
import ToastContainer from './Toast'
import './Layout.css'

// Полноэкранный плеер вместе с панелью текстов — отдельный чанк. Он и так
// рисуется только по isFullScreen, но статический импорт тянул его (плюс
// LyricsPanel и их CSS) в главный бандл, который блокирует первую отрисовку.
// Открывают его жестом уже после загрузки — к этому моменту чанк успевает
// приехать.
const importFullScreenPlayer = () => import('./FullScreenPlayer')
const FullScreenPlayer = lazy(importFullScreenPlayer)

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

  // Прогреваем чанк полноэкранного плеера в простое, после первой отрисовки.
  // Открывается он жестом, и ждать загрузки в этот момент — заметная задержка;
  // requestIdleCallback же не отбирает полосу у критических ресурсов.
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 2000))
    const cancel = window.cancelIdleCallback ?? clearTimeout
    const handle = idle(() => {
      importFullScreenPlayer().catch(() => {})
    })
    return () => cancel(handle)
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
      {/* fallback пустой: полноэкранный плеер открывается поверх уже
          отрисованного мини-плеера, спиннер здесь мигал бы зря. */}
      {isFullScreen && (
        <Suspense fallback={null}>
          <FullScreenPlayer />
        </Suspense>
      )}
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
                  <Icon size={22} fill={isActive ? 'currentColor' : 'none'} />
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
