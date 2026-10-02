import { lazy, Suspense, useState, useEffect, useRef } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Home, Search, Library, Heart, ArrowLeft } from 'lucide-react'
import { usePlayerStore } from '../store/playerStore'
import { useScrollRestoration } from '../hooks/useScrollRestoration'
import { useSwipeNavigation } from '../hooks/useSwipeNavigation'
import { isTabRoot, tabOf, canGoBack, isStandalone } from '../services/navigation'
import { haptic, HAPTIC } from '../utils/haptics'
import Sidebar from './Sidebar'
import Player from './Player'
import ToastContainer from './Toast'
import AddToPlaylistDialog from './AddToPlaylistDialog'
import CensorOverrideDialog from './CensorOverrideDialog'
import './Layout.css'

// Полноэкранный плеер вместе с панелью текстов — отдельный чанк. Он и так
// рисуется только по isFullScreen, но статический импорт тянул его (плюс
// LyricsPanel и их CSS) в главный бандл, который блокирует первую отрисовку.
// Открывают его жестом уже после загрузки — к этому моменту чанк успевает
// приехать.
const importFullScreenPlayer = () => import('./FullScreenPlayer')
const FullScreenPlayer = lazy(importFullScreenPlayer)

// Прогрев чанков страниц по intent (hover тачпадом / pointerdown тапа):
// к моменту клика чанк уже в кэше, переход мгновенный — как в нативных
// приложениях. Ссылки на десктопе прогреваются по hover (120мс задержка
// против случайных ведений), на таче pointerdown на ~100мс раньше click.
const ROUTE_CHUNKS = {
  '/': () => import('../pages/Home'),
  '/search': () => import('../pages/Search'),
  '/playlists': () => import('../pages/Playlists'),
  '/liked': () => import('../pages/LikedSongs'),
  '/upload': () => import('../pages/UploadTrack'),
  '/settings': () => import('../pages/Settings'),
  '/admin': () => import('../pages/Admin'),
}

// Вложенные страницы, куда попадают из вкладок, — тоже прогреваются в простое.
const DETAIL_CHUNKS = [
  () => import('../pages/Artist'),
  () => import('../pages/PlaylistDetail'),
  () => import('../pages/Album'),
  () => import('../pages/ExternalPlaylist'),
]

// Вкладки, которые открывают почти всегда, — в порядке вероятности. Грузятся
// по одной в простое после первой отрисовки: hover-прогрев не работает на
// таче, а первый тап по вкладке упирался в загрузку чанка со спиннером.
const IDLE_CHUNKS = [
  ROUTE_CHUNKS['/search'],
  ROUTE_CHUNKS['/playlists'],
  ROUTE_CHUNKS['/liked'],
  ROUTE_CHUNKS['/'],
  ...DETAIL_CHUNKS,
  ROUTE_CHUNKS['/settings'],
]

function prefetchRouteChunk(path) {
  const loader = ROUTE_CHUNKS[path]
  if (loader) loader().catch(() => {})
}

export { prefetchRouteChunk }

