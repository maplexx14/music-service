import { heavyAnimationsHeld, onHeavyAnimationsHold } from './navigation'

// Чанки прогреваются по одному, когда первый экран уже получил время на
// загрузку. На медленном телефоне импорт — ещё и разбор/исполнение JS,
// поэтому не начинаем следующий во время свайпа или в скрытом приложении.
export function preloadInIdle(loaders, { delay = 800 } = {}) {
  const queue = [...loaders]
  let handle = null
  let loading = false
  let started = false
  let disposed = false
  const nativeIdle = typeof window.requestIdleCallback === 'function'
  const cancelPending = () => {
    if (handle === null) return
    if (nativeIdle) window.cancelIdleCallback(handle)
    else window.clearTimeout(handle)
    handle = null
  }
  const schedule = () => {
    if (disposed || !started || loading || handle !== null || !queue.length || document.hidden || heavyAnimationsHeld()) return
    const run = () => {
      handle = null
      if (disposed || document.hidden || heavyAnimationsHeld()) return
      loading = true
      const loader = queue.shift()
      Promise.resolve().then(() => { if (!disposed) return loader() }).catch(() => {}).finally(() => {
        loading = false
        schedule()
      })
    }
    handle = nativeIdle ? window.requestIdleCallback(run) : window.setTimeout(run, 200)
  }
  const onVisibility = () => {
    if (document.hidden) cancelPending()
    else schedule()
  }
  const offHold = onHeavyAnimationsHold((held) => {
    if (held) cancelPending()
    else schedule()
  })
  document.addEventListener('visibilitychange', onVisibility)
  const timer = window.setTimeout(() => {
    started = true
    schedule()
  }, delay)
  return () => {
    disposed = true
    queue.length = 0
    window.clearTimeout(timer)
    cancelPending()
    offHold()
    document.removeEventListener('visibilitychange', onVisibility)
  }
}
