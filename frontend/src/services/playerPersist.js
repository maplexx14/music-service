import api from './api'
import { usePlayerStore } from '../store/playerStore'
import { useUiSettingsStore } from '../store/uiSettingsStore'

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
//
// Копия снимка уходит на сервер (PUT /users/me/player-state): на другом
// устройстве или после очистки данных браузера плеер открывается там же.
// Из двух записей берём свежую по savedAt; серверную подхватываем и при
// возврате во вкладку, если здесь ничего не играет — послушал на ноутбуке,
// открыл телефон, продолжил с того же места.
//
// Всё это — только если юзер включил «Запоминать плеер» в настройках
// (uiSettingsStore.rememberPlayer). Выключение стирает обе копии. Снимок
// старше 48 часов не восстанавливается: сервер отдаёт пустоту по своему
// updated_at, локальный отбрасываем по savedAt.

export const PLAYER_PERSIST_KEY = 'bolt-player-v1'

// Окно очереди вокруг текущего трека: длинный плейлист целиком раздул бы
// localStorage (квота ~5 МБ на всё приложение), а дальний хвост дотянется
// пейджером или новой выдачей волны.
const KEEP_BEFORE = 50
const KEEP_AFTER = 250
const SAVE_DEBOUNCE_MS = 800
// Сервер получает снимок реже, чем localStorage: позиция тикает каждые 5 с,
// а ради неё одной гонять в БД очередь из сотен треков незачем. Уход в фон
// отправляет сразу, мимо троттлинга.
const SERVER_PUSH_MS = 15000
// Короткий уход в фон (глянуть уведомление) не повод спрашивать сервер.
const SERVER_PULL_AFTER_HIDDEN_MS = 60000
const STREAMED_SOURCES = ['jamendo', 'soulseek', 'ytmusic', 'soundcloud']
const MAX_AGE_MS = 48 * 60 * 60 * 1000

const enabled = () => useUiSettingsStore.getState().rememberPlayer

let userId = null
let position = 0
let saveTimer = null
let installed = false
let pushTimer = null
let lastPushAt = 0
let lastPushedKey = null
// savedAt последнего снимка, который это устройство записало или применило —
// серверная запись свежее него пришла с другого устройства.
let localSavedAt = 0
// Трек, выставленный восстановлением. Пока в плеере он и пауза, юзер ничего
// своего не начинал, и запись с сервера можно применить поверх.
let restoredTrackId = null
let hiddenAt = 0
// Store меняет само восстановление — это не новое состояние: перезапись
// savedAt «сейчас» затёрла бы на сервере более свежую запись другого устройства.
let applying = false

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
  if (!enabled()) return
  const data = snapshot()
  if (!data) return
  localSavedAt = data.savedAt
  try {
    localStorage.setItem(PLAYER_PERSIST_KEY, JSON.stringify(data))
  } catch {
    // переполнение квоты / приватный режим — без сохранения, плеер работает
  }
  schedulePush()
}

function pushNow() {
  clearTimeout(pushTimer)
  pushTimer = null
  if (!enabled()) return
  const data = snapshot()
  if (!data) return
  // Без savedAt: иначе каждый снимок «новый», даже если ничего не менялось.
  const { savedAt, ...rest } = data
  const key = JSON.stringify(rest)
  if (key === lastPushedKey) return
  lastPushedKey = key
  lastPushAt = Date.now()
  localSavedAt = savedAt
  api.put('/users/me/player-state', { state: data, saved_at: savedAt }, { skipErrorToast: true }).catch(() => {
    // Следующее изменение отправит снимок заново.
    lastPushedKey = null
  })
}

function schedulePush() {
  if (pushTimer) return
  const wait = Math.max(0, lastPushAt + SERVER_PUSH_MS - Date.now())
  pushTimer = setTimeout(pushNow, wait)
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

function forget() {
  clearTimeout(saveTimer)
  clearTimeout(pushTimer)
  saveTimer = pushTimer = null
  lastPushedKey = null
  try {
    localStorage.removeItem(PLAYER_PERSIST_KEY)
  } catch {
    /* noop */
  }
}

function install() {
  if (installed) return
  installed = true
  useUiSettingsStore.subscribe((state, prev) => {
    if (state.rememberPlayer === prev.rememberPlayer) return
    if (state.rememberPlayer) {
      // Включили — сразу пишем то, что сейчас в плеере.
      saveNow()
      pushNow()
    } else {
      forget()
      if (userId != null) api.delete('/users/me/player-state', { skipErrorToast: true }).catch(() => {})
    }
  })
  usePlayerStore.subscribe((state, prev) => {
    if (
      state.currentTrack !== prev.currentTrack ||
      state.queue !== prev.queue ||
      state.isShuffle !== prev.isShuffle ||
      state.isRepeatOne !== prev.isRepeatOne
    ) {
      if (state.currentTrack?.id !== prev.currentTrack?.id) position = 0
      if (!applying) scheduleSave()
    }
  })
  // Уход в фон и выгрузка — последний шанс записать позицию: дальше страницу
  // могут заморозить или убить без единого события.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = Date.now()
      saveNow()
      pushNow()
    } else if (hiddenAt && Date.now() - hiddenAt >= SERVER_PULL_AFTER_HIDDEN_MS) {
      hiddenAt = 0
      pullServer(true)
    }
  })
  window.addEventListener('pagehide', () => {
    saveNow()
    pushNow()
  })
}

