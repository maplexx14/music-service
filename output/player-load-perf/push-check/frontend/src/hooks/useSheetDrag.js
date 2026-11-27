import { useEffect } from 'react'
import { haptic, HAPTIC } from '../utils/haptics'

// Закрытие шторки свайпом вниз: дальше этого сдвига или резким броском.
const DISMISS_DISTANCE = 120
const DISMISS_VELOCITY = 0.6 // px/мс
const SHEET_QUERY = '(max-width: 768px)'

// Перетаскивание нижней шторки за палец, как у системных sheet'ов. Работает
// только в режиме шторки (телефон). Тянуть можно за любое место окна, кроме
// полей ввода; внутри списка (scrollSelector) — только когда он докручен до
// верха, иначе жест вниз — это прокрутка списка, а не закрытие.
// backdropAlpha — затемнение подложки из CSS: по мере сдвига оно гаснет.
// enabled — перевесить слушатели, когда шторка появилась в DOM.
//
// Слушатели нативные, а не onTouch*: React вешает touchmove пассивным, и
// preventDefault не остановил бы «резинку» списка под пальцем.
export function useSheetDrag(dialogRef, backdropRef, onDismiss, { scrollSelector, backdropAlpha, enabled = true }) {
  useEffect(() => {
    const sheet = dialogRef.current
    const backdrop = backdropRef.current
    if (!enabled || !sheet || !backdrop) return undefined
    let drag = null
    let closing = false

    const reset = (animate) => {
      sheet.style.transition = animate ? 'transform 220ms var(--ease-drawer)' : ''
      sheet.style.transform = ''
      backdrop.style.transition = animate ? 'background-color 220ms var(--ease-out)' : ''
      backdrop.style.backgroundColor = ''
    }

    const onStart = (e) => {
      if (closing || e.touches.length !== 1 || !window.matchMedia(SHEET_QUERY).matches) return
      if (e.target.closest('input, textarea')) return
      const list = scrollSelector ? e.target.closest(scrollSelector) : null
      if (list && list.scrollTop > 0) return
      const t = e.touches[0]
      drag = { x: t.clientX, y: t.clientY, dy: 0, active: false, samples: [] }
    }

    const onMove = (e) => {
      if (!drag) return
      const t = e.touches[0]
      const dx = t.clientX - drag.x
      const dy = t.clientY - drag.y
      if (!drag.active) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return
        // Вбок или вверх — не наш жест (вверх — прокрутка списка).
        if (Math.abs(dx) > Math.abs(dy) || dy < 0) {
          drag = null
          return
        }
        drag.active = true
        sheet.style.transition = 'none'
        backdrop.style.transition = 'none'
      }
      e.preventDefault()
      drag.dy = Math.max(0, dy)
      drag.samples.push({ y: t.clientY, at: e.timeStamp })
      if (drag.samples.length > 5) drag.samples.shift()
      sheet.style.transform = `translateY(${drag.dy}px)`
      // Гасим только затемнение: окно — потомок подложки, и opacity подложки
      // увела бы в прозрачность и его.
      const progress = Math.min(1, drag.dy / sheet.offsetHeight)
      backdrop.style.backgroundColor = `rgba(0, 0, 0, ${backdropAlpha * (1 - progress)})`
    }

    const onEnd = () => {
      const g = drag
      drag = null
      if (!g?.active) return
      const first = g.samples[0]
      const last = g.samples[g.samples.length - 1]
      const velocity = first && last && last.at > first.at ? (last.y - first.y) / (last.at - first.at) : 0
      if (g.dy > DISMISS_DISTANCE || velocity > DISMISS_VELOCITY) {
        closing = true
        haptic(HAPTIC.light)
        sheet.style.transition = 'transform 200ms var(--ease-out)'
        sheet.style.transform = 'translateY(100%)'
        backdrop.style.transition = 'background-color 200ms var(--ease-out)'
        backdrop.style.backgroundColor = 'rgba(0, 0, 0, 0)'
        // Таймер, а не transitionend: при выключенных анимациях события нет.
        setTimeout(onDismiss, 200)
      } else {
        reset(true)
      }
    }

    sheet.addEventListener('touchstart', onStart, { passive: true })
    sheet.addEventListener('touchmove', onMove, { passive: false })
    sheet.addEventListener('touchend', onEnd)
    sheet.addEventListener('touchcancel', onEnd)
    return () => {
      sheet.removeEventListener('touchstart', onStart)
      sheet.removeEventListener('touchmove', onMove)
      sheet.removeEventListener('touchend', onEnd)
      sheet.removeEventListener('touchcancel', onEnd)
    }
  }, [dialogRef, backdropRef, onDismiss, scrollSelector, backdropAlpha, enabled])
}
