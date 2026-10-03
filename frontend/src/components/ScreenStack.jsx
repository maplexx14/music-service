import { memo, Suspense, useEffect, useLayoutEffect, useMemo, useReducer, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import Spinner from './Spinner'
import { ScreenContext } from '../hooks/useScreen'
import { TAB_ROOTS, isTabRoot } from '../services/navigation'

// Стек экранов, как в Telegram: корни вкладок не размонтируются при уходе,
// а прячутся. Свайп между вкладками или «Назад» к вкладке показывает под
// пальцем уже готовый экран с его прокруткой, а не пустоту, и возврат на
// вкладку мгновенный, без повторной загрузки.
//
// Экраны:
// - tab:<путь> — корень вкладки; после первого показа живёт до конца сессии.
//   С warmTabs остальные вкладки монтируются заранее, по одной в простое,
//   чтобы соседняя была готова к первому же свайпу.
// - detail — все вложенные экраны (артист, альбом, плейлист, настройки) в
//   одном слоте: он есть, только пока открыт вложенный экран.
//
// У каждого экрана свой контейнер прокрутки (.screen-scroll), поэтому скрытые
// вкладки сохраняют позицию сами. Скрыты они через visibility: раскладка
// остаётся готовой, и показать экран под пальцем можно без пересчёта.

export const tabScreenId = (path) => `tab:${path}`
export const DETAIL_SCREEN_ID = 'detail'

// Позиции прокрутки вложенного экрана по ключу записи истории: «Назад»
// возвращает туда, откуда ушёл, вперёд — сверху. Вкладкам не нужно: их
// контейнер не размонтируется.
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

const Screen = memo(function Screen({ id, location, active, isMobile, renderRoutes, onBack }) {
  const scrollerRef = useRef(null)
  const context = useMemo(() => ({ active, scrollerRef }), [active])
  const path = location.pathname
  // «Назад» — только у вложенных экранов, как в нативном стеке. Панель —
  // часть экрана: при свайпе и переходе едет вместе с ним.
  const topbar = isMobile && !isTabRoot(path)
  // Подложка под статус-бар: контент уезжает под часы не «голым», а под
  // матовую полосу. Главной не нужна — её hero заходит под статус-бар.
  const safeTop = isMobile && path !== '/' && !topbar
  useDetailScrollRestoration(scrollerRef, location, id === DETAIL_SCREEN_ID)

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
        <ScreenContext.Provider value={context}>
          <Suspense fallback={<Spinner page />}>{renderRoutes(location)}</Suspense>
        </ScreenContext.Provider>
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

  const currentIsTab = isTabRoot(location.pathname)
  if (currentIsTab) {
    mountedTabsRef.current.add(location.pathname)
    tabLocationsRef.current.set(location.pathname, location)
  }

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
      {!currentIsTab && (
        <Screen
          key={DETAIL_SCREEN_ID}
          id={DETAIL_SCREEN_ID}
          location={location}
          active
          isMobile={isMobile}
          renderRoutes={renderRoutes}
          onBack={onBack}
        />
      )}
    </>
  )
}

export default ScreenStack
