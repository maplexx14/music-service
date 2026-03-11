import { create } from 'zustand'

const STORAGE_KEY = 'app-theme-settings'

const DEFAULT_ACCENT = '#8f00ff'

const loadStored = () => {
  if (typeof window === 'undefined') {
    return { theme: 'dark', accentColor: DEFAULT_ACCENT }
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { theme: 'dark', accentColor: DEFAULT_ACCENT }
    const parsed = JSON.parse(raw)
    const theme = parsed.theme === 'light' ? 'light' : 'dark'
    const accentColor =
      typeof parsed.accentColor === 'string' && /^#[0-9A-Fa-f]{6}$/.test(parsed.accentColor)
        ? parsed.accentColor
        : DEFAULT_ACCENT
    return { theme, accentColor }
  } catch {
    return { theme: 'dark', accentColor: DEFAULT_ACCENT }
  }
}

const applyToDocument = (theme, accentColor) => {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.setAttribute('data-theme', theme)
  root.style.setProperty('--accent-base', accentColor)
}

const initialState = loadStored()
applyToDocument(initialState.theme, initialState.accentColor)

const useThemeStore = create((set) => ({
  theme: initialState.theme,
  accentColor: initialState.accentColor,
  setTheme: (theme) =>
    set((state) => {
      const next = theme === 'light' ? 'light' : 'dark'
      applyToDocument(next, state.accentColor)
      return { theme: next }
    }),
  setAccentColor: (accentColor) =>
    set((state) => {
      const next = /^#[0-9A-Fa-f]{6}$/.test(accentColor) ? accentColor : state.accentColor
      applyToDocument(state.theme, next)
      return { accentColor: next }
    }),
}))

if (typeof window !== 'undefined') {
  useThemeStore.subscribe((state) => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ theme: state.theme, accentColor: state.accentColor })
      )
    } catch {
      // ignore
    }
  })
}

export { useThemeStore }
