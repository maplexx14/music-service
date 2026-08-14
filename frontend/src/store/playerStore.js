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

// Ключ прогрева резолва трека — зеркалит логику prefetchTracks. Нужен, чтобы
// понять, завершился ли резолв следующего трека (гейт скипа вперёд).
// Возвращает null для локальных/несписочных треков: им резолв не нужен, они
// «готовы» всегда.
function prefetchKeyFor(track) {
  if (!track) return null
  if (track.source === 'ytmusic') {
    const externalId = track.external_id ?? String(track.id).split(':').slice(1).join(':')
    return externalId ? `yt:${externalId}` : null
  }
  if (track.source === 'soundcloud') {
    const token = (track.stream_url || '').split('/soundcloud/stream/')[1]
    return token ? `sc:${token}` : null
  }
  return null
}

// Готов ли трек к мгновенному старту: его резолв на бэке уже завершён, либо
// резолв ему не нужен вовсе (локальный трек — prefetchKeyFor даёт null).
function isTrackResolved(track) {
  const key = prefetchKeyFor(track)
  return !key || resolvedPrefetchKeys.has(key)
}

// Трек-левел дедуп прогрева резолва (см. prefetchTracks) — переживает
// ре-рендеры компонентов, но не персистится между перезагрузками страницы
// (это нормально: кэш на бэке в Redis всё равно тёплый).
const requestedPrefetchIds = new Set()

// Ключи треков, для которых прогрев резолва на бэке УЖЕ ЗАВЕРШИЛСЯ (POST
// вернулся). Гейтит скип вперёд: пока резолв следующего не готов, кнопка
// «следующий» заблокирована, чтобы не прыгать на ещё не подгруженный трек.
// Дублируется в store.resolvedPrefetchVersion (счётчик) для реактивности —
// сам Set держим на уровне модуля, чтобы переживал ре-рендеры.
const resolvedPrefetchKeys = new Set()

// Предзагрузка потока рекомендаций (см. preloadFlow/startFlow):
// дедуп летящего запроса + TTL свежести предзагруженного списка.
let flowPreloadPromise = null
let flowPreloadGeneration = 0
const FLOW_PRELOAD_TTL_MS = 5 * 60 * 1000

function invalidateFlowPreload() {
  flowPreloadGeneration += 1
  usePlayerStore.setState({ flowPreload: null })
}

// --- Постраничная очередь (см. queuePager / extendQueueIfNeeded) ---
// Страница плейлиста рисует треки не все сразу, а страницами по мере прокрутки,
// и в очередь плеера попадало ровно то, что она успела загрузить. Поэтому
// воспроизведение вставало на последнем загруженном треке: для плеера это был
// конец очереди, хотя в плейлисте оставались треки. Ленивую загрузку это не
// отменяет — просто хвост очереди плеер дотягивает сам, независимо от того,
// докуда доскроллил пользователь.
//
// Страницу берём крупнее, чем у списка на экране (20): очередь ничего не
// рисует и обложек не тянет, так что дешевле сходить реже и с большим запасом.
const QUEUE_PAGE_SIZE = 50
// За сколько треков до конца очереди идём за следующей страницей. Запас нужен
// не для одного перехода, а на случай серии быстрых скипов подряд.
const QUEUE_EXTEND_LEAD = 5
// Дедуп летящей догрузки. Промис отдаётся наружу: тому, кто упёрся в конец
// очереди прямо сейчас (см. handleEnded в Player.jsx), важно дождаться
// реального прибытия хвоста — в том числе когда запрос стартовал до его вызова.
let queueExtendPromise = null

