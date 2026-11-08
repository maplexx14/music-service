import { useEffect } from 'react'
import { preloadCover } from '../utils/media'
import { preloadInIdle } from '../services/preloadQueue'

// Give the main artwork priority, then warm only the next track in idle time.
// Idle preloading also pauses while swiping or when the app is backgrounded.
export function useWarmNextDiscCover(arcRef, currentUrl, nextUrl, enabled) {
  useEffect(() => {
    const connection = navigator.connection
    if (!enabled || !currentUrl || !nextUrl || currentUrl === nextUrl ||
        connection?.saveData || ['slow-2g', '2g'].includes(connection?.effectiveType)) return undefined
    const arc = arcRef.current
    if (!arc) return undefined
    let stopPreload = null
    const schedule = () => {
      const main = arc.querySelector('.flow-disc-slot.is-current .hero-disc')
      if (stopPreload || !main?.hasAttribute('data-full-cover-settled')) return
      stopPreload = preloadInIdle([
        () => preloadCover(nextUrl, 10000, { priority: 'low' }),
      ], { delay: 0 })
    }
    const observer = new MutationObserver(schedule)
    observer.observe(arc, {
      attributes: true, childList: true, subtree: true,
      attributeFilter: ['data-full-cover-settled'],
    })
    schedule()
    return () => {
      observer.disconnect()
      stopPreload?.()
    }
  }, [arcRef, currentUrl, nextUrl, enabled])
}
