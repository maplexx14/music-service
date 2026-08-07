// Диагностика воспроизведения на устройстве.
//
// Зачем: главные баги плеера живут на iOS с ЗАБЛОКИРОВАННЫМ экраном, где нет
// ни консоли, ни devtools, а починить их «по коду» не получается — поведение
// WebKit в фоне (разрешён ли play(), доходят ли байты, жив ли элемент) из
// исходников не выводится, его надо наблюдать. Этот модуль пишет кольцевой лог
// событий media-элемента прямо на устройстве; посмотреть его можно в
// «Настройки → Диагностика плеера» уже после того, как баг воспроизвёлся.
//
// Самое важное, что он фиксирует, — РЕЗУЛЬТАТ каждого play(). По всему плееру
// стоит `play().catch(() => {})`, и отказ автоплея (NotAllowedError) до сих пор
// молча выбрасывался. А это ключевая развилка:
//   • play() отвергнут NotAllowedError → iOS не считает вызов жестом, лечится
//     только тем, чтобы вообще не звать play() на «холодном» элементе в фоне;
//   • play() успешен, но звука нет → элемент запущен, проблема в потоке
//     (байты не идут / декодер встал / порвана аудиосессия).
// Пока этот бит выбрасывался, любой диагноз был гаданием.
//
// Лог хранится в localStorage, поэтому переживает выгрузку PWA из памяти —
// именно она и происходит, когда «пришлось открыть PWA заново».

const STORAGE_KEY = 'player_diag_v1'
const MAX_ENTRIES = 300

let entries = []
try {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw) entries = JSON.parse(raw) || []
} catch {
  entries = []
}

// Пишем синхронно, без дебаунса: событие, ради которого всё затевалось,
// случается ровно перед тем, как страницу заморозят или выгрузят, и
// отложенная запись до диска не доедет. Записей мало (события media-элемента,
// не timeupdate), так что стоимость незаметна.
function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    /* приватный режим / переполнение — диагностика не должна ничего ломать */
  }
}

// Снимок состояния элемента: по нему видно, чем «зависший» старт отличается от
// живого — есть ли данные (readyState), тянет ли браузер байты (networkState),
// и что при этом показывали пользователю.
export function snapshotAudio(audio) {
  if (!audio) return { el: 'none' }
  return {
    rs: audio.readyState,
    ns: audio.networkState,
    paused: audio.paused,
    ct: Math.round(audio.currentTime * 10) / 10,
    dur: Number.isFinite(audio.duration) ? Math.round(audio.duration) : null,
    seeking: audio.seeking || undefined,
    err: audio.error?.code,
  }
}

export function diag(event, detail) {
  entries.push({
    t: new Date().toISOString().slice(11, 23),
    hidden: document.hidden || undefined,
    event,
    ...detail,
  })
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES)
  persist()
}

// Обёртка над audio.play(), которая записывает исход. `where` — место вызова,
// чтобы в логе было видно, какой именно путь старта сработал или отвалился
// (эффект / виджет / ended / вотчдог).
export function playWithDiag(audio, where) {
  if (!audio) return Promise.resolve()
  diag('play:call', { where, ...snapshotAudio(audio) })
  let promise
  try {
    promise = audio.play()
  } catch (error) {
    diag('play:throw', { where, name: error?.name, msg: String(error?.message || error) })
    return Promise.resolve()
  }
  if (!promise?.then) {
    diag('play:sync', { where })
    return Promise.resolve()
  }
  return promise.then(
    () => {
      diag('play:ok', { where, ...snapshotAudio(audio) })
    },
    (error) => {
      diag('play:fail', { where, name: error?.name, msg: String(error?.message || error) })
    },
  )
}

export function readDiag() {
  return entries
}

export function formatDiag() {
  return entries
    .map(({ t, event, hidden, ...rest }) => {
      const flags = hidden ? ' [bg]' : ''
      const body = Object.entries(rest)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')
      return `${t}${flags} ${event} ${body}`.trimEnd()
    })
    .join('\n')
}

export function clearDiag() {
  entries = []
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* noop */
  }
}
