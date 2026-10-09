import { createBrowserHistory } from '@remix-run/router'

// Навигация «как в нативном приложении»: анимированные переходы экранов
// (push — новый экран въезжает справа, back — уезжает вправо, вкладки —
// мгновенно), общий для роутера и Layout словарь вкладок и детект платформы.
//
// Зачем свой history: <BrowserRouter viewTransition> проп viewTransition
// молча игнорирует (он есть только у data-роутеров), и смена экрана была
// мгновенной подменой без анимации. Здесь подписка роутера на history
// оборачивается в document.startViewTransition.

export const TAB_ROOTS = ['/', '/search', '/liked', '/playlists']

export const isTabRoot = (pathname) => TAB_ROOTS.includes(pathname)

// Куда вернуться после входа: ?next= с внутренним путём. Только «/…», не
// «//host» — иначе это открытый редирект на чужой сайт.
export function safeNextPath(searchParams) {
  const next = searchParams.get('next')
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/'
}

// Вкладка, которой принадлежит экран: для подсветки и «Назад» с холодного
// старта (deep link), когда в истории вернуться некуда.
export function tabOf(pathname) {
  if (pathname.startsWith('/playlists') || pathname.startsWith('/external') || pathname.startsWith('/albums')) {
    return '/playlists'
  }
  if (pathname.startsWith('/liked')) return '/liked'
  if (pathname.startsWith('/search') || pathname.startsWith('/artists')) return '/search'
  return '/'
}

const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
// iPadOS представляется Mac'ом — отличаем по тачу.
export const isIOS =
  /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1)

// iOS-PWA с домашнего экрана: у неё нет ни системного свайпа назад, ни
// кнопки «Назад» браузера — их даёт само приложение.
export const isIOSStandalone = typeof navigator !== 'undefined' && navigator.standalone === true

export const isStandalone =
  isIOSStandalone ||
  (typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)').matches)

const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

const isMobileViewport = () => window.innerWidth <= 768

// Можно ли вернуться назад внутри приложения. createBrowserHistory кладёт
// порядковый номер записи в history.state.idx.
export const canGoBack = () => (window.history.state?.idx ?? 0) > 0

const viewTransitionsEnabled = () =>
  typeof document !== 'undefined' &&
  typeof document.startViewTransition === 'function' &&
  !prefersReducedMotion() &&
  !document.documentElement.classList.contains('lite-mode')

// Морф внутри экрана, а не навигация: update синхронно меняет DOM, а
// элементы, которым CSS дал view-transition-name под html[data-morph=name],
// переезжают из старого положения и размера в новые (FLIP силами браузера).
// Только десктоп: на iOS PWA снапшоты View Transitions поверх оверлеев
// затемняли экран (см. FullScreenPlayer, startClose).
export function morphTransition(name, update) {
  if (!viewTransitionsEnabled() || isMobileViewport() || document.hidden) {
    update()
    return
  }
  const root = document.documentElement
  root.dataset.morph = name
  const transition = document.startViewTransition(update)
  transition.finished.finally(() => {
    if (root.dataset.morph === name) delete root.dataset.morph
  })
}

// Пока экран едет (свайп пальцем или анимация перехода), тяжёлый декор —
// WebGL-фон главной (Grainient) — ставится на паузу. Вертикальную прокрутку
// он и так пропускает (её ведёт система вне главного потока), а горизонталь
// двигается из JS: каждый кадр WebGL отнимал у неё время, и экран шёл
// рывками. holdHeavyAnimations возвращает отпускание (повторный вызов — no-op).
let heavyHolds = 0
const heavyListeners = new Set()

export function holdHeavyAnimations() {
  heavyHolds += 1
  if (heavyHolds === 1) heavyListeners.forEach((fn) => fn(true))
  let released = false
  return () => {
    if (released) return
    released = true
    heavyHolds -= 1
    if (heavyHolds === 0) heavyListeners.forEach((fn) => fn(false))
  }
}

// fn(held) — при смене состояния; сразу не вызывается. Возвращает отписку.
export function onHeavyAnimationsHold(fn) {
  heavyListeners.add(fn)
  return () => heavyListeners.delete(fn)
}

