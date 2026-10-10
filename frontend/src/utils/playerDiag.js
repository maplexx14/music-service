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

import { noteFrameEvent, noteSpan } from './frameMeter'

const STORAGE_KEY = 'player_diag_v1'
const MAX_ENTRIES = 300

let entries = []
try {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw) entries = JSON.parse(raw) || []
} catch {
  entries = []
}

// В фоне пишем синхронно, без дебаунса: событие, ради которого всё
// затевалось, случается ровно перед тем, как страницу заморозят или выгрузят,
// и отложенная запись до диска не доедет.
//
// Пока страница на экране — пачкой, раз в PERSIST_DELAY_MS. Каждая запись —
// это весь журнал (до MAX_ENTRIES записей, десятки КБ) в localStorage, а на
// смене трека и перемотке событий десяток подряд. Замер плавности ловил
// после каждого медиасобытия блокировку главного потока на 60–100 мс, и
// синхронная запись — главный подозреваемый (её время пишется в замер). На
// экране страницу не заморозят без visibilitychange, а на нём отложенное
// дописывается сразу. 2 с — длиннее таймеров, которых WebKit ждёт перед
// кликом, если их поставили на касании (запись бывает и из тапа).
const PERSIST_DELAY_MS = 2000
let persistTimer = 0

function persistNow() {
  clearTimeout(persistTimer)
  persistTimer = 0
  const startedAt = performance.now()
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    /* приватный режим / переполнение — диагностика не должна ничего ломать */
  }
  noteSpan('диагностика: запись журнала', performance.now() - startedAt)
}

function persist() {
  if (document.hidden) persistNow()
  else if (!persistTimer) persistTimer = setTimeout(persistNow, PERSIST_DELAY_MS)
}

if (typeof document !== 'undefined') {
  const flush = () => {
    if (persistTimer) persistNow()
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flush()
  })
  window.addEventListener('pagehide', flush)
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
  noteFrameEvent(event)
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
  // Синхронная часть play() — WebKit на iPhone делает в ней работу медиаплеера
  // на главном потоке; замер плавности видит её отдельной строкой.
  const startedAt = performance.now()
  try {
    promise = audio.play()
    noteSpan('аудио: play()', performance.now() - startedAt)
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
  clearTimeout(persistTimer)
  persistTimer = 0
  entries = []
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* noop */
  }
}

// Сетевые запросы потока трека — чтобы по логу с телефона отличить медленную
// сеть от медленного сервера и от самого Safari. WebKit на один трек шлёт
// несколько Range-запросов подряд, и старт ждёт их все: в логе видно, когда
// ушёл каждый (start, мс от назначения src), сколько ждали первый байт (ttfb),
// сколько шло тело (dur), объём (kb) и время бэкенда из Server-Timing (srv).
// Записи берём наблюдателем, а не из performance.getEntries: буфер Resource
// Timing (250 записей) PWA забивает обложками, и запросы аудио туда уже не
// попадают.
const streamEntries = []
try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!entry.name.includes('/stream')) continue
      streamEntries.push(entry)
      if (streamEntries.length > 40) streamEntries.shift()
    }
  }).observe({ type: 'resource', buffered: true })
} catch {
  /* нет PerformanceObserver — диагностика сети просто не пишется */
}

export function diagStreamRequests(src, since) {
  if (!src) return
  let path
  try {
    path = new URL(src, location.href).pathname
  } catch {
    return
  }
  const own = streamEntries.filter(
    (entry) => entry.name.includes(path) && entry.startTime >= since - 50,
  )
  // Запросы могут ещё не закрыться к моменту 'playing' (тело Range-ответа
  // качается дальше) — отметим это, а не потеряем запрос.
  const rows = own.slice(-8).map((entry) => {
    const ttfb = entry.responseStart > 0 ? Math.round(entry.responseStart - entry.startTime) : '?'
    const srv = (entry.serverTiming || []).find((timing) => timing.name === 'total')
    // conn > 0 — запрос открыл НОВОЕ соединение (TCP+TLS), а не пошёл по
    // уже открытому соединению страницы; proto — h2/h3/http/1.1.
    const conn = entry.connectEnd > entry.connectStart
      ? Math.round(entry.connectEnd - entry.connectStart)
      : 0
    return [
      `+${Math.round(entry.startTime - since)}`,
      `ttfb=${ttfb}`,
      `conn=${conn}`,
      entry.nextHopProtocol || null,
      `dur=${Math.round(entry.duration)}`,
      `kb=${Math.round((entry.encodedBodySize || entry.transferSize || 0) / 1024)}`,
      srv ? `srv=${Math.round(srv.duration)}` : null,
    ].filter(Boolean).join('/')
  })
  diag('net', { n: own.length, req: rows.join(' ') || 'none' })
}

// Пинг до бэкенда обычным fetch страницы — точка сравнения для ttfb медиа:
// fetch идёт по соединению страницы, медиа на iOS — нет (см. conn в net).
// Если пинг быстрый, а ttfb медиа долгий — тормозит медиастек, не сеть.
export async function diagPing() {
  const times = []
  for (let i = 0; i < 3; i += 1) {
    const started = performance.now()
    try {
      await fetch(`/api/health?ping=${Date.now()}`, { cache: 'no-store' })
      times.push(Math.round(performance.now() - started))
    } catch {
      times.push('x')
    }
  }
  diag('ping', { ms: times.join(',') })
}
