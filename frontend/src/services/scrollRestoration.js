import { readUiSession, writeUiSession } from './uiSession'

export function scrollKey(location) {
  return location.pathname + (location.search || '') + (location.hash || '')
}

export function rememberScroll(location, top) {
  const key = scrollKey(location)
  const entryKey = `${key}:${location.key}`
  const stored = readUiSession('scroll-positions')
  const rows = Array.isArray(stored) ? stored.filter((row) => Array.isArray(row) && row[0] !== key && row[0] !== entryKey) : []
  // URL — для повторного запуска; ключ записи — для точного возврата назад.
  rows.push([key, top], [entryKey, top])
  writeUiSession('scroll-positions', rows.slice(-100))
}

export function savedScroll(location) {
  const rows = readUiSession('scroll-positions')
  if (!Array.isArray(rows)) return 0
  const find = (key) => rows.find((row) => Array.isArray(row) && row[0] === key)?.[1]
  const key = scrollKey(location)
  const top = find(`${key}:${location.key}`) ?? find(key)
  return Number.isFinite(top) && top > 0 ? top : 0
}

// Данные и обложки могут увеличить экран после первого кадра. Ждём роста
// через ResizeObserver, без работы на каждом кадре. Любой ручной жест отменяет
// восстановление, чтобы поздний ответ сети не перебил прокрутку пользователя.
export function restoreScrollPosition(el, target, onComplete = () => {}) {
  let stopped = false
  let observer
  let mutations
  let timer
  const stop = () => {
    if (stopped) return
    stopped = true
    observer?.disconnect()
    mutations?.disconnect()
    clearTimeout(timer)
    for (const name of ['touchstart', 'pointerdown', 'wheel', 'keydown']) el.removeEventListener(name, stop)
    onComplete()
  }
  const apply = () => {
    if (stopped) return
    el.scrollTop = target
    if (Math.abs(el.scrollTop - target) <= 1) stop()
  }
  for (const name of ['touchstart', 'pointerdown', 'wheel', 'keydown']) el.addEventListener(name, stop, { passive: true })
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(apply)
    observer.observe(el)
    for (const child of el.children) observer.observe(child)
  }
  if (typeof MutationObserver !== 'undefined') {
    mutations = new MutationObserver(() => {
      if (stopped) return
      // Suspense заменил спиннер содержимым: следим за новыми блоками.
      observer?.disconnect()
      observer?.observe(el)
      for (const child of el.children) observer?.observe(child)
      apply()
    })
    mutations.observe(el, { childList: true, subtree: true })
  }
  timer = setTimeout(stop, 10000)
  apply()
  return stop
}
