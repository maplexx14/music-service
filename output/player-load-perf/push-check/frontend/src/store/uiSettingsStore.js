import { create } from 'zustand'
import { isSoftwareRendering } from '../utils/gpu'
import { DEFAULT_CD_APPEARANCE, normalizeCdAppearance, restoreCdAppearance } from '../utils/cdPlayerAppearance'

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

// Все устройства по умолчанию запрашивают 128 kbps ('high'). Выбор пользователя
// хранится и переживает перезагрузку.
const defaultQualityMode = () => 'high'

// rememberPlayer — запоминать очередь и позицию между запусками
// (services/playerPersist). Включено по умолчанию; явный выбор сохраняется.
// brushIcons — иконки кистью логотипа (фильтр #brush-icon в index.html).
// По умолчанию обычные иконки; кисть включается в настройках.
// vinylDisc — оформление компакт-дисков на главной; имя ключа сохраняет
// совместимость с записанными настройками. Выключено — размытая обложка.
const defaultSettings = () => ({
  liteMode: false,
  liteModeOverride: null,
  streamQuality: defaultQualityMode(),
  rememberPlayer: true,
  brushIcons: false,
  vinylDisc: true,
  cdPlayerAppearance: { ...DEFAULT_CD_APPEARANCE },
})

const loadSettings = () => {
  const fallback = defaultSettings()
  if (typeof window === 'undefined') return fallback
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return fallback
    const parsed = JSON.parse(stored)
    const liteModeOverride = typeof parsed.liteModeOverride === 'boolean'
      ? parsed.liteModeOverride
      : parsed.liteMode === true ? true : null
    return {
      liteMode: typeof parsed.liteMode === 'boolean' ? parsed.liteMode : false,
      liteModeOverride,
      // Незнакомое значение (старая версия, правка вручную) не должно ломать
      // решение о качестве — откатываемся к умолчанию для этого устройства.
      streamQuality: QUALITY_MODES.includes(parsed.streamQuality)
        ? parsed.streamQuality
        : fallback.streamQuality,
      rememberPlayer: typeof parsed.rememberPlayer === 'boolean' ? parsed.rememberPlayer : fallback.rememberPlayer,
      brushIcons: typeof parsed.brushIcons === 'boolean' ? parsed.brushIcons : fallback.brushIcons,
      vinylDisc: typeof parsed.vinylDisc === 'boolean' ? parsed.vinylDisc : fallback.vinylDisc,
      cdPlayerAppearance: restoreCdAppearance(parsed.cdPlayerAppearance, parsed.cdPlayerAppearanceVersion),
    }
  } catch {
    return fallback
  }
}

const applyLiteModeClass = (liteMode) => {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('lite-mode', liteMode)
}

const applyBrushIconsClass = (brushIcons) => {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('brush-icons', brushIcons)
}

const { liteModeOverride, ...storedState } = loadSettings()
const liteModeAuto = typeof window !== 'undefined' && isSoftwareRendering()
const initialState = {
  ...storedState,
  liteModePreference: liteModeOverride,
  liteModeAuto,
  liteMode: liteModeOverride ?? liteModeAuto,
}
applyLiteModeClass(initialState.liteMode)
applyBrushIconsClass(initialState.brushIcons)

const useUiSettingsStore = create((set) => ({
  ...initialState,
  setLiteMode: (liteMode) => set({
    liteModePreference: liteMode,
    liteMode,
  }),
  toggleLiteMode: () => set((state) => ({
    liteModePreference: !state.liteMode,
    liteMode: !state.liteMode,
  })),
  setStreamQuality: (streamQuality) => {
    if (!QUALITY_MODES.includes(streamQuality)) return
    set({ streamQuality })
  },
  toggleRememberPlayer: () => set((state) => ({ rememberPlayer: !state.rememberPlayer })),
  toggleBrushIcons: () => set((state) => ({ brushIcons: !state.brushIcons })),
  toggleVinylDisc: () => set((state) => ({ vinylDisc: !state.vinylDisc })),
  setCdPlayerAppearance: (patch) => set((state) => ({
    cdPlayerAppearance: normalizeCdAppearance({ ...state.cdPlayerAppearance, ...patch }),
  })),
  resetCdPlayerAppearance: () => set({ cdPlayerAppearance: { ...DEFAULT_CD_APPEARANCE } }),
}))

if (typeof window !== 'undefined') {
  useUiSettingsStore.subscribe((state) => {
    applyLiteModeClass(state.liteMode)
    applyBrushIconsClass(state.brushIcons)
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          liteMode: state.liteModePreference ?? false,
          liteModeOverride: state.liteModePreference,
          streamQuality: state.streamQuality,
          rememberPlayer: state.rememberPlayer,
          brushIcons: state.brushIcons,
          vinylDisc: state.vinylDisc,
          cdPlayerAppearance: state.cdPlayerAppearance,
          cdPlayerAppearanceVersion: 3,
        })
      )
    } catch {
      // Ignore storage errors
    }
  })
}

export { useUiSettingsStore }
