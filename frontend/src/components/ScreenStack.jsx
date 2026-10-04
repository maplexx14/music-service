import { memo, Suspense, useEffect, useLayoutEffect, useMemo, useReducer, useRef } from 'react'
import {
  UNSAFE_LocationContext as LocationContext,
  UNSAFE_RouteContext as RouteContext,
  useLocation,
  useNavigationType,
} from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import Spinner from './Spinner'
import { ScreenContext } from '../hooks/useScreen'
import { TAB_ROOTS, entryAt, entryIndexOf, isTabRoot } from '../services/navigation'

// Стек экранов, как в Telegram: корни вкладок не размонтируются при уходе,
// а прячутся. Свайп между вкладками или «Назад» к вкладке показывает под
// пальцем уже готовый экран с его прокруткой, а не пустоту, и возврат на
// вкладку мгновенный, без повторной загрузки.
//
// Экраны:
// - tab:<путь> — корень вкладки; после первого показа живёт до конца сессии.
//   С warmTabs остальные вкладки монтируются заранее, по одной в простое,
//   чтобы соседняя была готова к первому же свайпу.
// - detail:<индекс записи истории> — вложенные экраны (артист, альбом,
//   плейлист, настройки). Живут текущий и тот, что под ним в истории: свайп
//   «Назад» показывает его под пальцем, а возврат на него мгновенный, с
//   прежней прокруткой. Глубже стек не держим — память. После «Назад»
//   следующий нижний экран досоздаётся в простое, а не в коммите возврата.
//   Смена query на том же экране (REPLACE) индекс не меняет — экран тот же.
//   Исключение — настройки: меню и разделы — один экран на все записи, как
//   и один маршрут в App.jsx, иначе несохранённые предпочтения терялись бы.
//
// У каждого экрана свой контейнер прокрутки (.screen-scroll), поэтому скрытые
// вкладки сохраняют позицию сами. Скрыты они через visibility: раскладка
// остаётся готовой, и показать экран под пальцем можно без пересчёта.

export const tabScreenId = (path) => `tab:${path}`
// Слот вложенного экрана для записи истории idx с локацией location.
export const detailScreenId = (idx, location) =>
  location?.pathname.startsWith('/settings') ? 'detail:settings' : `detail:${idx}`
const isDetailId = (id) => id.startsWith('detail:')

// Позиции прокрутки вложенного экрана по ключу записи истории: «Назад»
// возвращает туда, откуда ушёл, вперёд — сверху. Живым экранам это не
// нужно — их контейнер помнит позицию сам; нужно экрану, созданному заново
// (глубже двух вложенных или после перезагрузки).
const RESTORE_WINDOW_MS = 1200
const MAX_POSITIONS = 100
const positions = new Map()

function remember(key, top) {
  positions.delete(key)
  positions.set(key, top)
  if (positions.size > MAX_POSITIONS) positions.delete(positions.keys().next().value)
}

// Экран без кэша дорастает до прежней высоты не сразу: докручиваем позицию
// по мере роста, пока пользователь сам не взялся за скролл.
function restoreWhenTallEnough(el, target) {
  let frame = 0
  const deadline = performance.now() + RESTORE_WINDOW_MS
  const stop = () => {
    cancelAnimationFrame(frame)
    el.removeEventListener('touchstart', stop)
    el.removeEventListener('wheel', stop)
  }
  const tick = () => {
    el.scrollTop = target
    if (Math.abs(el.scrollTop - target) <= 1 || performance.now() > deadline) {
      stop()
      return
    }
    frame = requestAnimationFrame(tick)
  }
  el.addEventListener('touchstart', stop, { passive: true })
  el.addEventListener('wheel', stop, { passive: true })
  frame = requestAnimationFrame(tick)
  return stop
}

