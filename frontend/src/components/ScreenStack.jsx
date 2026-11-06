import { memo, Suspense, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useSyncExternalStore } from 'react'
import {
  UNSAFE_LocationContext as LocationContext,
  UNSAFE_RouteContext as RouteContext,
  useLocation,
  useNavigationType,
} from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import Spinner from './Spinner'
import MeterProfiler from './MeterProfiler'
import { ScreenContext } from '../hooks/useScreen'
import { rememberScroll, savedScroll, restoreScrollPosition, scrollKey } from '../services/scrollRestoration'
import {
  TAB_ROOTS,
  clearShownTab,
  entryAt,
  entryIndexOf,
  getShownTab,
  heavyAnimationsHeld,
  isTabRoot,
  onHeavyAnimationsHold,
  subscribeShownTab,
} from '../services/navigation'

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
//   Настройки — как все: меню и раздел — разные записи, а значит и экраны.
//   Раньше это был один экран на все записи, и свайп «Назад» из раздела
//   тянул его над пустотой, а после отпускания тот же экран перерисовывался
//   меню — выглядело как перезагрузка. Чужие правки предпочтений нижний
//   экран не затирает: автосохранение есть только у раздела, где их правят
//   (см. editsPrefs в pages/Settings.jsx).
//
// У каждого экрана свой контейнер прокрутки (.screen-scroll), поэтому скрытые
// вкладки сохраняют позицию сами. Скрыты они через visibility: раскладка
// остаётся готовой, и показать экран под пальцем можно без пересчёта.

export const tabScreenId = (path) => `tab:${path}`
// Слот вложенного экрана для записи истории idx с локацией location.
export const detailScreenId = (idx) => `detail:${idx}`
const isDetailId = (id) => id.startsWith('detail:')

