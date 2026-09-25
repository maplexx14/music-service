import { useCallback, useEffect, useRef, useState } from 'react'

// Pull-to-refresh как в нативных приложениях: тянешь список вниз от самого
// верха — выезжает индикатор, отпускаешь — обновление. Работает ТОЛЬКО на
// таче; мышью на десктопе не активируется (там F5).
//
// Не перехватывает скролл у страницы: показывает индикатор на те пиксели,
// которые браузер и так отводит под «резинку» (overscroll). Контейнер
// страницы при этом должен иметь overscroll-behavior-y: contain, чтобы
// rubber-band не проваливался в системный pull-to-refresh Chrome.
//
// reachTop: () => boolean — «проскроллено в самый верх?». По умолчанию —
// документ-скролл; для вложенных скролл-контейнеров передайте свою проверку.
export function usePullToRefresh({ onRefresh, reachTop, maxPull = 90, threshold = 64 } = {}) {
  const [pull, setPull] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const gesture = useRef(null)
  // pull/refreshing/onRefresh читаются внутри жеста из ref-зеркал: эффект
  // ниже подписывается ОДИН раз, а не перевешивает window-слушатели на
  // каждый тик setPull (жест тикает до 60 раз/сек).
  const pullRef = useRef(0)
  const refreshingRef = useRef(false)
  const onRefreshRef = useRef(onRefresh)
  const reachTopRef = useRef(reachTop)
  onRefreshRef.current = onRefresh
  reachTopRef.current = reachTop

  const isAtTop = useCallback(
    () =>
      reachTopRef.current
        ? reachTopRef.current()
        : (window.scrollY || document.documentElement.scrollTop) <= 0,
    [],
  )

  useEffect(() => {
    const setPullSafe = (v) => {
      pullRef.current = v
      setPull(v)
    }
    const setRefreshingSafe = (v) => {
      refreshingRef.current = v
      setRefreshing(v)
    }

    const onStart = (e) => {
      if (e.touches.length !== 1 || refreshingRef.current || !isAtTop()) {
        gesture.current = null
        return
      }
      // Элементы-«крутилки» (диск на главной) помечены data-no-pull: жест,
      // начатый на них, — это поворот, а не потягивание списка. Без этой
      // проверки вращение диска вниз на самом верху страницы одновременно
      // дёргало бы обновление рекомендаций.
      if (e.target?.closest?.('[data-no-pull]')) {
        gesture.current = null
        return
      }
      const t = e.touches[0]
      gesture.current = { x: t.clientX, y: t.clientY, pulling: false }
    }

    const onMove = (e) => {
      const g = gesture.current
      if (!g || e.touches.length !== 1) return
      const dy = e.touches[0].clientY - g.y
      if (dy <= 0) {
        if (g.pulling) {
          g.pulling = false
          setPullSafe(0)
        }
        return
      }
      if (!g.pulling) {
        // Диагональный жест — это карусель/горизонтальный скролл, не наш.
        if (Math.abs(e.touches[0].clientX - g.x) > 24) {
          gesture.current = null
          return
        }
        g.pulling = true
      }
      // Прогрессия с затуханием, как системный rubber-band: 60px пальца
      // ≈ 30px индикатора. rAF батчит setPull до кадра.
      const eased = Math.min(maxPull, dy * 0.5)
      requestAnimationFrame(() => {
        if (gesture.current === g && g.pulling) setPullSafe(eased)
      })
    }

    const onEnd = () => {
      const g = gesture.current
      gesture.current = null
      if (!g) return
      if (pullRef.current >= threshold) {
        setPullSafe(0)
        setRefreshingSafe(true)
        Promise.resolve(onRefreshRef.current?.()).finally(() => setRefreshingSafe(false))
      } else {
        setPullSafe(0)
      }
    }

    window.addEventListener('touchstart', onStart, { passive: true })
    window.addEventListener('touchmove', onMove, { passive: true })
    window.addEventListener('touchend', onEnd, { passive: true })
    window.addEventListener('touchcancel', onEnd, { passive: true })
    return () => {
      window.removeEventListener('touchstart', onStart)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', onEnd)
    }
  }, [isAtTop, maxPull, threshold])

  return { pull, refreshing }
}
