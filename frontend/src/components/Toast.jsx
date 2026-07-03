import { CheckCircle, AlertCircle, Info, X } from 'lucide-react'
import { useToastStore } from '../store/toastStore'
import './Toast.css'

const icons = {
  success: CheckCircle,
  error: AlertCircle,
  info: Info,
}

function ToastContainer() {
  const { toasts, removeToast } = useToastStore()

  if (toasts.length === 0) return null

  return (
    <div className="toast-container" role="status" aria-live="polite">
      {toasts.map((t) => {
        const Icon = icons[t.type] || Info
        return (
          <div key={t.id} className={`toast toast-${t.type}`}>
            <Icon size={18} className="toast-icon" />
            <span className="toast-message">{t.message}</span>
            <button
              type="button"
              className="toast-close"
              onClick={() => removeToast(t.id)}
              aria-label="Закрыть"
            >
              <X size={16} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

export default ToastContainer
