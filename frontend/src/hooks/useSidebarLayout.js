import { useCallback, useSyncExternalStore } from 'react'

// На вертикальном мониторе оставляем больше ширины содержимому.
const PORTRAIT_QUERY = '(min-width: 769px) and (max-width: 1600px) and (orientation: portrait)'
const DESKTOP_KEY = 'sidebar-collapsed'
const PORTRAIT_KEY = 'sidebar-collapsed-portrait'
const memoryPreferences = new Map()

function getSnapshot() {
  const portrait = window.matchMedia(PORTRAIT_QUERY).matches
  const key = portrait ? PORTRAIT_KEY : DESKTOP_KEY
  let saved
  try {
    saved = localStorage.getItem(key)
  } catch {
    // Выбор работает и при недоступном localStorage.
    saved = memoryPreferences.get(key)
  }
  const collapsed = saved === 'true' || (saved !== 'false' && portrait)
  return `${portrait ? 'portrait' : 'desktop'}:${collapsed ? 'collapsed' : 'expanded'}`
}

function subscribe(onChange) {
  const media = window.matchMedia(PORTRAIT_QUERY)
  media.addEventListener('change', onChange)
  window.addEventListener('storage', onChange)
  window.addEventListener('sidebarToggle', onChange)
  return () => {
    media.removeEventListener('change', onChange)
    window.removeEventListener('storage', onChange)
    window.removeEventListener('sidebarToggle', onChange)
  }
}

export function useSidebarLayout() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => 'desktop:expanded')
  const [mode, state] = snapshot.split(':')
  const isCollapsed = state === 'collapsed'
  const toggleCollapse = useCallback(() => {
    const key = mode === 'portrait' ? PORTRAIT_KEY : DESKTOP_KEY
    const value = String(!isCollapsed)
    memoryPreferences.set(key, value)
    try {
      localStorage.setItem(key, value)
    } catch {
      // Сохраняем выбор в памяти до закрытия приложения.
    }
    window.dispatchEvent(new Event('sidebarToggle'))
  }, [mode, isCollapsed])

  return { isCollapsed, sidebarWidth: isCollapsed ? 88 : 240, toggleCollapse }
}
