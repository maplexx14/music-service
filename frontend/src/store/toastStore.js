import { create } from 'zustand'

let nextId = 1

const useToastStore = create((set) => ({
  toasts: [],

  addToast: (message, type = 'info', duration = 4000) => {
    const id = nextId++
    set((state) => ({ toasts: [...state.toasts, { id, message, type }] }))
    if (duration > 0) {
      setTimeout(() => {
        useToastStore.getState().dismissToast(id)
      }, duration)
    }
    return id
  },

  // Плавное скрытие: сначала помечаем toast как уходящий (CSS-анимация),
  // затем удаляем из списка.
  dismissToast: (id) => {
    set((state) => ({
      toasts: state.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)),
    }))
    setTimeout(() => {
      useToastStore.getState().removeToast(id)
    }, 180)
  },

  removeToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}))

export const toast = {
  success: (message) => useToastStore.getState().addToast(message, 'success'),
  error: (message) => useToastStore.getState().addToast(message, 'error'),
  info: (message) => useToastStore.getState().addToast(message, 'info'),
}

export { useToastStore }