// Монотонный id позволяет обработчику перемотки сбросить именно тот запрос,
// который он применил, не затерев более свежий seek из следующего рендера.
let seekRequestSequence = 0

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
  dislikedTrackIds: [],
  dislikedTracksLoaded: false,
  dislikedTracksLoading: false,

  setCurrentTrack: (track) => {
    set({ currentTrack: track, currentTime: 0, seekRequest: null })
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
      const response = await api.get('/tracks/me/liked/ids')
      set({
        likedTrackIds: response.data,
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

    // Лайк снимает дизлайк (это же делает бэк в like_track): иначе строка в
    // user_track_skips продолжала бы исключать трек из рекомендаций.
    const { dislikedTrackIds } = get()
    set({
      likedTrackIds: nextLikedTrackIds,
      likedTracksLoaded: true,
      dislikedTrackIds: wasLiked
        ? dislikedTrackIds
        : dislikedTrackIds.filter((id) => id !== trackId),
    })

    try {
      if (wasLiked) {
        await api.delete(`/tracks/${trackId}/like`)
      } else {
        await api.post(`/tracks/${trackId}/like`)
      }
    } catch (error) {
      set({ likedTrackIds, dislikedTrackIds })
      throw error
    }
  },

  fetchDislikedTracks: async () => {
    const { dislikedTracksLoaded, dislikedTracksLoading } = get()
    if (dislikedTracksLoaded || dislikedTracksLoading) return

    set({ dislikedTracksLoading: true })
    try {
      const response = await api.get('/tracks/me/disliked/ids')
      set({ dislikedTrackIds: response.data, dislikedTracksLoaded: true })
    } finally {
      set({ dislikedTracksLoading: false })
    }
  },

  // Дизлайк («не нравится»): трек уходит из рекомендаций и волны. Лайк при
  // этом снимается и на бэке (см. dislike_track), поэтому чистим его и в
  // локальном состоянии — иначе сердечко осталось бы залитым.
  toggleTrackDislike: async (trackId) => {
    if (!trackId) return
    const { dislikedTrackIds, likedTrackIds } = get()
    const wasDisliked = dislikedTrackIds.includes(trackId)

    set({
      dislikedTrackIds: wasDisliked
        ? dislikedTrackIds.filter((id) => id !== trackId)
        : [...dislikedTrackIds, trackId],
      dislikedTracksLoaded: true,
      likedTrackIds: wasDisliked ? likedTrackIds : likedTrackIds.filter((id) => id !== trackId),
    })

    try {
      if (wasDisliked) {
        await api.delete(`/tracks/${trackId}/dislike`)
      } else {
        await api.post(`/tracks/${trackId}/dislike`)
      }
    } catch (error) {
      set({ dislikedTrackIds, likedTrackIds })
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
  //
  // ВАЖНО: POST /prefetch — fire-and-forget (ставит фоновую задачу и сразу
  // отвечает "queued", см. schedule_prefetch на бэке). Поэтому «POST вернулся»
  // НЕ значит «трек готов». Готовность узнаём отдельным поллингом
  // GET /prefetch/{id}/ready — только он даёт настоящий сигнal для гейта
  // скипа вперёд (см. _pollPrefetchReady / isNextTrackReady).
  prefetchTracks: (tracks, count = 1) => {
    const list = (tracks || []).filter(Boolean).slice(0, count)
    for (const track of list) {
      if (track.source === 'ytmusic') {
        const externalId = track.external_id ?? String(track.id).split(':').slice(1).join(':')
        if (!externalId) continue
        const key = `yt:${externalId}`
        if (requestedPrefetchIds.has(key)) continue
        requestedPrefetchIds.add(key)
        api.post(`/ytdlp/prefetch/${externalId}`)
          .then(() => get()._pollPrefetchReady(key, `/ytdlp/prefetch/${externalId}/ready`))
          .catch(() => requestedPrefetchIds.delete(key))
      } else if (track.source === 'soundcloud') {
        // Токен резолва зашит в stream_url (.../soundcloud/stream/{token}).
        const token = (track.stream_url || '').split('/soundcloud/stream/')[1]
        if (!token) continue
        const key = `sc:${token}`
        if (requestedPrefetchIds.has(key)) continue
        requestedPrefetchIds.add(key)
        api.post(`/soundcloud/prefetch/${token}`)
          .then(() => get()._pollPrefetchReady(key, `/soundcloud/prefetch/${token}/ready`))
          .catch(() => requestedPrefetchIds.delete(key))
      }
    }
  },

  // Поллит GET /prefetch/{id}/ready, пока бэк не подтвердит, что резолв трека
  // реально готов (URL в Redis или кэш-файл на диске) — тогда помечает ключ
  // готовым (снимает гейт скипа вперёд). Лёгкий запрос (без запуска работы на
  // бэке), интервал ~600 мс, кап попыток, чтобы зависший резолв не поллился
  // вечно. При исчерпании попыток ключ всё равно помечаем готовым — гейт не
  // должен запирать пользователя навсегда из-за медленного/битого источника.
  _pollPrefetchReady: (key, readyUrl) => {
    if (!key || resolvedPrefetchKeys.has(key)) return
    const POLL_INTERVAL_MS = 600
    const MAX_ATTEMPTS = 40 // ~24 c потолок
    let attempts = 0
    const tick = () => {
      if (resolvedPrefetchKeys.has(key)) return
      attempts += 1
      api
        .get(readyUrl, { skipErrorToast: true })
        .then(({ data }) => {
          if (data?.ready) {
            get()._markPrefetchResolved(key)
          } else if (attempts < MAX_ATTEMPTS) {
            setTimeout(tick, POLL_INTERVAL_MS)
          } else {
            get()._markPrefetchResolved(key) // не запираем навсегда
          }
        })
        .catch(() => {
          if (attempts < MAX_ATTEMPTS) setTimeout(tick, POLL_INTERVAL_MS)
          else get()._markPrefetchResolved(key)
        })
    }
    tick()
  },

  // Прогрев резолва трека реально завершён (ready=True с бэка) — помечаем ключ
  // готовым и бьём счётчик реактивности, чтобы гейт скипа (isNextTrackReady) в
  // UI пересчитался. Local/несписочные треки резолва не требуют — их
  // prefetchKeyFor даёт null, и гейт считает их готовыми и без этой записи.
  resolvedPrefetchVersion: 0,
  _markPrefetchResolved: (key) => {
    if (!key || resolvedPrefetchKeys.has(key)) return
    resolvedPrefetchKeys.add(key)
    set((state) => ({ resolvedPrefetchVersion: state.resolvedPrefetchVersion + 1 }))
  },

  // Готов ли к скипу вперёд следующий трек: его резолв на бэке уже завершён,
  // либо трек резолва не требует (локальный/списочный — prefetchKeyFor=null),
  // либо очередь кончилась (гейтить нечего). Читается в Player для блокировки
  // кнопки «следующий»/свайпа/виджета.
  isNextTrackReady: () => {
    const next = get().getNextTrack(1)
    if (!next) return true // конец очереди — гейтить нечего
    const key = prefetchKeyFor(next)
    if (!key) return true // резолв не нужен
    return resolvedPrefetchKeys.has(key)
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
      seekRequest: null,
      // Очередь пришла целиком (поиск, карточка на главной) — тянуть нечего,
      // а пейджер прежнего плейлиста дописал бы в неё чужие треки.
      queuePager: null,
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
  // Предзагруженный список потока: { tracks, ts }. Заполняется preloadFlow()
  // (монтирование главной / hover по кнопке), потребляется startFlow().
  flowPreload: null,

  // Фоновая предзагрузка потока. Без неё клик по «потоку» ждал ДВЕ
  // последовательные операции: расчёт рекомендаций на бэке
  // (GET /recommendations/flow), а ЗАТЕМ холодный резолв первого трека
  // (yt-dlp — единицы секунд). Теперь и список, и резолв первых треков
  // греются заранее, и клик стартует почти мгновенно.
  // Дедуп через flowPreloadPromise; TTL защищает от устаревшей выдачи
  // (лайки/скипы после предзагрузки меняют рекомендации).
  preloadFlow: () => {
    const { flowActive, flowPreload } = get()
    if (flowActive) return
    if (flowPreload && Date.now() - flowPreload.ts < FLOW_PRELOAD_TTL_MS) return
    if (flowPreloadPromise) return
    const generation = flowPreloadGeneration
    flowPreloadPromise = api
      .get('/recommendations/flow', { params: { limit: 15 }, skipErrorToast: true })
      .then(({ data }) => {
        if (generation === flowPreloadGeneration && data && data.length > 0) {
          set({ flowPreload: { tracks: data, ts: Date.now() } })
          // Греем резолв первых двух треков заранее — к клику Redis уже тёплый.
          get().prefetchTracks(data.slice(0, 2), 2)
        }
      })
      .catch(() => {})
      .finally(() => {
        flowPreloadPromise = null
      })
  },

  startFlow: async () => {
    if (get().flowLoading) return false
    set({ flowLoading: true })
    try {
      // Если предзагрузка ещё летит (клик сразу после открытия страницы) —
      // дожидаемся её вместо запуска дублирующего запроса.
      if (flowPreloadPromise) {
        try {
          await flowPreloadPromise
        } catch {
          /* предзагрузка упала — ниже сходим за списком сами */
        }
      }

      // Мгновенный старт из предзагруженного списка: без ожидания
      // расчёта рекомендаций, а резолв первого трека уже прогрет.
      // Список потребляется (обнуляется), чтобы следующий запуск потока
      // получил свежую выдачу с учётом новых сигналов.
      const preload = get().flowPreload
      if (preload && Date.now() - preload.ts < FLOW_PRELOAD_TTL_MS && preload.tracks.length > 0) {
        set({ flowPreload: null })
        // Стартуем с трека, чей резолв УЖЕ завершён (preloadFlow греет первые
        // два, ready-поллинг помечает готовность). Если первый ещё резолвится,
        // а второй готов — начать со второго значит играть сразу вместо
        // ожидания нескольких секунд; порядок потока при этом не важен, он
        // и так перемешан на бэке. Ничего не готово — стартуем с нулевого.
        const startIndex = Math.max(preload.tracks.findIndex(isTrackResolved), 0)
        get().playPlaylist(preload.tracks, startIndex, 'flow')
        get().prefetchTracks(preload.tracks.slice(0, 4), 4)
        set({ flowActive: true })
        return true
      }

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

  // --- Постраничная очередь ---
  // Откуда дотягивать хвост очереди: { url, params, total }. Ставится
  // playPlaylist со страницы, которая грузит треки постранично; null означает
  // «очередь полная, тянуть неоткуда» (поиск, волна, внешний плейлист).
  queuePager: null,

  // Дотягивает следующую страницу очереди, когда до её конца осталось меньше
  // QUEUE_EXTEND_LEAD треков. Возвращает промис, который резолвится в true,
  // если очередь реально выросла — вызывающему (handleEnded) это нужно, чтобы
  // понять, появился ли следующий трек, или плейлист правда кончился.
  //
  // Ленивую отрисовку списка на странице это не трогает: очередь живёт в store
  // и ничего не рисует, поэтому её хвост можно тянуть независимо от того,
  // докуда доскроллил пользователь.
  extendQueueIfNeeded: async (force = false) => {
    const { queuePager, queue, currentIndex, isShuffle, currentShuffleIndex } = get()
    if (!queuePager) return false
    if (queue.length >= queuePager.total) return false
    const pos = isShuffle ? currentShuffleIndex : currentIndex
    if (!force && pos < queue.length - 1 - QUEUE_EXTEND_LEAD) return false
    // Запрос уже летит — ждём его, а не запускаем второй за той же страницей.
    if (queueExtendPromise) return queueExtendPromise

    const skip = queue.length
    queueExtendPromise = (async () => {
      try {
        const response = await api.get(queuePager.url, {
          params: { ...queuePager.params, skip, limit: QUEUE_PAGE_SIZE },
          skipErrorToast: true,
        })
        const total = Number(response.headers['x-total-count']) || queuePager.total
        // Гонка с самим собой: пока запрос летел, очередь могли сменить
        // (playPlaylist с другого экрана) — тогда дописывать хвост некуда,
        // он от прежнего плейлиста.
        const state = get()
        if (state.queuePager?.url !== queuePager.url || state.queue.length !== skip) return false

        // Дедуп по id: пагинация идёт по смещению, и если плейлист правили
        // прямо во время прослушивания, смещения съезжают и страница может
        // вернуть уже знакомый трек. Одинаковых треков внутри плейлиста бэк
        // не допускает (POST даёт 400), так что совпадение id — всегда съезд.
        const known = new Set(state.queue.map((t) => t.id))
        const fresh = (response.data?.tracks || []).filter((t) => !known.has(t.id))
        if (fresh.length === 0) {
          // Тянуть больше нечего: плейлист кончился или укоротился, пока его
          // слушали. Пейджер закрываем, иначе на каждом переходе ходили бы за
          // страницей, которой нет.
          set({ queuePager: null })
          return false
        }

        set({
          queue: [...state.queue, ...fresh],
          // При шаффле новые индексы дописываем в конец порядка вперемешку —
          // так же, как это делает extendFlowIfNeeded.
          shuffledOrder: state.isShuffle
            ? [...state.shuffledOrder, ...shuffleArray(fresh.map((_, i) => skip + i))]
            : [...state.shuffledOrder, ...fresh.map((_, i) => skip + i)],
          queuePager: skip + fresh.length < total ? { ...queuePager, total } : null,
        })
        // Хвост приехал — греем резолв ближайших, иначе первый же переход в
        // догруженную часть ждал бы холодный yt-dlp.
        get().prefetchTracks(fresh, 2)
        return true
      } catch (error) {
        console.error('Queue extend error:', error)
        return false
      } finally {
        queueExtendPromise = null
      }
    })()
    return queueExtendPromise
  },

  playPlaylist: (tracks, startIndex = 0, source = null, pager = null) => {
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
      seekRequest: null,
      // Пейджер описывает, откуда брать хвост очереди (см. extendQueueIfNeeded).
      // Прошлый — всегда сбрасываем: он относился к прежнему списку, и дотянуть
      // по нему хвост к новой очереди значит склеить два разных плейлиста.
      queuePager: pager && pager.total > tracks.length ? { ...pager } : null,
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

  openFullScreen: (karaoke = false) => {
    set({ isFullScreen: true, karaokeMode: karaoke })
  },

  closeFullScreen: () => {
    set({ isFullScreen: false, karaokeMode: false })
  },

  karaokeMode: false,
  
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
          seekRequest: null,
        })
      } else {
        set({ isPlaying: false, seekRequest: null })
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
        seekRequest: null,
      })
    } else {
      set({ isPlaying: false, seekRequest: null })
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
          seekRequest: null,
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
        seekRequest: null,
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
    set({
      currentTime: time,
      seekRequest: {
        id: ++seekRequestSequence,
        time,
        trackId: get().currentTrack?.id ?? null,
      },
    })
  },
  clearSeekRequest: (requestId = null) => set((state) => {
    if (requestId !== null && state.seekRequest?.id !== requestId) return state
    return { seekRequest: null }
  }),

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
      seekRequest: null,
      source: null,
      isFullScreen: false,
      queuePager: null,
    })
  },
}))

