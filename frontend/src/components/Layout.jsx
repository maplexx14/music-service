import { lazy, Suspense, useCallback, useState, useEffect, useRef } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Home, Search, Library, Heart } from 'lucide-react'
import { usePlayerStore } from '../store/playerStore'
import { useSwipeNavigation } from '../hooks/useSwipeNavigation'
import { isTabRoot, tabOf, canGoBack, isStandalone, previousEntry } from '../services/navigation'
import { haptic, HAPTIC } from '../utils/haptics'
import ScreenStack, { tabScreenId } from './ScreenStack'
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

function Layout({ renderRoutes }) {
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
  // вкладок его нет. Сама панель рисуется в экране (ScreenStack).
  const showMobileBack = isMobile && !isTabRoot(location.pathname)

  // Открыли вложенный экран по ссылке (холодный старт PWA): в истории
  // вернуться некуда, и navigate(-1) ничего бы не сделал — идём в корень
  // его вкладки.
  // Стабильная ссылка: кнопка «Назад» живёт в мемоизированном экране.
  const pathnameRef = useRef(location.pathname)
  pathnameRef.current = location.pathname
  const goBack = useCallback(() => {
    if (canGoBack()) navigate(-1)
    else navigate(tabOf(pathnameRef.current), { replace: true })
  }, [navigate])

  // Свайпы — только в установленном PWA: во вкладке браузера горизонтальный
  // жест у края уже занят его собственным «Назад».
  const swipeEnabled = isStandalone && isMobile
  const tabIndex = MOBILE_NAV.findIndex(({ to }) => to === location.pathname)
  const prevTab = tabIndex > 0 ? MOBILE_NAV[tabIndex - 1].to : null
  const nextTab = tabIndex >= 0 && tabIndex < MOBILE_NAV.length - 1 ? MOBILE_NAV[tabIndex + 1].to : null
  // Экран, который окажется под пальцем: вкладка, куда ведёт «Назад», или
  // соседняя вкладка. Вложенный экран под вложенным не хранится — там свайп
  // доигрывает переход без живого экрана под пальцем.
  const backPath = canGoBack() ? previousEntry()?.pathname : tabOf(location.pathname)
  const backTarget = backPath && isTabRoot(backPath) ? tabScreenId(backPath) : null
  useSwipeNavigation(mainRef, {
    enabled: swipeEnabled && !isFullScreen,
    onBack: showMobileBack ? goBack : null,
    onPrev: prevTab ? () => navigate(prevTab) : null,
    onNext: nextTab ? () => navigate(nextTab) : null,
    targets: {
      right: showMobileBack ? backTarget : prevTab && tabScreenId(prevTab),
      left: nextTab && tabScreenId(nextTab),
    },
  })

  // Тап по уже открытой вкладке — наверх, как в нативных таб-барах.
  const handleNavClick = (event, to, isActive) => {
    // Клик, завершивший протяжку пальцем по панели: переход уже сделан там.
    if (performance.now() < navSuppressClickUntil.current) {
      event.preventDefault()
      return
    }
    if (isActive && location.pathname === to) {
      event.preventDefault()
      mainRef.current
        ?.querySelector(':scope > .screen[data-active] > .screen-scroll')
        ?.scrollTo({ top: 0, behavior: 'smooth' })
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
    setPendingNavIndex(null)
    setNavDeform(true)
    const timer = setTimeout(() => setNavDeform(false), 400)
    return () => clearTimeout(timer)
  }, [activeNavIndex])

  // Протяжка пальцем по панели, как в Telegram: капсула едет за пальцем,
  // подсвечивается вкладка под ним, отпустили — открылась она. Короткий тап
  // по-прежнему обычный клик по ссылке.
  //
  // Пока палец на панели, капсулу двигаем напрямую (style.transform в px), без
  // React-рендера на каждое движение. После отпускания её ведёт CSS-переход к
  // выбранной ячейке: pendingNavIndex держит её там, пока роутер не закоммитит
  // новый экран, — иначе она дёрнулась бы назад к старой вкладке.
  const navRef = useRef(null)
  const navPillRef = useRef(null)
  const navDragRef = useRef(null)
  const navSuppressClickUntil = useRef(0)
  const [navHoverIndex, setNavHoverIndex] = useState(null)
  const [pendingNavIndex, setPendingNavIndex] = useState(null)
  const displayNavIndex = navHoverIndex ?? pendingNavIndex ?? activeNavIndex

  const navGeometry = () => {
    const rect = navRef.current.getBoundingClientRect()
    return { rect, cell: rect.width / MOBILE_NAV.length }
  }
  const navIndexAt = (clientX) => {
    const { rect, cell } = navGeometry()
    return Math.min(MOBILE_NAV.length - 1, Math.max(0, Math.floor((clientX - rect.left) / cell)))
  }
  const releaseNavPill = () => {
    const pill = navPillRef.current
    if (!pill) return
    pill.style.transition = ''
    pill.style.transform = ''
  }

  const handleNavPointerDown = (event) => {
    if (event.pointerType === 'mouse' || !event.isPrimary) return
    navDragRef.current = { id: event.pointerId, x: event.clientX, dragging: false, index: navIndexAt(event.clientX) }
  }
  const handleNavPointerMove = (event) => {
    const drag = navDragRef.current
    if (!drag || drag.id !== event.pointerId) return
    if (!drag.dragging) {
      if (Math.abs(event.clientX - drag.x) < 8) return
      drag.dragging = true
      navRef.current.setPointerCapture?.(event.pointerId)
      setNavHoverIndex(drag.index)
    }
    const { rect, cell } = navGeometry()
    const x = Math.min(rect.width - cell, Math.max(0, event.clientX - rect.left - cell / 2))
    const pill = navPillRef.current
    if (pill) {
      pill.style.transition = 'none'
      pill.style.transform = `translateX(${x}px)`
    }
    const index = navIndexAt(event.clientX)
    if (index !== drag.index) {
      drag.index = index
      haptic(HAPTIC.selection)
      setNavHoverIndex(index)
    }
  }
  const handleNavPointerEnd = (event) => {
    const drag = navDragRef.current
    if (!drag || drag.id !== event.pointerId) return
    navDragRef.current = null
    if (!drag.dragging) return
    navSuppressClickUntil.current = performance.now() + 400
    setNavHoverIndex(null)
    releaseNavPill()
    if (event.type === 'pointercancel') return
    const { to } = MOBILE_NAV[drag.index]
    if (drag.index !== activeNavIndex || location.pathname !== to) {
      setPendingNavIndex(drag.index)
      navigate(to)
    }
  }

  return (
    <div className="layout" style={{ '--sidebar-width': isMobile ? '0px' : `${sidebarWidth}px` }}>
      <Sidebar />
      <main ref={mainRef} className="main-content" style={{ marginLeft: isMobile ? 0 : `${sidebarWidth}px` }}>
        <ScreenStack renderRoutes={renderRoutes} isMobile={isMobile} warmTabs={swipeEnabled} onBack={goBack} />
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
        <nav
          ref={navRef}
          className="mobile-nav-global"
          aria-label="Нижняя навигация"
          onPointerDown={handleNavPointerDown}
          onPointerMove={handleNavPointerMove}
          onPointerUp={handleNavPointerEnd}
          onPointerCancel={handleNavPointerEnd}
        >
          <span
            ref={navPillRef}
            className={`mobile-nav-global-pill ${navDeform || navHoverIndex !== null ? 'moving' : ''}`}
            style={{ '--nav-index': displayNavIndex }}
            aria-hidden="true"
          >
            <span className="mobile-nav-global-pill-inner" />
          </span>
          {MOBILE_NAV.map(({ to, icon: Icon, label }, index) => {
            const isActive =
              to === '/'
                ? location.pathname === '/'
                : location.pathname.startsWith(to)
            // Подсветка иконки идёт за пальцем (и за выбранной, пока экран
            // меняется); aria-current — только за реальным маршрутом.
            const isLit = index === displayNavIndex
            return (
              <Link
                key={to}
                to={to}
                className={`mobile-nav-global-item ${isLit ? 'active' : ''}`}
                aria-current={isActive ? 'page' : undefined}
                aria-label={label}
                onPointerEnter={() => prefetchRouteChunk(to)}
                onPointerDown={() => prefetchRouteChunk(to)}
                onClick={(event) => handleNavClick(event, to, isActive)}
              >
                <span className="mobile-nav-global-icon">
                  <Icon size={22} fill={isLit ? 'currentColor' : 'none'} />
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