function useDetailScrollRestoration(scrollerRef, location, enabled) {
  const navigationType = useNavigationType()
  const keyRef = useRef(location.key)
  const pathRef = useRef(null)
  const cancelRestoreRef = useRef(null)

  useEffect(() => {
    const el = scrollerRef.current
    if (!el || !enabled) return undefined
    const onScroll = () => remember(keyRef.current, el.scrollTop)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [scrollerRef, enabled])

  // Layout-эффект: в том же коммите, что и новый экран, до снапшота view
  // transition — анимация сразу едет с правильной позиции.
  useLayoutEffect(() => {
    if (!enabled) return
    const el = scrollerRef.current
    const samePath = pathRef.current === location.pathname
    keyRef.current = location.key
    pathRef.current = location.pathname
    cancelRestoreRef.current?.()
    cancelRestoreRef.current = null
    // Смена query/hash на том же экране (фильтры, разделы) скролл не трогает.
    if (!el || samePath) return
    const saved = navigationType === 'POP' ? positions.get(location.key) : undefined
    if (!saved) {
      el.scrollTop = 0
      return
    }
    el.scrollTop = saved
    if (Math.abs(el.scrollTop - saved) > 1) cancelRestoreRef.current = restoreWhenTallEnough(el, saved)
  }, [location.key, enabled])

  useEffect(() => () => cancelRestoreRef.current?.(), [])
}

// Контексты роутера, которые экран отдаёт своему поддереву. Вложенный
// <Routes location> сам подписан на глобальную локацию и родительский
// RouteContext и на каждый переход раздаёт новые объекты контекста — так
// любая навигация перерисовывала все смонтированные экраны, где есть
// useNavigate/useParams (а это почти все страницы), и тап по вкладке ждал
// этого рендера. Экран подменяет оба контекста своими, стабильными: скрытые
// экраны перерисовываются, только когда меняется их собственная локация.
// Родитель — маршрут "/*" с базой "/", пустой список матчей даёт ту же базу.
const ROOT_ROUTE_CONTEXT = { outlet: null, matches: [], isDataRoute: false }

const Screen = memo(function Screen({ id, location, active, isMobile, renderRoutes, onBack }) {
  const scrollerRef = useRef(null)
  const context = useMemo(() => ({ active, scrollerRef }), [active])
  const locationContext = useMemo(() => ({ location, navigationType: 'POP' }), [location])
  const path = location.pathname
  // «Назад» — только у вложенных экранов, как в нативном стеке. Панель —
  // часть экрана: при свайпе и переходе едет вместе с ним.
  const topbar = isMobile && !isTabRoot(path)
  // Подложка под статус-бар: контент уезжает под часы не «голым», а под
  // матовую полосу. Главной не нужна — её hero заходит под статус-бар.
  const safeTop = isMobile && path !== '/' && !topbar
  useDetailScrollRestoration(scrollerRef, location, isDetailId(id))

  return (
    <div
      className="screen"
      data-screen={id}
      data-active={active ? '' : undefined}
      aria-hidden={active ? undefined : 'true'}
      {...(active ? null : { inert: '' })}
    >
      {topbar && (
        <div className="mobile-topbar">
          <button type="button" className="mobile-back-btn" onClick={onBack} aria-label="Назад">
            <ArrowLeft size={20} />
          </button>
          <div className="mobile-topbar-title" aria-hidden="true" />
          <div className="mobile-topbar-spacer" />
        </div>
      )}
      {safeTop && <div className="mobile-status-scrim" aria-hidden="true" />}
      <div
        ref={scrollerRef}
        className={`screen-scroll${topbar ? ' has-mobile-topbar' : ''}${safeTop ? ' has-safe-top' : ''}`}
      >
        <RouteContext.Provider value={ROOT_ROUTE_CONTEXT}>
          <LocationContext.Provider value={locationContext}>
            <ScreenContext.Provider value={context}>
              <Suspense fallback={<Spinner page />}>{renderRoutes(location)}</Suspense>
            </ScreenContext.Provider>
          </LocationContext.Provider>
        </RouteContext.Provider>
      </div>
    </div>
  )
})

const idle = (fn) =>
  typeof window.requestIdleCallback === 'function'
    ? window.requestIdleCallback(fn, { timeout: 3000 })
    : window.setTimeout(fn, 1200)
const cancelIdle = (handle) =>
  typeof window.cancelIdleCallback === 'function' ? window.cancelIdleCallback(handle) : window.clearTimeout(handle)

// Пауза перед прогревом вкладок: первый экран успевает загрузиться без
// конкуренции за сеть и главный поток.
const WARM_DELAY_MS = 1500

function ScreenStack({ renderRoutes, isMobile, warmTabs, onBack }) {
  const location = useLocation()
  const [, forceUpdate] = useReducer((n) => n + 1, 0)
  const mountedTabsRef = useRef(new Set())
  // Последняя локация каждой вкладки: скрытый экран рендерится со своей,
  // а не с текущей, — его маршрут не должен меняться под чужой путь.
  const tabLocationsRef = useRef(new Map())
  // Смонтированные вложенные экраны: id слота → { idx, location }.
  const detailsRef = useRef(new Map())

  const currentIsTab = isTabRoot(location.pathname)
  if (currentIsTab) {
    mountedTabsRef.current.add(location.pathname)
    tabLocationsRef.current.set(location.pathname, location)
  }

  const idx = entryIndexOf(location.key)
  const currentId = currentIsTab ? null : detailScreenId(idx, location)
  const below = entryAt(idx - 1)
  const belowId = !currentIsTab && below && !isTabRoot(below.pathname) ? detailScreenId(idx - 1, below) : null
  const belowSeparate = belowId && belowId !== currentId
  {
    const details = detailsRef.current
    const keep = new Map()
    if (currentId) {
      keep.set(currentId, { idx, location })
      // Нижний остаётся, если уже смонтирован (был текущим до перехода вперёд).
      if (belowSeparate && details.has(belowId)) keep.set(belowId, { idx: idx - 1, location: below })
    }
    detailsRef.current = keep
  }

  // После «Назад» нижнего вложенного экрана ещё нет — создаём в простое,
  // чтобы рендер страницы не лёг на сам переход.
  const needsBelow = belowSeparate && !detailsRef.current.has(belowId)
  useEffect(() => {
    if (!needsBelow) return undefined
    const handle = idle(() => {
      if (entryIndexOf(location.key) !== idx || entryAt(idx - 1) !== below) return
      detailsRef.current.set(belowId, { idx: idx - 1, location: below })
      forceUpdate()
    })
    return () => cancelIdle(handle)
  }, [needsBelow, idx, below, belowId, location.key])

  useEffect(() => {
    if (!warmTabs) return undefined
    let handle = null
    const warmNext = () => {
      const next = TAB_ROOTS.find((path) => !mountedTabsRef.current.has(path))
      if (!next) return
      handle = idle(() => {
        mountedTabsRef.current.add(next)
        forceUpdate()
        warmNext()
      })
    }
    const timer = window.setTimeout(warmNext, WARM_DELAY_MS)
    return () => {
      window.clearTimeout(timer)
      if (handle !== null) cancelIdle(handle)
    }
  }, [warmTabs])

  const tabLocation = (path) => {
    let saved = tabLocationsRef.current.get(path)
    if (!saved) {
      saved = { pathname: path, search: '', hash: '', state: null, key: `warm${path}` }
      tabLocationsRef.current.set(path, saved)
    }
    return saved
  }

  const details = [...detailsRef.current.entries()].sort(([, a], [, b]) => a.idx - b.idx)

  return (
    <>
      {TAB_ROOTS.filter((path) => mountedTabsRef.current.has(path)).map((path) => (
        <Screen
          key={path}
          id={tabScreenId(path)}
          location={tabLocation(path)}
          active={location.pathname === path}
          isMobile={isMobile}
          renderRoutes={renderRoutes}
          onBack={onBack}
        />
      ))}
      {details.map(([id, entry]) => (
        <Screen
          key={id}
          id={id}
          location={entry.location}
          active={id === currentId}
          isMobile={isMobile}
          renderRoutes={renderRoutes}
          onBack={onBack}
        />
      ))}
    </>
  )
}

export default ScreenStack