// --- Intent-префетч (hover/pointerdown по строке трека) ---
// Запускает прогрев резолва на бэке ЗАРАНЕЕ — в момент, когда пользователь
// только навёл курсор / коснулся строки, за 200–1000 мс до реального
// клика. К моменту, когда <audio> запросит поток, резолв уже в Redis —
// старт воспроизведения почти мгновенный. Дедуп: requestedPrefetchIds
// на фронте + single-flight на бэке, так что повторные наведения бесплатны.
//
// hover дебаунсим (~120 мс), чтобы быстрое пролистывание списка мышью
// не спамило бэк префетчами всех задетых строк. pointerdown — без
// задержки: касание/нажатие почти всегда предшествует клику.
let intentHoverTimer = null

function prefetchOnIntent(track, { immediate = false } = {}) {
  if (!track) return
  const fire = () => usePlayerStore.getState().prefetchTracks([track], 1)
  if (immediate) {
    if (intentHoverTimer) {
      clearTimeout(intentHoverTimer)
      intentHoverTimer = null
    }
    fire()
    return
  }
  if (intentHoverTimer) clearTimeout(intentHoverTimer)
  intentHoverTimer = setTimeout(() => {
    intentHoverTimer = null
    fire()
  }, 120)
}

// Готовые пропсы для строки/карточки трека: распылить через
// {...trackIntentHandlers(track)} на кликабельный элемент.
function trackIntentHandlers(track) {
  return {
    onMouseEnter: () => prefetchOnIntent(track),
    onPointerDown: () => prefetchOnIntent(track, { immediate: true }),
  }
}

export { usePlayerStore, prefetchOnIntent, trackIntentHandlers, invalidateFlowPreload }
