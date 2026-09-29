import { useEffect, useRef } from 'react'
import { afterNextRouteCommit, skipNextTransitionAnimation } from '../services/navigation'
import { haptic, HAPTIC } from '../utils/haptics'

// Свайп от левого края — «Назад», как в любом iOS-приложении. PWA с
// домашнего экрана этого жеста лишена (в Safari его даёт браузер, на
// Android — система), поэтому включается только там, где его нет.
//
// Экран едет за пальцем; отпустили дальше трети ширины или быстрым
// броском — уезжает вправо и история шагает назад, иначе возвращается.

const EDGE_PX = 24
const AXIS_LOCK_PX = 8
const COMMIT_FRACTION = 0.33
const FLING_VELOCITY = 0.5 // px/мс
const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'

export function useEdgeSwipeBack(scrollerRef, { enabled, onBack }) {
  const onBackRef = useRef(onBack)
  onBackRef.current = onBack

  useEffect(() => {
    const el = scrollerRef.current
    if (!el || !enabled) return undefined

    let g = null

    const setOffset = (x, animate) => {
      el.style.transition = animate ? `transform 280ms ${EASE}, box-shadow 280ms ${EASE}` : 'none'
      el.style.transform = x > 0 ? `translate3d(${x}px, 0, 0)` : ''
      el.style.boxShadow = x > 0 ? '-12px 0 32px rgba(0, 0, 0, 0.55)' : ''
    }

    const reset = () => {
      el.style.transition = ''
      el.style.transform = ''
      el.style.boxShadow = ''
      el.style.willChange = ''
    }

    const onStart = (e) => {
      if (e.touches.length !== 1) return
      const t = e.touches[0]
      if (t.clientX > EDGE_PX) return
      g = { x: t.clientX, y: t.clientY, dx: 0, axis: null, lastX: t.clientX, lastT: e.timeStamp, v: 0 }
    }

    const onMove = (e) => {
      if (!g) return
      const t = e.touches[0]
      const dx = t.clientX - g.x
      const dy = t.clientY - g.y
      if (!g.axis) {
        if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) {
          // iOS решает «это скролл» по первому непогашенному touchmove и
          // потом отменить его уже не даёт — горизонтальное начало гасим
          // сразу, до фиксации оси.
          if (dx > Math.abs(dy) && e.cancelable) e.preventDefault()
          return
        }
        g.axis = dx > Math.abs(dy) ? 'x' : 'y'
        if (g.axis === 'y') {
          g = null
          return
        }
        el.style.willChange = 'transform'
      }
      // Горизонтальный жест забираем целиком: список под пальцем не должен
      // одновременно прокручиваться.
      if (e.cancelable) e.preventDefault()
      const dt = Math.max(1, e.timeStamp - g.lastT)
      g.v = (t.clientX - g.lastX) / dt
      g.lastX = t.clientX
      g.lastT = e.timeStamp
      g.dx = Math.max(0, dx)
      setOffset(g.dx, false)
    }

    const onEnd = () => {
      if (!g) return
      const { axis, dx, v } = g
      g = null
      if (axis !== 'x') return
      const width = el.clientWidth || window.innerWidth
      const commit = dx > width * COMMIT_FRACTION || (v > FLING_VELOCITY && dx > 30)
      if (!commit) {
        setOffset(0, true)
        setTimeout(reset, 300)
        return
      }
      haptic(HAPTIC.selection)
      setOffset(width, true)
      setTimeout(() => {
        // Экран уже увезён пальцем — анимация перехода не нужна. Сдвиг
        // снимаем в коммите нового экрана, до его первого кадра, и тот
        // проявляется с лёгким доездом слева, как предыдущий экран стека.
        skipNextTransitionAnimation()
        let fallback = 0
        const cancel = afterNextRouteCommit(() => {
          clearTimeout(fallback)
          reset()
          el.animate(
            [
              { opacity: 0.4, transform: 'translate3d(-18%, 0, 0)' },
              { opacity: 1, transform: 'none' },
            ],
            { duration: 260, easing: EASE },
          )
        })
        fallback = setTimeout(() => {
          cancel()
          reset()
        }, 800)
        onBackRef.current()
      }, 260)
    }

    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd, { passive: true })
    el.addEventListener('touchcancel', onEnd, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
      reset()
    }
  }, [scrollerRef, enabled])
}
