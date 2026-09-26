import { create } from 'zustand'

const STORAGE_KEY = 'ui-settings'

// Режим качества потока: 'auto' — решение по каналу (utils/streamQuality),
// 'low'/'high' — явный выбор пользователя, который измерения не перебивают.
const QUALITY_MODES = ['auto', 'low', 'high']

// Мобильное устройство определяем по указателю, а не по ширине окна: телефон в
// альбомной ориентации шире 768px и по ширине сошёл бы за десктоп. Грубый
// указатель вместе с тачпоинтами — это ровно «телефон или планшет», iPad тоже.
const isMobileDevice = () => {
  if (typeof window === 'undefined') return false
  try {
    if (window.matchMedia?.('(pointer: coarse)')?.matches) {
      return (navigator.maxTouchPoints ?? 0) > 0
    }
    return window.innerWidth <= 768
  } catch {
    return false
  }
}

// На мобильных по умолчанию 64 kbps: канал там чаще узкий, а HE-AAC на этом
// битрейте на слух почти не отличается. Выбор пользователя хранится и
// переживает перезагрузку.
const defaultQualityMode = () => (isMobileDevice() ? 'low' : 'auto')

const defaultSettings = () => ({ liteMode: false, streamQuality: defaultQualityMode() })

const loadSettings = () => {
  const fallback = defaultSettings()
  if (typeof window === 'undefined') return fallback
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return fallback
    const parsed = JSON.parse(stored)
    return {
      liteMode: typeof parsed.liteMode === 'boolean' ? parsed.liteMode : false,
      // Незнакомое значение (старая версия, правка вручную) не должно ломать
      // решение о качестве — откатываемся к умолчанию для этого устройства.
      streamQuality: QUALITY_MODES.includes(parsed.streamQuality)
        ? parsed.streamQuality
        : fallback.streamQuality,
    }
  } catch {
    return fallback
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
  setStreamQuality: (streamQuality) => {
    if (!QUALITY_MODES.includes(streamQuality)) return
    set({ streamQuality })
  },
}))

if (typeof window !== 'undefined') {
  useUiSettingsStore.subscribe((state) => {
    applyLiteModeClass(state.liteMode)
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ liteMode: state.liteMode, streamQuality: state.streamQuality })
      )
    } catch {
      // Ignore storage errors
    }
  })
}

export { useUiSettingsStore }