export const heavyAnimationsHeld = () => heavyHolds > 0

// Свайп уже увёз экран пальцем — штатная анимация перехода была бы лишней.
// undefined — выбрать по навигации, null — без анимации, 'swipe' — доиграть
// жест (useSwipeNavigation).
let nextKind
let onSwipeCapture = null
export function skipNextTransitionAnimation() {
  nextKind = null
}

// Доигрывание свайпа через View Transition: старый экран снимается снапшотом
// там, где его оставил палец, и уезжает, а новый в это же время въезжает
// из-под него. onCapture зовётся, когда старый кадр уже снят, а новый ещё не
// рендерился, — в нём снимают сдвиг пальца, чтобы новый кадр был без него.
// Аргумент — transition.finished: конец анимации.
// Возвращает отмену на случай, если навигации так и не случилось.
export function swipeNextTransition(onCapture) {
  if (!viewTransitionsEnabled()) return null
  nextKind = 'swipe'
  onSwipeCapture = onCapture
  return () => {
    if (nextKind === 'swipe') nextKind = undefined
    if (onSwipeCapture === onCapture) onSwipeCapture = null
  }
}

function transitionKind(from, to, action) {
  if (nextKind !== undefined) {
    const kind = nextKind
    nextKind = undefined
    if (!kind || !from || from.pathname === to.pathname || document.hidden) return null
    return kind
  }
  if (!from || from.pathname === to.pathname) return null
  if (!viewTransitionsEnabled()) return null
  // Переключение вкладок в нативных таб-барах мгновенное.
  if (isTabRoot(from.pathname) && isTabRoot(to.pathname)) return null
  if (document.hidden) return null
  if (!isMobileViewport()) return 'fade'
  if (action === 'POP') {
    // Во вкладке Safari «назад» — это системный свайп со своей анимацией
    // страницы; наша поверх него сыграла бы второй раз.
    if (isIOS && !isStandalone) return null
    return 'back'
  }
  if (action === 'PUSH') return 'forward'
  return null
}

// Вкладка, показанная по тапу раньше коммита роутера. Роутер коммитит смену
// локации в startTransition (v7_startTransition, App.jsx) — под стеком
// смонтированных экранов это несколько кадров после тапа, а в нативном
// таб-баре вкладка сменяется в следующем же кадре. Экран вкладки уже
// смонтирован (ScreenStack держит корни вкладок), поэтому показать его можно
// сразу: ScreenStack подписан на это значение, а коммит роутера потом лишь
// подтверждает тот же экран.
let shownTab = null
const shownTabListeners = new Set()

const notifyShownTab = () => shownTabListeners.forEach((fn) => fn())

export function showTabNow(path) {
  if (shownTab === path) return
  shownTab = path
  notifyShownTab()
}

export function clearShownTab() {
  if (shownTab === null) return
  shownTab = null
  notifyShownTab()
}

export function subscribeShownTab(fn) {
  shownTabListeners.add(fn)
  return () => shownTabListeners.delete(fn)
}

export const getShownTab = () => shownTab

// Роутер (startTransition) коммитит новый экран асинхронно, а
// startViewTransition должен дождаться, пока DOM станет «новым». О коммите
// сообщает RouteCommitSignal (App.jsx) из useLayoutEffect — после эффектов
// экрана, в том числе восстановления скролла.
const commitWaiters = new Map()

const commitCallbacks = new Set()

// Разовый колбэк на ближайший коммит нового экрана (из layout-эффекта, до
// отрисовки кадра) — свайп назад снимает в нём сдвиг без мигания.
export function afterNextRouteCommit(callback) {
  commitCallbacks.add(callback)
  return () => commitCallbacks.delete(callback)
}

export function notifyRouteCommitted(key) {
  const resolve = commitWaiters.get(key)
  if (resolve) {
    commitWaiters.delete(key)
    resolve()
  }
  if (commitCallbacks.size) {
    const callbacks = [...commitCallbacks]
    commitCallbacks.clear()
    callbacks.forEach((callback) => callback())
  }
}

