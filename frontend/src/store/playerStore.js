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

// Трек-левел дедуп прогрева резолва (см. prefetchTracks) — переживает
// ре-рендеры компонентов, но не персистится между перезагрузками страницы
// (это нормально: кэш на бэке в Redis всё равно тёплый).
const requestedPrefetchIds = new Set()

// Запись скипа — негативный сигнал для рекомендаций, поэтому важно не терять
// его молча на сетевой ошибке (как было раньше с голым .catch(() => {})).
// Несколько попыток с небольшой задержкой; skipErrorToast, чтобы фоновая
// телеметрия не спамила пользователя тостами при временных сбоях сети.
function postSkipWithRetry(dbId, attemptsLeft = 3, delayMs = 500) {
  api
    .post(`/tracks/${dbId}/skip`, null, { skipErrorToast: true })
    .catch((error) => {
      if (attemptsLeft > 1) {
        setTimeout(() => postSkipWithRetry(dbId, attemptsLeft - 1, delayMs * 2), delayMs)
      } else {
        console.error('Failed to record skip after retries:', error)
      }
    })
}

// Событие прослушивания с финальной долей дослушивания (0..1) и локальным
// часом клиента — питает completion-веса и контекст времени суток в
// рекомендациях (POST /tracks/{id}/listen). Фоновая телеметрия: ошибки
// не показываем и не ретраим агрессивно (в отличие от скипа, сигнал
// не бинарный и следующее событие быстро компенсирует потерю).
function postListenEvent(dbId, completion) {
  api
    .post(
      `/tracks/${dbId}/listen`,
      {
        completion: Math.max(0, Math.min(1, completion)),
        client_hour: new Date().getHours(),
      },
      { skipErrorToast: true },
    )
    .catch(() => {})
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

  // Материализует произвольный внешний трек в БД (для лайков/плейлистов).
  // Возвращает числовой id локальной записи. Идемпотентно на бэке.
  // Локальные треки (числовой id) возвращаются как есть.
  materializeTrack: async (track) => {
    if (!track) return null
    if (typeof track.id === 'number') return track.id
    if (typeof track.db_id === 'number') return track.db_id

    const externalId = track.external_id ?? String(track.id).split(':').slice(1).join(':')
    const { data } = await api.post('/tracks/import', {
      source: track.source,
      external_id: externalId,
      title: track.title,
      artist: track.artist,
      album: track.album ?? null,
      duration: track.duration || 0,
      cover_url: track.cover_url ?? null,
      stream_url: track.stream_url ?? null,
    })
    return data.id
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

  // Явное удаление из понравившихся (всегда DELETE) — не зависит от того,
  // загружен ли likedTrackIds. Для страницы «Понравившиеся».
  removeLike: async (trackId) => {
    if (!trackId) return
    const { likedTrackIds } = get()
    set({ likedTrackIds: likedTrackIds.filter((id) => id !== trackId) })
    try {
      await api.delete(`/tracks/${trackId}/like`)
    } catch (error) {
      set({ likedTrackIds })
      throw error
    }
  },

  // Трек, который заиграет через `offset` позиций (с учётом шаффла), без
  // побочных эффектов. offset=1 (по умолчанию) — следующий трек. Используется
  // и для прогрева резолва на бэке (в т.ч. на несколько треков вперёд), и для
  // ленивой подгрузки аудио-буфера следующего трека в плеере (см. Player.jsx).
  getNextTrack: (offset = 1) => {
    const { queue, currentIndex, isShuffle, shuffledOrder, currentShuffleIndex } = get()
    let nextIndex = null
    if (isShuffle) {
      const idx = currentShuffleIndex + offset
      if (currentShuffleIndex >= 0 && idx < shuffledOrder.length) {
        nextIndex = shuffledOrder[idx]
      }
    } else {
      const idx = currentIndex + offset
      if (currentIndex >= 0 && idx < queue.length) {
        nextIndex = idx
      }
    }
    if (nextIndex == null) return null
    return queue[nextIndex] || null
  },

  // Заранее прогревает резолв на бэке для первых `count` треков списка (не
  // дожидаясь ответа) — чтобы к моменту, когда <audio> реально попросит
  // поток, yt-dlp/Redis-кэш уже был тёплым. Бэк дедуплицирует параллельные
  // резолвы одного video_id (см. _inflight_resolves в ytdlp.py), так что
  // прогрев текущего трека не конкурирует с его же реальным стримом за
  // отдельный yt-dlp вызов. requestedPrefetchIds — трек-левел дедуп на
  // фронте, чтобы одно и то же не гонялось повторно при ре-рендерах.
  prefetchTracks: (tracks, count = 1) => {
    const list = (tracks || []).filter(Boolean).slice(0, count)
    for (const track of list) {
      if (track.source === 'ytmusic') {
        const externalId = track.external_id ?? String(track.id).split(':').slice(1).join(':')
        if (!externalId || requestedPrefetchIds.has(`yt:${externalId}`)) continue
        requestedPrefetchIds.add(`yt:${externalId}`)
        api.post(`/ytdlp/prefetch/${externalId}`).catch(() => {})
      } else if (track.source === 'soundcloud') {
        // Токен резолва зашит в stream_url (.../soundcloud/stream/{token}).
        const token = (track.stream_url || '').split('/soundcloud/stream/')[1]
        if (!token || requestedPrefetchIds.has(`sc:${token}`)) continue
        requestedPrefetchIds.add(`sc:${token}`)
        api.post(`/soundcloud/prefetch/${token}`).catch(() => {})
      }
    }
  },

  // Заранее прогревает резолв следующих в очереди треков на бэке, чтобы
  // переключение началось мгновенно (без ожидания yt-dlp/Piped). Греем
  // PREFETCH_WINDOW треков вперёд — при быстром пролистывании очереди (не
  // только next-next) следующие треки тоже успевают попасть в Redis-кэш.
  // Бэк сам ограничивает конкуренцию (_PREFETCH_SEM/_WARM_SEM в ytdlp.py),
  // так что расширение окна безопасно и не перегружает воркеры.
  prefetchNext: () => {
    const PREFETCH_WINDOW = 4
    const upcoming = Array.from({ length: PREFETCH_WINDOW }, (_, i) => get().getNextTrack(i + 1)).filter(Boolean)
    get().prefetchTracks(upcoming, upcoming.length)
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
      flowActive: source === 'flow',
    })
    // Кликнутый трек прогреваем немедленно — не дожидаясь, пока до него
    // дойдёт очередь через prefetchNext(). Дедуп на бэке (single-flight в
    // _resolve_cached) не даёт этому конкурировать с реальным <audio>-GET.
    // Заодно греем 2 следующих по очереди (с учётом шаффла) — переключение
    // вперёд стартует мгновенно даже сразу после клика.
    const upcoming = [track, get().getNextTrack(1), get().getNextTrack(2)].filter(Boolean)
    get().prefetchTracks(upcoming, upcoming.length)
  },

  // --- Персональный поток («Моя волна») ---
  flowActive: false,
  flowLoading: false,

  startFlow: async () => {
    if (get().flowLoading) return
    set({ flowLoading: true })
    try {
      const { data } = await api.get('/recommendations/flow', { params: { limit: 15 } })
      if (!data || data.length === 0) return false
      get().playPlaylist(data, 0, 'flow')
      // Прогреваем несколько треков вперёд, чтобы «Моя волна» шла без
      // ожидания резолва на каждом переключении — это основной сценарий,
      // где скорость важнее всего.
      get().prefetchTracks(data.slice(0, 4), 4)
      set({ flowActive: true })
      return true
    } finally {
      set({ flowLoading: false })
    }
  },

  // Подгружает следующую порцию заранее. Запас в 8 треков маскирует сетевую
  // задержку даже при нескольких быстрых пропусках подряд; flowLoading не даёт
  // запустить параллельные дублирующие запросы.
  extendFlowIfNeeded: async () => {
    const { flowActive, flowLoading, queue, currentIndex, isShuffle, currentShuffleIndex } = get()
    if (!flowActive || flowLoading) return
    const pos = isShuffle ? currentShuffleIndex : currentIndex
    if (pos < queue.length - 8) return

    set({ flowLoading: true })
    try {
      // Исключаем то, что уже в очереди (хвост до 100 треков).
      const exclude = queue.slice(-100).map((t) => t.id).join(',')
      const { data } = await api.get('/recommendations/flow', {
        params: { limit: 15, exclude },
      })
      const known = new Set(get().queue.map((t) => t.id))
      const fresh = (data || []).filter((t) => !known.has(t.id))
      if (fresh.length === 0) return

      get().prefetchTracks(fresh.slice(0, 4), 4)

      set((state) => {
        const startIdx = state.queue.length
        const newIndices = fresh.map((_, i) => startIdx + i)
        return {
          queue: [...state.queue, ...fresh],
          // При шаффле новые индексы дописываем в конец порядка вперемешку.
          shuffledOrder: state.isShuffle
            ? [...state.shuffledOrder, ...shuffleArray(newIndices)]
            : [...state.shuffledOrder, ...newIndices],
        }
      })
    } catch (error) {
      console.error('Flow extend error:', error)
    } finally {
      set({ flowLoading: false })
    }
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
      flowActive: source === 'flow',
    })
    get().prefetchTracks(
      [tracks[actualIndex], get().getNextTrack(1), get().getNextTrack(2)].filter(Boolean),
      3
    )
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
  
  // Скип как негативный сигнал: если переключили, прослушав <25% трека.
  // nextTrack вызывается и при естественном окончании — там прогресс ~100%,
  // так что порог отсекает его сам собой.
  //
  // Важно: если duration ещё не известна (быстрое переключение — метаданные
  // не успели прогрузиться), это НЕ повод молчать. Раз duration не пришла,
  // значит с момента старта трека прошло совсем немного — то есть точно
  // меньше 25%. Раньше здесь был ранний return при неизвестной duration, из-за
  // чего при быстром проматывании самые очевидные скипы (переключили почти
  // сразу) массово не записывались.
  _recordSkipIfNeeded: () => {
    const { currentTrack, currentTime, duration, isPlaying } = get()
    if (!currentTrack || !isPlaying) return
    const durationKnown = duration && !isNaN(duration) && duration > 0
    if (durationKnown && currentTime / duration >= 0.25) return
    const dbId =
      currentTrack.db_id ?? (typeof currentTrack.id === 'number' ? currentTrack.id : null)
    if (!dbId) return // внешний трек ещё не материализован — сигнал пропускаем
    postSkipWithRetry(dbId)
  },

  // Финальная доля прослушивания при КАЖДОМ уходе с трека (переключение
  // вперёд/назад, естественный конец — там прогресс ~100%). В отличие от
  // бинарных /play (>=50%) и /skip (<25%) покрывает и «серую зону» 25-50%:
  // трек, регулярно бросаемый на трети, — мягкий негатив для рекомендаций.
  _recordListenProgress: () => {
    const { currentTrack, currentTime, duration } = get()
    if (!currentTrack) return
    const durationKnown = duration && !isNaN(duration) && duration > 0
    if (!durationKnown || currentTime <= 0) return // не успел начаться — не событие
    const dbId =
      currentTrack.db_id ?? (typeof currentTrack.id === 'number' ? currentTrack.id : null)
    if (!dbId) return // внешний трек ещё не материализован — сигнал пропускаем
    postListenEvent(dbId, currentTime / duration)
  },

  nextTrack: () => {
    get()._recordSkipIfNeeded()
    get()._recordListenProgress()
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
    get()._recordListenProgress()
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
