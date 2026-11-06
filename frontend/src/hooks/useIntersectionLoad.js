import { useEffect, useRef } from 'react'
import { useScreen } from './useScreen'
import { heavyAnimationsHeld, onHeavyAnimationsHold } from '../services/navigation'

// Общая граница для сетевой и локальной догрузки. IntersectionObserver
// считает visibility:hidden видимым пересечением: сохранённая прокрутка
// фоновой вкладки иначе запускала запросы и монтаж карточек во время свайпа.
export function useIntersectionLoad(sentinel, onIntersect, { enabled = true, rootRef, rootMargin = '400px', revision } = {}) {
  const { active, scrollerRef } = useScreen()
  const handlerRef = useRef(onIntersect)
  const enabledRef = useRef(active && enabled)
  useEffect(() => {
    handlerRef.current = onIntersect
    enabledRef.current = active && enabled
  })

  const scrollRoot = rootRef ?? scrollerRef
  useEffect(() => {
    if (!sentinel || !active || !enabled) return undefined
    let observer = null
    let intersecting = false
    let delivered = false
    let disposed = false
    const load = () => {
      if (disposed || delivered || !intersecting || !enabledRef.current || document.hidden || heavyAnimationsHeld()) return
      delivered = true
      handlerRef.current()
    }
    const observe = () => {
      if (disposed || document.hidden) return
      const current = new IntersectionObserver((entries) => {
        if (disposed || document.hidden || observer !== current) return
        intersecting = entries.some((entry) => entry.isIntersecting)
        if (!intersecting) delivered = false
        load()
      }, { root: scrollRoot?.current ?? null, rootMargin })
      observer = current
      observer.observe(sentinel)
    }
    const onVisibility = () => {
      observer?.disconnect()
      observer = null
      intersecting = false
      observe()
    }
    const offHold = onHeavyAnimationsHold((held) => { if (!held) load() })
    document.addEventListener('visibilitychange', onVisibility)
    observe()
    return () => {
      disposed = true
      observer?.disconnect()
      offHold()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [sentinel, active, enabled, scrollRoot, rootMargin, revision])
}