// Экран, который ещё грузит данные (рисует <Spinner page />), — как в
// Telegram: переход не стартует, пока новый экран не готов, иначе он въезжал
// пустым со спиннером, а контент выпрыгивал посреди анимации. Ждём недолго:
// на медленной сети лучше въехать со спиннером, чем держать тап без ответа.
let loadingScreens = 0
const readyWaiters = new Set()

export function markScreenLoading() {
  loadingScreens += 1
  let released = false
  return () => {
    if (released) return
    released = true
    loadingScreens -= 1
    if (loadingScreens === 0 && readyWaiters.size) {
      const waiters = [...readyWaiters]
      readyWaiters.clear()
      waiters.forEach((resolve) => resolve())
    }
  }
}

// Дольше не держим экран замороженным (кадр стоит, пока ждём): если чанк
// или данные ещё грузятся, переход доиграет как есть, а контент появится сам.
const READY_TIMEOUT_MS = 500

// waitReady=false — только коммит, без ожидания данных: свайп между
// вкладками уже отпущен пальцем, и замерший на полсекунды кадр там
// ощущается зависанием, а не аккуратностью.
function waitForCommit(key, waitReady = true) {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      commitWaiters.delete(key)
      readyWaiters.delete(finish)
      resolve()
    }
    const timer = setTimeout(finish, READY_TIMEOUT_MS)
    commitWaiters.set(key, () => {
      if (!waitReady || loadingScreens === 0) finish()
      else readyWaiters.add(finish)
    })
  })
}

let activeTransition = null

// Записи истории этой сессии по индексу (history.state.idx): какой экран
// лежит под текущим. Свайп «Назад» показывает его под пальцем, если он
// смонтирован (ScreenStack держит вкладки и предыдущий вложенный экран).
// После перезагрузки страницы прошлые записи неизвестны — тогда null.
//
// Индекс записи по ключу локации запоминается здесь, в момент навигации:
// роутер коммитит экран позже (startTransition), и history.state к рендеру
// может уже указывать на следующую запись.
const entries = []
const indexByKey = new Map()
const currentIdx = () => window.history.state?.idx ?? 0

function recordEntry(location, action) {
  const idx = currentIdx()
  if (action === 'PUSH') entries.length = idx
  if (action !== 'POP' || !entries[idx]) entries[idx] = location
  indexByKey.set(location.key, idx)
}

export const entryIndexOf = (key) => indexByKey.get(key) ?? currentIdx()

export const entryAt = (idx) => (idx >= 0 ? entries[idx] ?? null : null)

// Новый жест поверх доигрывающего перехода: анимацию сразу доводим до конца
// (живой экран вместо снапшотов), чтобы касание не ждало её окончания.
export function finishActiveTransition() {
  activeTransition?.skipTransition()
}

export function createAppHistory() {
  const history = createBrowserHistory({ v5Compat: true })
  let current = history.location
  let active = null
  recordEntry(history.location, 'REPLACE')

  const listen = (fn) =>
    history.listen((update) => {
      const from = current
      current = update.location
      recordEntry(update.location, update.action)
      const kind = transitionKind(from, update.location, update.action)
      if (!kind) {
        fn(update)
        return
      }
      // Новый переход поверх идущего: старый обрываем, иначе снапшоты
      // двух переходов накладываются.
      active?.skipTransition()
      const root = document.documentElement
      root.dataset.nav = kind
      const capture = kind === 'swipe' ? onSwipeCapture : null
      onSwipeCapture = null
      const transition = document.startViewTransition(() => {
        // transition уже присвоен: колбэк обновления вызывается асинхронно.
        capture?.(transition.finished)
        const committed = waitForCommit(update.location.key, kind !== 'swipe')
        fn(update)
        return committed
      })
      active = transition
      activeTransition = transition
      const release = holdHeavyAnimations()
      transition.finished.finally(() => {
        release()
        if (activeTransition === transition) activeTransition = null
        if (active === transition) {
          active = null
          delete root.dataset.nav
        }
      })
    })

  return new Proxy(history, {
    get(target, prop) {
      if (prop === 'listen') return listen
      const value = target[prop]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