function readLocal() {
  let data = null
  try {
    data = JSON.parse(localStorage.getItem(PLAYER_PERSIST_KEY) || 'null')
  } catch {
    return null
  }
  if (data && !(Date.now() - (Number(data.savedAt) || 0) <= MAX_AGE_MS)) {
    forget()
    return null
  }
  return data
}

// Ставит снимок в store на паузе. Позицию Player применит сам, когда выставит
// src (takeRestorePosition); если трек тот же и src уже стоит — через seekTo.
function applySnapshot(data) {
  const track = data.queue?.[data.currentIndex]
  if (!track) return false
  const savedPosition = Number(data.position) || 0
  const sameTrack = usePlayerStore.getState().currentTrack?.id === track.id
  applying = true
  try {
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
  } finally {
    applying = false
  }
  // После setState: подписка выше на смене трека обнуляет position.
  position = savedPosition
  restoredTrackId = track.id
  localSavedAt = Number(data.savedAt) || 0
  restoreAt = null
  if (sameTrack) {
    // Как и в Player: перемотка потока внешнего трека в WebKit залипает в
    // seeking, поэтому их не двигаем (список — EXTERNAL_SOURCES в Player).
    if (!STREAMED_SOURCES.includes(track.source)) usePlayerStore.getState().seekTo(savedPosition, 'restore')
  } else if (savedPosition > 0) {
    restoreAt = { trackId: track.id, time: savedPosition }
  }
  return true
}

// Плеер можно перезаписать снимком с сервера: пусто или стоит на паузе то,
// что выставило восстановление. Начатое юзером не трогаем.
function canReplace() {
  const state = usePlayerStore.getState()
  if (state.isPlaying) return false
  return !state.currentTrack || state.currentTrack.id === restoredTrackId
}

// anyPaused: при возврате во вкладку достаточно паузы — юзер мог дослушать
// здесь, перейти на другое устройство и вернуться.
async function pullServer(anyPaused = false) {
  if (!enabled()) return
  const requestedFor = userId
  let body = null
  try {
    const response = await api.get('/users/me/player-state', { skipErrorToast: true })
    body = response.data
  } catch {
    return
  }
  const data = body?.state
  if (!data || !enabled() || userId == null || userId !== requestedFor || data.userId !== userId) return
  if ((Number(body.saved_at) || 0) <= localSavedAt) return
  const state = usePlayerStore.getState()
  if (anyPaused ? state.isPlaying : !canReplace()) return
  data.savedAt = Number(body.saved_at)
  if (!applySnapshot(data)) return
  // Применённое — уже на сервере, обратно слать нечего.
  const { savedAt, ...rest } = snapshot() || {}
  lastPushedKey = JSON.stringify(rest)
  try {
    localStorage.setItem(PLAYER_PERSIST_KEY, JSON.stringify({ ...data, userId }))
  } catch {
    /* noop */
  }
}

// Восстановление для вошедшего пользователя. Зовётся, когда известен его id;
// трогает store, только если в нём ещё ничего не играет. Сначала локальная
// запись (мгновенно, без сети), затем серверная — если она свежее.
export function restorePlayer(currentUserId) {
  if (currentUserId == null) {
    // Выход: снимки дальше не пишутся ни локально, ни на сервер.
    userId = null
    clearTimeout(saveTimer)
    clearTimeout(pushTimer)
    saveTimer = pushTimer = null
    lastPushedKey = null
    localSavedAt = 0
    restoredTrackId = null
    return
  }
  if (userId !== currentUserId) {
    lastPushedKey = null
    localSavedAt = 0
  }
  userId = currentUserId
  install()
  if (!enabled()) {
    // Остаток от прежней версии, писавшей снимок всегда.
    forget()
    return
  }
  if (usePlayerStore.getState().currentTrack) return
  const data = readLocal()
  if (data && data.userId === currentUserId) applySnapshot(data)
  pullServer()
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