// Пункты нижней навигации на мобильном. Загрузка трека здесь была пятым
// пунктом, но под неё хватает кнопки в «Моей музыке» — на десктопе она
// по-прежнему живёт отдельной строкой в сайдбаре.
const MOBILE_NAV = [
  { to: '/', icon: Home, label: 'Главная' },
  { to: '/search', icon: Search, label: 'Поиск' },
  { to: '/liked', icon: Heart, label: 'Любимое' },
  { to: '/playlists', icon: Library, label: 'Моя музыка' },
]

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
  const mainRef = useRef(null)

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
    // Чанки по одному за простой: пачка параллельных загрузок на медленной
    // сети отняла бы полосу у обложек и аудио текущей страницы.
    const queue = [importFullScreenPlayer, ...IDLE_CHUNKS]
    let handle = null
    const next = () => {
      const loader = queue.shift()
      if (!loader) return
      handle = idle(() => {
        loader().catch(() => {}).finally(next)
      })
    }
    next()
    return () => {
      queue.length = 0
      if (handle !== null) cancel(handle)
    }
  }, [])

  // «Назад» — только у вложенных экранов, как в нативном стеке: у корней
  // вкладок его нет. Раньше панель с кнопкой появлялась на любой вкладке,
  // кроме главной, и переключение вкладок сдвигало контент на её высоту.
  const showMobileBack = isMobile && !isTabRoot(location.pathname)
  const isHome = location.pathname === '/'

  // Открыли вложенный экран по ссылке (холодный старт PWA): в истории
  // вернуться некуда, и navigate(-1) ничего бы не сделал — идём в корень
  // его вкладки.
  const goBack = () => {
    if (canGoBack()) navigate(-1)
    else navigate(tabOf(location.pathname), { replace: true })
  }

  useScrollRestoration(mainRef)
  // Свайпы — только в установленном PWA: во вкладке браузера горизонтальный
  // жест у края уже занят его собственным «Назад».
  const tabIndex = MOBILE_NAV.findIndex(({ to }) => to === location.pathname)
  useSwipeNavigation(mainRef, {
    enabled: isStandalone && isMobile && !isFullScreen,
    onBack: showMobileBack ? goBack : null,
    onPrev: tabIndex > 0 ? () => navigate(MOBILE_NAV[tabIndex - 1].to) : null,
    onNext: tabIndex >= 0 && tabIndex < MOBILE_NAV.length - 1 ? () => navigate(MOBILE_NAV[tabIndex + 1].to) : null,
  })

  // Тап по уже открытой вкладке — наверх, как в нативных таб-барах.
  const handleNavClick = (event, to, isActive) => {
    if (isActive && location.pathname === to) {
      event.preventDefault()
      mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    }
    haptic(HAPTIC.selection)
  }

  // Подсветка активного пункта — одна плавающая капсула на всю навигацию, как
  // в iOS-приложении: она едет между ячейками и на ходу растягивается. Индекс
  // активной ячейки считается один раз на рендер, положение — в CSS.
  const activeNavIndex = Math.max(
    0,
    MOBILE_NAV.findIndex(({ to }) =>
      to === '/' ? location.pathname === '/' : location.pathname.startsWith(to)
    )
  )
  // Деформация включается только на смене вкладки: на первом рендере капсула
  // должна стоять на месте, а не пульсировать.
  const [navDeform, setNavDeform] = useState(false)
  const lastNavIndex = useRef(activeNavIndex)

  useEffect(() => {
    if (lastNavIndex.current === activeNavIndex) return
    lastNavIndex.current = activeNavIndex
    setNavDeform(true)
    const timer = setTimeout(() => setNavDeform(false), 400)
    return () => clearTimeout(timer)
  }, [activeNavIndex])

  return (
    <div className="layout" style={{ '--sidebar-width': isMobile ? '0px' : `${sidebarWidth}px` }}>
      <Sidebar />
      {showMobileBack && (
        <div className="mobile-topbar">
          <button
            type="button"
            className="mobile-back-btn"
            onClick={goBack}
            aria-label="Назад"
          >
            <ArrowLeft size={20} />
          </button>
          <div className="mobile-topbar-title" aria-hidden="true">
        
          </div>
          <div className="mobile-topbar-spacer" />
        </div>
      )}
      {/* Подложка под статус-бар: контент уезжает под часы не «голым», а
          под матовую полосу, как под системный бар. Главной не нужна — её
          hero специально заходит под статус-бар. */}
      {isMobile && !isHome && !showMobileBack && <div className="mobile-status-scrim" aria-hidden="true" />}
      <main
        ref={mainRef}
        className={`main-content ${showMobileBack ? 'has-mobile-topbar' : ''} ${isMobile && !isHome && !showMobileBack ? 'has-safe-top' : ''}`}
        style={{ marginLeft: isMobile ? 0 : `${sidebarWidth}px` }}
      >
        {children}
      </main>
      <Player />
      <ToastContainer />
      <AddToPlaylistDialog />
      <CensorOverrideDialog />
      {/* fallback пустой: полноэкранный плеер открывается поверх уже
          отрисованного мини-плеера, спиннер здесь мигал бы зря. */}
      {isFullScreen && (
        <Suspense fallback={null}>
          <FullScreenPlayer />
        </Suspense>
      )}
      {isMobile && (
        <nav className="mobile-nav-global" aria-label="Нижняя навигация">
          <span
            className={`mobile-nav-global-pill ${navDeform ? 'moving' : ''}`}
            style={{ '--nav-index': activeNavIndex }}
            aria-hidden="true"
          >
            <span className="mobile-nav-global-pill-inner" />
          </span>
          {MOBILE_NAV.map(({ to, icon: Icon, label }) => {
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
                onPointerEnter={() => prefetchRouteChunk(to)}
                onPointerDown={() => prefetchRouteChunk(to)}
                onClick={(event) => handleNavClick(event, to, isActive)}
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
