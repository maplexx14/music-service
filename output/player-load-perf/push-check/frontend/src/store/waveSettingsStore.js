import { create } from 'zustand'

const DEFAULT_SETTINGS = {
  color: '#b14dff',
  animate: true,
  waveGif: null,
}

const loadSettings = () => {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS
  try {
    const stored = localStorage.getItem('wave-settings')
    if (!stored) return DEFAULT_SETTINGS
    const parsed = JSON.parse(stored)
    return {
      color: typeof parsed.color === 'string' ? parsed.color : DEFAULT_SETTINGS.color,
      animate: typeof parsed.animate === 'boolean' ? parsed.animate : DEFAULT_SETTINGS.animate,
      waveGif: typeof parsed.waveGif === 'string' ? parsed.waveGif : DEFAULT_SETTINGS.waveGif,
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

const useWaveSettingsStore = create((set) => ({
  ...loadSettings(),
  setColor: (color) => set({ color }),
  setAnimation: (animate) => set({ animate }),
  toggleAnimation: () => set((state) => ({ animate: !state.animate })),
  setWaveGif: (waveGif) => set({ waveGif }),
}))

if (typeof window !== 'undefined') {
  useWaveSettingsStore.subscribe((state) => {
    try {
      localStorage.setItem(
        'wave-settings',
        JSON.stringify({ color: state.color, animate: state.animate, waveGif: state.waveGif })
      )
    } catch {
      // Ignore storage errors
    }
  })
}

export { useWaveSettingsStore }
