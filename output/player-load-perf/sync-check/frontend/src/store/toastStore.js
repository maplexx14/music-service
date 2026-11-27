import { create } from 'zustand'

let nextId = 1
let hideTimer = null
let removeTimer = null

const LEAVE_MS = 180

const clearTimers = () => {
  clearTimeout(hideTimer)
  clearTimeout(removeTimer)
  hideTimer = null
  removeTimer = null
}

// На экране одновременно не больше одного уведомления: новое заменяет
// текущее, а не встаёт в стопку. Повтор того же текста не перезапускает
// анимацию — только продлевает показ.
const useToastStore = create((set, get) => ({
  toast: null,

  addToast: (message, type = 'info', duration = 4000) => {
    clearTimers()
    const current = get().toast
    const same = current && !current.leaving && current.message === message && current.type === type
    const id = same ? current.id : nextId++
    if (!same) set({ toast: { id, message, type } })
    if (duration > 0) {
      hideTimer = setTimeout(() => get().dismissToast(id), duration)
    }
    return id
  },

  // Плавное скрытие: сначала помечаем уходящим (CSS-анимация), затем убираем.
  dismissToast: (id) => {
    const current = get().toast
    if (!current || (id != null && current.id !== id) || current.leaving) return
    clearTimers()
    set({ toast: { ...current, leaving: true } })
    removeTimer = setTimeout(() => {
      if (get().toast?.id === current.id) set({ toast: null })
    }, LEAVE_MS)
  },
}))

export const toast = {
  success: (message) => useToastStore.getState().addToast(message, 'success'),
  error: (message) => useToastStore.getState().addToast(message, 'error'),
  info: (message) => useToastStore.getState().addToast(message, 'info'),
}

export { useToastStore }
