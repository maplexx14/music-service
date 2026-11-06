import { readUiSession, writeUiSession } from './uiSession'

const restorations = new WeakMap()

// Явное «наверх» в таб-баре тоже отменяет ожидание данных: касание панели
// находится вне контейнера и не попадает в его pointerdown-слушатель.
export function cancelScrollRestoration(el) {
  restorations.get(el)?.()
}

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
export function restoreScrollPosition(el, target, onComplete = () => {}, { timeoutMs = 10000 } = {}) {
  cancelScrollRestoration(el)
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
    document.removeEventListener('visibilitychange', onVisibility)
    if (restorations.get(el) === stop) restorations.delete(el)
    for (const name of ['touchstart', 'pointerdown', 'wheel', 'keydown']) el.removeEventListener(name, stop)
    onComplete()
  }
  const apply = () => {
    if (stopped) return
    el.scrollTop = target
    if (Math.abs(el.scrollTop - target) <= 1) stop()
  }
  const startTimer = () => {
    clearTimeout(timer)
    if (timeoutMs > 0 && !document.hidden) timer = setTimeout(stop, timeoutMs)
  }
  const onVisibility = () => {
    startTimer()
    if (!document.hidden) apply()
  }
  restorations.set(el, stop)
  document.addEventListener('visibilitychange', onVisibility)
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
  // У прогретой скрытой вкладки данные ещё могут заменить спиннер, но
  // пагинация включится только при открытии. Наблюдаем рост без дедлайна;
  // активный экран запускает обычное ограниченное ожидание.
  startTimer()
  apply()
  return stop
}
