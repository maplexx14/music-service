import { useRef } from 'react'
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react'
import { useToastStore } from '../store/toastStore'
import './Toast.css'

const icons = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
}

// Смахивание: на мобильных уведомление сверху — уводим вверх, на десктопе
// оно снизу — уводим вниз.
const SWIPE_DISMISS_PX = 36
const isTopPlacement = () => window.matchMedia?.('(max-width: 768px)')?.matches ?? false

function ToastContainer() {
  const toast = useToastStore((s) => s.toast)
  const dismissToast = useToastStore((s) => s.dismissToast)
  const swipeRef = useRef(null)

  if (!toast) return null

  const Icon = icons[toast.type] || Info

  const onPointerDown = (e) => {
    if (e.button > 0 || e.target.closest('.toast-close')) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    swipeRef.current = { id: e.pointerId, y: e.clientY, dir: isTopPlacement() ? -1 : 1, dy: 0 }
    e.currentTarget.style.transition = 'none'
  }

  const onPointerMove = (e) => {
    const swipe = swipeRef.current
    if (!swipe || swipe.id !== e.pointerId) return
    const raw = e.clientY - swipe.y
    // В сторону закрытия — за пальцем, в обратную — с сильным сопротивлением.
    swipe.dy = raw * swipe.dir > 0 ? raw : raw * 0.2
    e.currentTarget.style.transform = `translateY(${swipe.dy}px)`
  }

  const onPointerEnd = (e) => {
    const swipe = swipeRef.current
    if (!swipe || swipe.id !== e.pointerId) return
    swipeRef.current = null
    const el = e.currentTarget
    el.style.transition = ''
    if (swipe.dy * swipe.dir > SWIPE_DISMISS_PX) {
      el.style.transform = `translateY(${swipe.dir * 120}%)`
      dismissToast(toast.id)
    } else {
      el.style.transform = ''
    }
  }

  return (
    <div className="toast-container" role="status" aria-live="polite">
      {/* key: новое уведомление монтируется заново и проигрывает вход. */}
      <div
        key={toast.id}
        className={`toast toast-${toast.type}${toast.leaving ? ' toast-leaving' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        <span className="toast-icon" aria-hidden="true">
          <Icon size={18} strokeWidth={2.25} />
        </span>
        <span className="toast-message">{toast.message}</span>
        <button
          type="button"
          className="toast-close"
          onClick={() => dismissToast(toast.id)}
          aria-label="Закрыть уведомление"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  )
}

export default ToastContainer
