import { useEffect, useLayoutEffect, useRef } from 'react'
import { usePlayerStore } from '../store/playerStore'
import { haptic, HAPTIC } from '../utils/haptics'
import { settleStrip } from '../utils/settleStrip'
import { holdHeavyAnimations } from '../services/navigation'

// Скорость отпускания считаем по последним ~80 мс касания, а не по всему
// жесту: медленно тянул, а в конце швырнул — это флик.
const VELOCITY_WINDOW_MS = 80

// Горизонтальная карусель треков мини-плеера — тот же жест, что у обложки
// в полноэкранном плеере: полоса едет за пальцем, соседи видны по краям,
// переключает либо протяжка дальше порога, либо быстрый флик; без соседа в
// эту сторону — сопротивление и возврат. После смены трека (свайпом или
// кнопкой) новая текущая доезжает на место с той точки, где была на экране.
//
// Полосу двигаем через style, без стейта: setState на каждый touchmove
// перерисовывал бы весь плеер каждый кадр жеста.
//
// Плавность. Пока полоса едет (палец и доезд), WebGL-фон главной на паузе
// (holdHeavyAnimations): горизонталь ведёт JS, и каждый кадр WebGL отнимал у
// неё главный поток — капсула шла рывками. Фуллскрин держит ту же паузу всё
// время, пока открыт. Доезд продолжает скорость пальца (см. settleStrip).
//
// Возвращает тач-обработчики для области жеста и swipedRef — true сразу
// после свайпа, чтобы тап-обработчик не принял конец жеста за нажатие.
// enabled=false (десктоп) — ни жеста, ни доезда при переключении кнопками.
// Жест не начинается на элементах из ignore (перемотка и т.п.).
export function useTrackCarousel({
  enabled = true,
  ignore = '[role="slider"]',
  stripRef,
  gap,
  currentId,
  prevId,
  nextId,
  canPrev,
  canNext,
  onPrev,
  onNext,
}) {
  const gestureRef = useRef(null)
  // Смещение и скорость полосы в момент, когда свайп переключил трек: с них
  // новая текущая доезжает на место (см. эффект на смену трека).
  const swipeRef = useRef(null)
  const lastRef = useRef(null)
  const swipedRef = useRef(false)
  const motionRef = useRef({ release: null, timer: 0 })

  // Полоса начала двигаться: слой на композитор, тяжёлый декор на паузу.
  const beginMotion = (strip) => {
    const m = motionRef.current
    clearTimeout(m.timer)
    if (!m.release) m.release = holdHeavyAnimations()
    strip.style.willChange = 'transform'
  }

  // Доезд запущен на duration мс — по его окончании всё отпускаем.
  const endMotion = (strip, duration) => {
    const m = motionRef.current
    clearTimeout(m.timer)
    m.timer = setTimeout(() => {
      if (strip) strip.style.willChange = ''
      m.release?.()
      m.release = null
    }, duration + 50)
  }

  const settle = (strip, from, velocity) => {
    beginMotion(strip)
    endMotion(strip, settleStrip(strip, from, { velocity }))
  }

  useEffect(() => () => {
    clearTimeout(motionRef.current.timer)
    motionRef.current.release?.()
  }, [])

  useLayoutEffect(() => {
    const strip = stripRef.current
    const last = lastRef.current
    const swipe = swipeRef.current
    swipeRef.current = null
    if (!enabled || !strip || !last || last.id === currentId) return
    const dir = currentId === last.nextId ? 1 : currentId === last.prevId ? -1 : 0
    if (!dir) {
      settleStrip(strip, 0)
      return
    }
    settle(strip, (swipe?.dx || 0) + dir * (strip.offsetWidth + gap), swipe?.velocity)
  }, [currentId])

  // Соседи на момент последнего рендера — по ним эффект выше узнаёт
  // направление. Идёт после него: тот читает ещё прошлые значения.
  useLayoutEffect(() => {
    lastRef.current = { id: currentId, prevId, nextId }
  })

  const onTouchStart = (e) => {
    swipedRef.current = false
    if (!enabled || e.touches.length !== 1 || e.target.closest?.(ignore)) {
      gestureRef.current = null
      return
    }
    const t = e.touches[0]
    const now = performance.now()
    gestureRef.current = {
      x: t.clientX,
      y: t.clientY,
      axis: null,
      dx: 0,
      t0: now,
      samples: [{ t: now, x: t.clientX }],
    }
  }

  const onTouchMove = (e) => {
    const g = gestureRef.current
    if (!g) return
    const t = e.touches[0]
    const dx = t.clientX - g.x
    const dy = t.clientY - g.y
    if (!g.axis && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
      g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
      if (g.axis === 'x' && stripRef.current) beginMotion(stripRef.current)
    }
    if (g.axis !== 'x') return
    const now = performance.now()
    g.samples.push({ t: now, x: t.clientX })
    while (g.samples.length > 2 && now - g.samples[0].t > VELOCITY_WINDOW_MS) g.samples.shift()
    const strip = stripRef.current
    if (strip) {
      const x = (dx < 0 ? canNext : canPrev) ? dx : dx * 0.3
      strip.style.transition = 'none'
      strip.style.transform = `translateX(${x}px)`
      g.dx = x
    }
  }

  // px/мс со знаком; без соседа — с тем же сопротивлением, что и сдвиг.
  const releaseVelocity = (g, x, now) => {
    const first = g.samples[0]
    const dt = now - first.t
    return dt > 0 ? (x - first.x) / dt : 0
  }

  const onTouchEnd = (e) => {
    const g = gestureRef.current
    if (!g) return
    gestureRef.current = null
    if (g.axis) swipedRef.current = true
    if (g.axis !== 'x') return
    const strip = stripRef.current
    const clientX = e.changedTouches[0].clientX
    const now = performance.now()
    const dx = clientX - g.x
    const velocity = releaseVelocity(g, clientX, now)
    const allowed = dx < 0 ? canNext : canPrev
    // Флик — быстрое движение в ту же сторону, куда тянули.
    const fast = Math.abs(dx) > 30 && Math.abs(velocity) > 0.5 && Math.sign(velocity) === Math.sign(dx)
    if (!allowed || (Math.abs(dx) < 60 && !fast)) {
      if (strip) settle(strip, g.dx, allowed ? velocity : velocity * 0.3)
      return
    }
    haptic(HAPTIC.selection)
    const fromId = usePlayerStore.getState().currentTrack?.id
    swipeRef.current = { dx: g.dx, velocity }
    if (dx < 0) onNext()
    else onPrev()
    // Переход могли отложить (следующий трек ещё грузится) — тогда
    // полоса возвращается на место.
    if (usePlayerStore.getState().currentTrack?.id === fromId) {
      swipeRef.current = null
      if (strip) settle(strip, g.dx, velocity)
    }
  }

  const onTouchCancel = () => {
    const g = gestureRef.current
    gestureRef.current = null
    if (g?.axis === 'x' && stripRef.current) settle(stripRef.current, g.dx)
  }

  return { handlers: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel }, swipedRef }
}
