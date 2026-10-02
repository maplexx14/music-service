import { usePlayerStore } from '../store/playerStore'

// Сохранение очереди и позиции между запусками. iOS выгружает PWA из памяти
// после долгой паузы или при нехватке памяти, и раньше следующее открытие
// начиналось с пустого плеера: ни трека, ни очереди, ни позиции, а ▶ на
// экране блокировки не делала ничего. Теперь состояние восстанавливается на
// паузе — продолжить можно одним нажатием.
//
// Позицию берём у самого <audio> (notePosition из Player): в скрытой вкладке
// store.currentTime не обновляется ради экономии рендеров.
//
// Состояние привязано к пользователю: при входе другим аккаунтом оно не
// восстанавливается, а logout удаляет его совсем (ключ продублирован в
// authStore — импорт отсюда потянул бы playerStore в authStore).

export const PLAYER_PERSIST_KEY = 'bolt-player-v1'

// Окно очереди вокруг текущего трека: длинный плейлист целиком раздул бы
// localStorage (квота ~5 МБ на всё приложение), а дальний хвост дотянется
// пейджером или новой выдачей волны.
const KEEP_BEFORE = 50
const KEEP_AFTER = 250
const SAVE_DEBOUNCE_MS = 800

let userId = null
let position = 0
let saveTimer = null
let installed = false

function snapshot() {
  const state = usePlayerStore.getState()
  if (!state.currentTrack || state.currentIndex < 0 || userId == null) return null
  const start = Math.max(0, state.currentIndex - KEEP_BEFORE)
  const end = Math.min(state.queue.length, state.currentIndex + KEEP_AFTER + 1)
  const trimmed = start > 0 || end < state.queue.length
  const queue = state.queue.slice(start, end)
  const shuffledOrder = state.shuffledOrder
    .filter((index) => index >= start && index < end)
    .map((index) => index - start)
  const currentIndex = state.currentIndex - start
  return {
    userId,
    queue,
    currentIndex,
    isShuffle: state.isShuffle,
    shuffledOrder,
    currentShuffleIndex: state.isShuffle ? shuffledOrder.indexOf(currentIndex) : -1,
    isRepeatOne: state.isRepeatOne,
    source: state.source,
    flowActive: state.flowActive,
    // Пейджер считает смещение по длине очереди — после обрезки оно неверное.
    queuePager: trimmed ? null : state.queuePager,
    position,
    savedAt: Date.now(),
  }
}

function saveNow() {
  clearTimeout(saveTimer)
  saveTimer = null
  const data = snapshot()
  try {
    if (data) localStorage.setItem(PLAYER_PERSIST_KEY, JSON.stringify(data))
  } catch {
    // переполнение квоты / приватный режим — без сохранения, плеер работает
  }
}

function scheduleSave() {
  if (saveTimer) return
  saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS)
}

// Позиция текущего трека. Пишем не чаще раза в несколько секунд — зовущая
// сторона (timeupdate) сама троттлит; здесь только откладываем запись.
export function notePosition(seconds) {
  if (!Number.isFinite(seconds)) return
  position = seconds
  scheduleSave()
}

function install() {
  if (installed) return
  installed = true
  usePlayerStore.subscribe((state, prev) => {
    if (
      state.currentTrack !== prev.currentTrack ||
      state.queue !== prev.queue ||
      state.isShuffle !== prev.isShuffle ||
      state.isRepeatOne !== prev.isRepeatOne
    ) {
      if (state.currentTrack?.id !== prev.currentTrack?.id) position = 0
      scheduleSave()
    }
  })
  // Уход в фон и выгрузка — последний шанс записать позицию: дальше страницу
  // могут заморозить или убить без единого события.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) saveNow()
  })
  window.addEventListener('pagehide', saveNow)
}

// Восстановление для вошедшего пользователя. Зовётся, когда известен его id;
// трогает store, только если в нём ещё ничего не играет.
export function restorePlayer(currentUserId) {
  if (currentUserId == null) return
  userId = currentUserId
  install()
  if (usePlayerStore.getState().currentTrack) return
  let data = null
  try {
    data = JSON.parse(localStorage.getItem(PLAYER_PERSIST_KEY) || 'null')
  } catch {
    data = null
  }
  if (!data || data.userId !== currentUserId) return
  const track = data.queue?.[data.currentIndex]
  if (!track) return
  const savedPosition = Number(data.position) || 0
  usePlayerStore.setState({
    queue: data.queue,
    currentIndex: data.currentIndex,
    currentTrack: track,
    isShuffle: Boolean(data.isShuffle),
    shuffledOrder: Array.isArray(data.shuffledOrder) ? data.shuffledOrder : data.queue.map((_, i) => i),
    currentShuffleIndex: data.isShuffle ? data.currentShuffleIndex : -1,
    isRepeatOne: Boolean(data.isRepeatOne),
    source: data.source ?? null,
    flowActive: Boolean(data.flowActive),
    queuePager: data.queuePager ?? null,
    isPlaying: false,
  })
  // После setState: подписка выше на смене трека обнуляет position.
  position = savedPosition
  if (savedPosition > 0) restoreAt = { trackId: track.id, time: savedPosition }
}

// Позиция для восстановления — забирается один раз. Player применяет её сам,
// когда выставит src: seekRequest тут не годится, он отработал бы раньше
// назначения источника, и загрузка сбросила бы позицию в ноль.
let restoreAt = null

export function takeRestorePosition(trackId) {
  if (!restoreAt || restoreAt.trackId !== trackId) return 0
  const { time } = restoreAt
  restoreAt = null
  return time
}
