import { create } from 'zustand'

const usePlayerStore = create((set, get) => ({
  currentTrack: null,
  queue: [],
  currentIndex: -1,
  isPlaying: false,
  volume: 1,
  currentTime: 0,
  duration: 0,
  
  setCurrentTrack: (track) => {
    set({ currentTrack: track, currentTime: 0 })
  },
  
  playTrack: (track, queue = []) => {
    const trackIndex = queue.findIndex(t => t.id === track.id)
    set({
      currentTrack: track,
      queue: queue.length > 0 ? queue : [track],
      currentIndex: trackIndex >= 0 ? trackIndex : 0,
      isPlaying: true,
    })
  },
  
  playPlaylist: (tracks, startIndex = 0) => {
    if (tracks.length === 0) return
    set({
      currentTrack: tracks[startIndex],
      queue: tracks,
      currentIndex: startIndex,
      isPlaying: true,
    })
  },
  
  togglePlayPause: () => {
    set((state) => ({ isPlaying: !state.isPlaying }))
  },
  
  nextTrack: () => {
    const { queue, currentIndex } = get()
    if (currentIndex < queue.length - 1) {
      const nextIndex = currentIndex + 1
      set({
        currentTrack: queue[nextIndex],
        currentIndex: nextIndex,
        currentTime: 0,
      })
    }
  },
  
  previousTrack: () => {
    const { currentIndex, queue } = get()
    if (currentIndex > 0) {
      const prevIndex = currentIndex - 1
      set({
        currentTrack: queue[prevIndex],
        currentIndex: prevIndex,
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
    })
  },
}))

export { usePlayerStore }
