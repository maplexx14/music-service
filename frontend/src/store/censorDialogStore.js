import { create } from 'zustand'

// Окно «Оригинал без цензуры» (только для админов) — одно на приложение, его
// рисует Layout, открывает контекстное меню трека. См. app/censorship.py.
const useCensorDialogStore = create((set) => ({
  track: null,
  open: (track) => set({ track }),
  close: () => set({ track: null }),
}))

export const openCensorDialog = (track) => useCensorDialogStore.getState().open(track)

export { useCensorDialogStore }
