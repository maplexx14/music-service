import { create } from 'zustand'

const usePlayerStore = create((set, get) => ({
  currentTrack: null,
  queue: [],
  currentIndex: -1,
  isPlaying: false,
  source: null,
  volume: 1,
  currentTime: 0,
  duration: 0,
  isFullScreen: false,
  
  setCurrentTrack: (track) => {
    set({ currentTrack: track, currentTime: 0 })
  },
  
  playTrack: (track, queue = [], source = null) => {
    const trackIndex = queue.findIndex(t => t.id === track.id)
    set({
      currentTrack: track,
      queue: queue.length > 0 ? queue : [track],
      currentIndex: trackIndex >= 0 ? trackIndex : 0,
      isPlaying: true,
      source,
    })
  },
  
  playPlaylist: (tracks, startIndex = 0, source = null) => {
    if (tracks.length === 0) return
    set({
      currentTrack: tracks[startIndex],
      queue: tracks,
      currentIndex: startIndex,
      isPlaying: true,
      source,
    })
  },
  
  togglePlayPause: () => {
    set((state) => ({ isPlaying: !state.isPlaying }))
  },

  openFullScreen: () => {
    set({ isFullScreen: true })
  },

  closeFullScreen: () => {
    set({ isFullScreen: false })
  },
  
  nextTrack: () => {
    const { queue, currentIndex, source } = get()
    if (currentIndex < queue.length - 1) {
      const nextIndex = currentIndex + 1
      set({
        currentTrack: queue[nextIndex],
        currentIndex: nextIndex,
        isPlaying: true,
        source,
        currentTime: 0,
      })
    }
  },
  
  previousTrack: () => {
    const { currentIndex, queue, source } = get()
    if (currentIndex > 0) {
      const prevIndex = currentIndex - 1
      set({
        currentTrack: queue[prevIndex],
        currentIndex: prevIndex,
        isPlaying: true,
        source,
        currentTime: 0,
      })
    }
  },
  
  setVolume: (volume) => {
    set({ volume: Math.max(0, Math.min(1, volume)) })
  },
  
  setCurrentTime: (time) => {
    set({ currentTime: time })
  },
  
  setDuration: (duration) => {
    set({ duration })
  },
  
  clearQueue: () => {
    set({
      currentTrack: null,
      queue: [],
      currentIndex: -1,
      isPlaying: false,
      currentTime: 0,
      source: null,
      isFullScreen: false,
    })
  },
}))

export { usePlayerStore }
