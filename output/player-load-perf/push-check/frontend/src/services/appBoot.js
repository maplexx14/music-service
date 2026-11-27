// Start the initial page and its renderer together, avoiding the waterfall
// main bundle -> Home -> CD renderer. Other entry points keep their own chunks.
export function preloadInitialScreen(pathname = window.location.pathname) {
  if (pathname === '/') {
    import('../pages/Home').catch(() => {})
    import('../utils/cdDeckScene').catch(() => {})
  } else if (pathname === '/onboarding/player') {
    import('../utils/cdDeckScene').catch(() => {})
  }
}

export function initialScreenReady(root) {
  const screen = root.querySelector('.screen[data-active] .screen-scroll') || root
  return Boolean(screen.firstElementChild) &&
    !screen.querySelector('.spinner-wrap--page, .cd-deck-loading')
}

export function finishAppBoot(root = document.getElementById('root')) {
  if (!root || !window.__bootSplashHide) return () => {}
  let finished = false
  let frame = 0
  let timeout = 0
  const finish = () => {
    if (finished) return
    finished = true
    observer.disconnect()
    window.cancelAnimationFrame(frame)
    window.clearTimeout(timeout)
    window.__bootSplashHide?.()
  }
  const check = () => {
    if (finished || frame || !initialScreenReady(root)) return
    // The scene schedules its first draw before its ready class commits.
    // Leave a paint between readiness and the splash fade.
    frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => {
        frame = 0
        if (initialScreenReady(root)) finish()
      })
    })
  }
  const observer = new MutationObserver(check)
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-active'] })
  // A failed or stalled request must still expose the app's retry/fallback UI.
  timeout = window.setTimeout(finish, 12000)
  check()
  return finish
}
