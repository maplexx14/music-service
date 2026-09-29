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

// Свайп назад уже увёз экран пальцем — повторная анимация была бы лишней.
let skipNextAnimation = false
export function skipNextTransitionAnimation() {
  skipNextAnimation = true
}

function transitionKind(from, to, action) {
  if (skipNextAnimation) {
    skipNextAnimation = false
    return null
  }
  if (!from || from.pathname === to.pathname) return null
  if (typeof document === 'undefined' || typeof document.startViewTransition !== 'function') return null
  if (prefersReducedMotion() || document.documentElement.classList.contains('lite-mode')) return null
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

// Дольше не держим экран замороженным: если чанк страницы ещё грузится,
// переход доиграет по старому кадру, а новый экран появится сам.
const COMMIT_TIMEOUT_MS = 350

function waitForCommit(key) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      commitWaiters.delete(key)
      resolve()
    }, COMMIT_TIMEOUT_MS)
    commitWaiters.set(key, () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

export function createAppHistory() {
  const history = createBrowserHistory({ v5Compat: true })
  let current = history.location
  let active = null

  const listen = (fn) =>
    history.listen((update) => {
      const from = current
      current = update.location
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
      const transition = document.startViewTransition(() => {
        const committed = waitForCommit(update.location.key)
        fn(update)
        return committed
      })
      active = transition
      transition.finished.finally(() => {
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
