import { useEffect, useRef } from 'react'
import { afterNextRouteCommit, skipNextTransitionAnimation } from '../services/navigation'
import { haptic, HAPTIC } from '../utils/haptics'

// Навигация свайпами в PWA: вправо — «Назад» на вложенных экранах, влево/
// вправо — соседняя вкладка на корнях вкладок. Жест начинается из любой
// точки экрана, не только от края: прежний вариант (24 px от левой кромки)
// на устройстве почти не срабатывал — у самого края касание забирает
// система или чехол.
//
// Экран едет за пальцем; отпустили дальше трети ширины или быстрым броском —
// уезжает, и происходит переход, иначе возвращается на место. Новый экран
// доезжает с той стороны, откуда пришёл, без смены прозрачности: прежний
// доезд с opacity 0.4 выглядел как мигание страницы.
//
// Жест не начинается там, где горизонтальное движение уже занято: поля
// ввода, ползунки, горизонтально прокручиваемые ленты (карусели) и всё,
// что помечено data-swipe-ignore.

const AXIS_LOCK_PX = 10
// Горизонталь должна явно преобладать: косой жест при прокрутке списка не
// должен уводить экран вбок.
const AXIS_RATIO = 1.5
const COMMIT_FRACTION = 0.33
const FLING_VELOCITY = 0.5 // px/мс
// Сопротивление, когда в эту сторону идти некуда (первая/последняя вкладка).
const RESISTANCE = 0.2
const EXIT_MS = 240
const ENTER_MS = 260
const ENTER_SHIFT = 0.25
const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'
const IGNORE = 'input, textarea, select, [contenteditable="true"], [role="slider"], [data-swipe-ignore]'

// Есть ли между целью касания и контейнером горизонтально прокручиваемый
// элемент — такой жест принадлежит ему.
function insideHorizontalScroller(target, root) {
  for (let node = target; node && node !== root; node = node.parentElement) {
    if (node.scrollWidth > node.clientWidth + 1) {
      const { overflowX } = getComputedStyle(node)
      if (overflowX === 'auto' || overflowX === 'scroll') return true
    }
  }
  return false
}

export function useSwipeNavigation(scrollerRef, { enabled, onBack, onPrev, onNext }) {
  const actionsRef = useRef(null)
  // Свайп вправо: «Назад» на вложенном экране, предыдущая вкладка на корне.
  actionsRef.current = { right: onBack || onPrev || null, left: onNext || null }

  useEffect(() => {
    const el = scrollerRef.current
    if (!el || !enabled) return undefined

    let g = null
    let busy = false

    const setOffset = (x, animate) => {
      el.style.transition = animate ? `transform ${EXIT_MS}ms ${EASE}` : 'none'
      el.style.transform = x ? `translate3d(${x}px, 0, 0)` : ''
    }

    const reset = () => {
      el.style.transition = ''
      el.style.transform = ''
      el.style.willChange = ''
      el.style.overflowY = ''
    }

    const onStart = (e) => {
      if (busy || e.touches.length !== 1) {
        g = null
        return
      }
      const target = e.target instanceof Element ? e.target : null
      if (!target || target.closest(IGNORE) || insideHorizontalScroller(target, el)) return
      const t = e.touches[0]
      g = { x: t.clientX, y: t.clientY, dx: 0, axis: null, lastX: t.clientX, lastT: e.timeStamp, v: 0 }
    }

    const onMove = (e) => {
      if (!g) return
      if (e.touches.length !== 1) {
        g = null
        reset()
        return
      }
      const t = e.touches[0]
      const dx = t.clientX - g.x
      const dy = t.clientY - g.y
      if (!g.axis) {
        if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return
        if (Math.abs(dx) < Math.abs(dy) * AXIS_RATIO) {
          g = null
          return
        }
        g.axis = 'x'
        el.style.willChange = 'transform'
        // Горизонтальный жест забираем целиком: список под пальцем не должен
        // одновременно прокручиваться. Через overflow, а не preventDefault —
        // тот требует непассивного touchmove, и тогда КАЖДОЕ движение пальца
        // при обычной прокрутке ждало бы главный поток.
        el.style.overflowY = 'hidden'
      }
      const dt = Math.max(1, e.timeStamp - g.lastT)
      g.v = (t.clientX - g.lastX) / dt
      g.lastX = t.clientX
      g.lastT = e.timeStamp
      const action = dx > 0 ? actionsRef.current.right : actionsRef.current.left
      g.dx = action ? dx : dx * RESISTANCE
      setOffset(g.dx, false)
    }

    const onEnd = () => {
      if (!g) return
      const { axis, dx, v } = g
      g = null
      if (axis !== 'x') return
      const dir = dx > 0 ? 1 : -1
      const action = dir > 0 ? actionsRef.current.right : actionsRef.current.left
      const width = el.clientWidth || window.innerWidth
      const commit =
        action && (Math.abs(dx) > width * COMMIT_FRACTION || (v * dir > FLING_VELOCITY && Math.abs(dx) > 30))
      if (!commit) {
        setOffset(0, true)
        setTimeout(reset, EXIT_MS + 40)
        return
      }
      busy = true
      haptic(HAPTIC.selection)
      setOffset(dir * width, true)
      setTimeout(() => {
        // Экран уже увезён пальцем — штатная анимация перехода не нужна.
        // Сдвиг снимаем в коммите нового экрана, до его первого кадра.
        skipNextTransitionAnimation()
        let fallback = 0
        const cancel = afterNextRouteCommit(() => {
          clearTimeout(fallback)
          reset()
          busy = false
          el.animate(
            [{ transform: `translate3d(${-dir * ENTER_SHIFT * 100}%, 0, 0)` }, { transform: 'none' }],
            { duration: ENTER_MS, easing: EASE },
          )
        })
        fallback = setTimeout(() => {
          cancel()
          reset()
          busy = false
        }, 800)
        action()
      }, EXIT_MS)
    }

    // Касание отобрала система (входящий звонок, жест iOS) — возвращаем экран
    // на место, а не переходим.
    const onCancel = () => {
      if (!g) return
      const wasDragging = g.axis === 'x'
      g = null
      if (!wasDragging) return
      setOffset(0, true)
      setTimeout(reset, EXIT_MS + 40)
    }

    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: true })
    el.addEventListener('touchend', onEnd, { passive: true })
    el.addEventListener('touchcancel', onCancel, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onCancel)
      reset()
    }
  }, [scrollerRef, enabled])
}
