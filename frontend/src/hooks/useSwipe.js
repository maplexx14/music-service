import { useRef } from 'react'

// Тач-жесты для управления интерфейсом (как в мобильных приложениях).
// Обработчики навешиваются через onTouch* — на десктопе (мышь) не срабатывают,
// поэтому кнопочное управление там остаётся основным.
//
// Возвращает пропсы { onTouchStart, onTouchMove, onTouchEnd }, которые нужно
// разложить на элемент: <div {...useSwipe({ onSwipeLeft, onSwipeRight })} />
//
// Ось жеста фиксируется по первому заметному сдвигу (>10px), чтобы диагональные
// движения не срабатывали одновременно и по горизонтали, и по вертикали.
export function useSwipe({
  onSwipeLeft,
  onSwipeRight,
  onSwipeUp,
  onSwipeDown,
  threshold = 50,
} = {}) {
  const gestureRef = useRef(null)

  const onTouchStart = (e) => {
    if (e.touches.length !== 1) {
      gestureRef.current = null
      return
    }
    const t = e.touches[0]
    gestureRef.current = { x: t.clientX, y: t.clientY, axis: null }
  }

  const onTouchMove = (e) => {
    const g = gestureRef.current
    if (!g) return
    const t = e.touches[0]
    const dx = t.clientX - g.x
    const dy = t.clientY - g.y
    if (!g.axis && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
      g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
    }
  }

  const onTouchEnd = (e) => {
    const g = gestureRef.current
    if (!g) return
    const t = e.changedTouches[0]
    const dx = t.clientX - g.x
    const dy = t.clientY - g.y
    gestureRef.current = null

    if (g.axis === 'x' && Math.abs(dx) >= threshold) {
      if (dx < 0) onSwipeLeft?.()
      else onSwipeRight?.()
    } else if (g.axis === 'y' && Math.abs(dy) >= threshold) {
      if (dy < 0) onSwipeUp?.()
      else onSwipeDown?.()
    }
  }

  return { onTouchStart, onTouchMove, onTouchEnd }
}
