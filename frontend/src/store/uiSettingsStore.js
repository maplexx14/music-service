import { create } from 'zustand'

const STORAGE_KEY = 'ui-settings'

const loadSettings = () => {
  if (typeof window === 'undefined') return { liteMode: false }
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return { liteMode: false }
    const parsed = JSON.parse(stored)
    return { liteMode: typeof parsed.liteMode === 'boolean' ? parsed.liteMode : false }
  } catch {
    return { liteMode: false }
  }
}

const applyLiteModeClass = (liteMode) => {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('lite-mode', liteMode)
}

const initialState = loadSettings()
applyLiteModeClass(initialState.liteMode)

const useUiSettingsStore = create((set) => ({
  ...initialState,
  setLiteMode: (liteMode) => set({ liteMode }),
  toggleLiteMode: () => set((state) => ({ liteMode: !state.liteMode })),
}))

if (typeof window !== 'undefined') {
  useUiSettingsStore.subscribe((state) => {
    applyLiteModeClass(state.liteMode)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ liteMode: state.liteMode }))
    } catch {
      // Ignore storage errors
    }
  })
}

export { useUiSettingsStore }