// Позиции прокрутки вложенного экрана по ключу записи истории: «Назад»
// возвращает туда, откуда ушёл, вперёд — сверху. Живым экранам это не
// нужно — их контейнер помнит позицию сам; нужно экрану, созданному заново
// (глубже двух вложенных или после перезагрузки).
function useScrollRestoration(scrollerRef, location, ready, active) {
  const navigationType = useNavigationType()
  const locationRef = useRef(location)
  const pathRef = useRef(null)
  const cancelRestoreRef = useRef(null)
  const restoringRef = useRef(false)
  const pendingTopRef = useRef(null)

  useEffect(() => {
    const el = scrollerRef.current
    if (!el || !ready) return undefined
    const onScroll = () => {
      if (!restoringRef.current) rememberScroll(locationRef.current, el.scrollTop)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [scrollerRef, ready])

  // Layout-эффект: в том же коммите, что и новый экран, до снапшота view
  // transition — анимация сразу едет с правильной позиции.
  useLayoutEffect(() => {
    // Оболочка холодной вкладки пока не прокручивается. Восстановление
    // запускаем с её содержимым: иначе ожидание роста может закончиться
    // во время свайпа, а повторный эффект с тем же путём его уже пропустит.
    if (!ready) return
    const el = scrollerRef.current
    const path = scrollKey(location)
    const firstMount = pathRef.current === null
    const samePath = pathRef.current === path
    locationRef.current = location
    pathRef.current = path
    if (!el) return
    cancelRestoreRef.current?.()
    cancelRestoreRef.current = null
    if (!samePath) {
      const saved = firstMount || navigationType === 'POP' ? savedScroll(location) : 0
      // Новый вложенный экран открывается сверху. Возврат и новый запуск
      // восстанавливают позицию; вкладки остаются смонтированными.
      const restore = navigationType === 'POP' || isTabRoot(location.pathname) || (firstMount && location.state?.__boltResume)
      pendingTopRef.current = saved && restore ? saved : null
      if (pendingTopRef.current === null) {
        restoringRef.current = false
        el.scrollTop = 0
        return
      }
    }
    const target = pendingTopRef.current
    if (target === null) return
    restoringRef.current = true
    // Сосед под пальцем встаёт на доступную позицию, даже если данные
    // заменили спиннер уже после прогрева. Дедлайн запускаем при открытии:
    // скрытая вкладка не догружает страницы до далёкой сохранённой строки.
    let cancelled = false
    const stop = restoreScrollPosition(el, target, () => {
      restoringRef.current = false
      if (!cancelled) pendingTopRef.current = null
    }, { timeoutMs: active ? 10000 : 0 })
    cancelRestoreRef.current = () => {
      cancelled = true
      stop()
    }
  }, [location.key, ready, active])

  useEffect(() => () => {
    cancelRestoreRef.current?.()
    pathRef.current = null
  }, [])
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

const Screen = memo(function Screen({ id, location, active, ready = true, isMobile, renderRoutes, onBack }) {
  const scrollerRef = useRef(null)
  const context = useMemo(() => ({ active, scrollerRef, pathname: location.pathname }), [active, location.pathname])
  const locationContext = useMemo(() => ({ location, navigationType: 'POP' }), [location])
  const path = location.pathname
  // «Назад» — только у вложенных экранов, как в нативном стеке. Панель —
  // часть экрана: при свайпе и переходе едет вместе с ним.
  const topbar = isMobile && !isTabRoot(path)
  // Отступ под статус-бар, чтобы заголовок не прятался под часами. Подложки
  // под часами нет: тёмная полоса резала шапки с обложкой во весь верх.
  // Главной отступ не нужен — её hero заходит под статус-бар.
  const safeTop = isMobile && path !== '/'
  useScrollRestoration(scrollerRef, location, ready, active)

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
        </div>
      )}
      <div
        ref={scrollerRef}
        className={`screen-scroll${topbar ? ' has-mobile-topbar' : safeTop ? ' has-safe-top' : ''}${path === '/settings' || path.startsWith('/settings/') ? ' is-settings' : ''}`}
      >
        <RouteContext.Provider value={ROOT_ROUTE_CONTEXT}>
          <LocationContext.Provider value={locationContext}>
            <ScreenContext.Provider value={context}>
              <MeterProfiler id={`экран ${path.split('/')[1] || 'home'}${active ? '' : ' (скрыт)'}`}>
                <Suspense fallback={<Spinner page />}>{ready ? renderRoutes(location) : <Spinner page />}</Suspense>
              </MeterProfiler>
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
    : window.setTimeout(fn, 32)
const cancelIdle = (handle) =>
  typeof window.cancelIdleCallback === 'function' ? window.cancelIdleCallback(handle) : window.clearTimeout(handle)

// Пауза перед прогревом вкладок: первый экран успевает загрузиться без
// конкуренции за сеть и главный поток.
const WARM_DELAY_MS = 250

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
  const currentId = currentIsTab ? null : detailScreenId(idx)
  const below = entryAt(idx - 1)
  const belowId = !currentIsTab && below && !isTabRoot(below.pathname) ? detailScreenId(idx - 1) : null
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
      if (handle !== null || heavyAnimationsHeld()) return
      const next = TAB_ROOTS.find((path) => !mountedTabsRef.current.has(path))
      if (!next) return
      handle = idle(() => {
        handle = null
        if (heavyAnimationsHeld()) return
        mountedTabsRef.current.add(next)
        forceUpdate()
        warmNext()
      })
    }
    // Монтаж списков между событиями движения отнимает кадры у пальца.
    // Оболочка соседа уже есть; прогрев содержимого продолжится после жеста.
    const offHold = onHeavyAnimationsHold((held) => {
      if (held && handle !== null) {
        cancelIdle(handle)
        handle = null
      }
      if (!held) warmNext()
    })
    const timer = window.setTimeout(warmNext, WARM_DELAY_MS)
    return () => {
      offHold()
      window.clearTimeout(timer)
      if (handle !== null) cancelIdle(handle)
    }
  }, [warmTabs])

  // Вкладка, показанная по тапу до коммита роутера (см. showTabNow). Только
  // уже смонтированная (несмонтированную рисовать нечем, её покажет коммит)
  // и только с другой вкладки (переход с вложенного экрана — View Transition).
  const shownTab = useSyncExternalStore(subscribeShownTab, getShownTab)
  const early =
    shownTab && currentIsTab && shownTab !== location.pathname && mountedTabsRef.current.has(shownTab)
      ? shownTab
      : null
  const activePath = early ?? location.pathname

  // Роутер догнал — дальше ведёт он. Не догнал за 2 с (переход отменён) —
  // возвращаемся к его экрану, а не висим на чужой вкладке.
  useEffect(() => {
    if (shownTab && shownTab === location.pathname) clearShownTab()
  }, [shownTab, location.pathname])
  useEffect(() => {
    if (!shownTab) return undefined
    const timer = window.setTimeout(clearShownTab, 2000)
    return () => window.clearTimeout(timer)
  }, [shownTab])

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
      {/* Оболочки всех вкладок готовы сразу: даже до загрузки чанка сосед
          едет под пальцем. Содержимое прогревается по одной странице. */}
      {TAB_ROOTS.filter((path) => warmTabs || mountedTabsRef.current.has(path)).map((path) => (
        <Screen
          key={path}
          id={tabScreenId(path)}
          location={tabLocation(path)}
          active={activePath === path}
          ready={mountedTabsRef.current.has(path)}
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
          active={!early && id === currentId}
          isMobile={isMobile}
          renderRoutes={renderRoutes}
          onBack={onBack}
        />
      ))}
    </>
  )
}

export default ScreenStack
