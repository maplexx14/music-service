import { create } from 'zustand'
import api from '../services/api'

function shuffleArray(arr) {
  const result = [...arr]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

const usePlayerStore = create((set, get) => ({
  currentTrack: null,
  queue: [],
  currentIndex: -1,
  shuffledOrder: [],
  currentShuffleIndex: -1,
  isPlaying: false,
  source: null,
  volume: 1,
  currentTime: 0,
  duration: 0,
  isFullScreen: false,
  isRepeatOne: false,
  isShuffle: false,
  likedTrackIds: [],
  likedTracksLoaded: false,
  likedTracksLoading: false,

  setCurrentTrack: (track) => {
    set({ currentTrack: track, currentTime: 0 })
  },

  // Материализует текущий внешний трек в БД (для лайков/плейлистов/истории).
  // Возвращает числовой id локальной записи. Идемпотентно на бэке.
  materializeCurrentTrack: async () => {
    const { currentTrack } = get()
    if (!currentTrack) return null
    if (typeof currentTrack.id === 'number') return currentTrack.id

    const externalId =
      currentTrack.external_id ?? String(currentTrack.id).split(':').slice(1).join(':')
    const { data } = await api.post('/tracks/import', {
      source: currentTrack.source,
      external_id: externalId,
      title: currentTrack.title,
      artist: currentTrack.artist,
      album: currentTrack.album ?? null,
      duration: currentTrack.duration || 0,
      cover_url: currentTrack.cover_url ?? null,
      stream_url: currentTrack.stream_url ?? null,
    })

    // Числовой id БД кладём в отдельное поле db_id, НЕ трогая id — иначе <audio>
    // перезагрузится и трек начнётся заново. id остаётся ключом стриминга.
    const merged = {
      ...currentTrack,
      db_id: data.id,
      external_id: currentTrack.external_id ?? data.external_id,
      stream_url: currentTrack.stream_url || data.stream_url,
    }
    set((state) => ({
      currentTrack: merged,
      queue: state.queue.map((t) => (t.id === currentTrack.id ? merged : t)),
    }))
    return data.id
  },

  fetchLikedTracks: async () => {
    const { likedTracksLoaded, likedTracksLoading } = get()
    if (likedTracksLoaded || likedTracksLoading) return

    set({ likedTracksLoading: true })
    try {
      const response = await api.get('/tracks/me/liked')
      set({
        likedTrackIds: response.data.map((track) => track.id),
        likedTracksLoaded: true,
      })
    } finally {
      set({ likedTracksLoading: false })
    }
  },

  toggleTrackLike: async (trackId) => {
    if (!trackId) return

    const { likedTrackIds } = get()
    const wasLiked = likedTrackIds.includes(trackId)
    const nextLikedTrackIds = wasLiked
      ? likedTrackIds.filter((id) => id !== trackId)
      : [...likedTrackIds, trackId]

    set({ likedTrackIds: nextLikedTrackIds, likedTracksLoaded: true })

    try {
      if (wasLiked) {
        await api.delete(`/tracks/${trackId}/like`)
      } else {
        await api.post(`/tracks/${trackId}/like`)
      }
    } catch (error) {
      set({ likedTrackIds })
      throw error
    }
  },

  // Заранее прогревает резолв следующего в очереди ytmusic-трека на бэке,
  // чтобы переключение началось мгновенно (без ожидания yt-dlp).
  prefetchNext: () => {
    const { queue, currentIndex, isShuffle, shuffledOrder, currentShuffleIndex } = get()
    let nextIndex = null
    if (isShuffle) {
      if (currentShuffleIndex >= 0 && currentShuffleIndex < shuffledOrder.length - 1) {
        nextIndex = shuffledOrder[currentShuffleIndex + 1]
      }
    } else if (currentIndex >= 0 && currentIndex < queue.length - 1) {
      nextIndex = currentIndex + 1
    }
    if (nextIndex == null) return

    const next = queue[nextIndex]
    if (!next || next.source !== 'ytmusic') return
    const externalId = next.external_id ?? String(next.id).split(':').slice(1).join(':')
    if (!externalId) return
    api.post(`/ytdlp/prefetch/${externalId}`).catch(() => {})
  },

  playTrack: (track, queue = [], source = null) => {
    const list = queue.length > 0 ? queue : [track]
    const trackIndex = list.findIndex(t => t.id === track.id)
    const { isShuffle } = get()
    const order = isShuffle ? shuffleArray(list.map((_, i) => i)) : list.map((_, i) => i)
    const shuffleIndex = isShuffle ? order.indexOf(trackIndex >= 0 ? trackIndex : 0) : trackIndex >= 0 ? trackIndex : 0
    set({
      currentTrack: track,
      queue: list,
      currentIndex: trackIndex >= 0 ? trackIndex : 0,
      shuffledOrder: order,
      currentShuffleIndex: isShuffle ? shuffleIndex : -1,
      isPlaying: true,
      source,
    })
  },

  playPlaylist: (tracks, startIndex = 0, source = null) => {
    if (tracks.length === 0) return
    const { isShuffle } = get()
    const order = isShuffle ? shuffleArray(tracks.map((_, i) => i)) : tracks.map((_, i) => i)
    const idx = isShuffle ? order.indexOf(startIndex) : startIndex
    const actualIndex = isShuffle ? order[idx] : startIndex
    set({
      currentTrack: tracks[actualIndex],
      queue: tracks,
      currentIndex: actualIndex,
      shuffledOrder: order,
      currentShuffleIndex: isShuffle ? idx : -1,
      isPlaying: true,
      source,
    })
  },

  toggleRepeatOne: () => {
    set((state) => ({ isRepeatOne: !state.isRepeatOne }))
  },

  toggleShuffle: () => {
    const state = get()
    if (state.queue.length === 0) {
      set({ isShuffle: !state.isShuffle })
      return
    }
    if (!state.isShuffle) {
      const order = shuffleArray(state.queue.map((_, i) => i))
      const shuffleIndex = order.indexOf(state.currentIndex)
      set({ isShuffle: true, shuffledOrder: order, currentShuffleIndex: shuffleIndex })
    } else {
      set({ isShuffle: false, currentShuffleIndex: -1 })
    }
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
    const { queue, currentIndex, source, isShuffle, shuffledOrder, currentShuffleIndex } = get()
    if (isShuffle && shuffledOrder.length > 0) {
      if (currentShuffleIndex < shuffledOrder.length - 1) {
        const nextShuffleIndex = currentShuffleIndex + 1
        const nextIndex = shuffledOrder[nextShuffleIndex]
        set({
          currentTrack: queue[nextIndex],
          currentIndex: nextIndex,
          currentShuffleIndex: nextShuffleIndex,
          isPlaying: true,
          source,
          currentTime: 0,
        })
      }
      return
    }
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
    const { currentIndex, queue, source, isShuffle, shuffledOrder, currentShuffleIndex } = get()
    if (isShuffle && shuffledOrder.length > 0) {
      if (currentShuffleIndex > 0) {
        const prevShuffleIndex = currentShuffleIndex - 1
        const prevIndex = shuffledOrder[prevShuffleIndex]
        set({
          currentTrack: queue[prevIndex],
          currentIndex: prevIndex,
          currentShuffleIndex: prevShuffleIndex,
          isPlaying: true,
          source,
          currentTime: 0,
        })
      }
      return
    }
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

  // Запрос на перемотку из компонентов без доступа к <audio> (полноэкранный
  // плеер). Player подхватывает seekRequest и выставляет audio.currentTime.
  seekRequest: null,
  seekTo: (time) => {
    if (time == null || isNaN(time)) return
    set({ currentTime: time, seekRequest: { time } })
  },
  clearSeekRequest: () => set({ seekRequest: null }),

  setDuration: (duration) => {
    set({ duration })
  },
  
  clearQueue: () => {
    set({
      currentTrack: null,
      queue: [],
      currentIndex: -1,
      shuffledOrder: [],
      currentShuffleIndex: -1,
      isPlaying: false,
      currentTime: 0,
      source: null,
      isFullScreen: false,
    })
  },
}))

export { usePlayerStore }
