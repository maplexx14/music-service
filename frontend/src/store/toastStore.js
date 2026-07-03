import { create } from 'zustand'

let nextId = 1

const useToastStore = create((set) => ({
  toasts: [],

  addToast: (message, type = 'info', duration = 4000) => {
    const id = nextId++
    set((state) => ({ toasts: [...state.toasts, { id, message, type }] }))
    if (duration > 0) {
      setTimeout(() => {
        useToastStore.getState().removeToast(id)
      }, duration)
    }
    return id
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
