// Замер плавности на устройстве. На iPhone без мака нет ни Web Inspector, ни
// счётчика кадров, а «интерфейс не плавный» по коду не локализуется: в одном
// месте может тормозить JS, в другом — размытие или WebGL-фон. Замер считает
// каждый кадр через rAF и раскладывает пропуски по ситуациям (что делал
// палец, какой экран, открыт ли плеер, играет ли музыка) — по отчёту видно,
// где именно теряются кадры.
//
// Включается вручную в «Настройки → Диагностика» и живёт до выключения,
// переживая перезапуск PWA. Выключенный ничего не делает: rAF-цикл сам по себе
// не бесплатен, держать его у всех нельзя.

import { usePlayerStore } from '../store/playerStore'

const ENABLED_KEY = 'bolt-frame-meter'
const REPORT_KEY = 'bolt-frame-meter-report'
const FRAME_MS = 1000 / 60
// Кадр длиннее полутора интервалов — хотя бы один кадр пропущен.
const JANK_MS = FRAME_MS * 1.5
const LONG_MS = 50
// Разрыв больше секунды — вкладка была скрыта или заморожена, это не тормоз.
const GAP_MS = 1000
const WORST_KEEP = 20
const SAVE_EVERY_MS = 5000
// Сколько после последнего события ситуация ещё считается текущей.
const SCROLL_HOLD_MS = 150
const MOVE_HOLD_MS = 100

let running = false
let stats = {}
let worst = []
// Отклик: от тапа до первого кадра, где видна реакция, по типам действий.
let reactions = {}
let startedAt = 0
let lastSavedAt = 0

let touching = false
let lastMoveAt = 0
let lastScrollAt = 0

// Недавние события (смена трека, события плеера из diag, тапы) — чтобы у
// долгого кадра было видно, что его запустило. Хранится последняя секунда.
const EVENT_WINDOW_MS = 1000
const EVENTS_PER_FRAME = 4
let recentEvents = []

// Отклик на действие. Тап (touchend) — момент, когда палец отпущен: и
// нативные кнопки, и веб-клик срабатывают по отпусканию. Конец отсчёта —
// кадр (rAF), в котором реакция уже в DOM; на экран он выходит ещё через
// ~1 кадр (16 мс), это одинаково для всех строк и в цифры не добавляется.
//
// - «тап»: любой тап → первый кадр после обработчиков клика (задержка ввода
//   плюс синхронная работа обработчика);
// - «вкладка»: тап по нижнему меню → кадр, где показан экран этой вкладки;
// - «плеер»: тап по мини-плееру → кадр, где появился полноэкранный плеер.
const REACTION_KEEP = 60
const REACTION_TIMEOUT_MS = 3000
const TAP_CLICK_WINDOW_MS = 600
let lastTapAt = 0
let probe = null

function noteReaction(name, ms) {
  const list = reactions[name] || (reactions[name] = [])
  list.push(Math.round(ms))
  if (list.length > REACTION_KEEP) list.shift()
}

// Что считать завершением действия для тапа по target.
function probeFor(target) {
  const navItem = target.closest?.('.mobile-nav-global-item, .sidebar-nav .nav-item')
  if (navItem) {
    const to = new URL(navItem.href, window.location.href).pathname
    if (to === window.location.pathname) return null
    return {
      name: 'вкладка',
      done: () => document.querySelector(`.screen[data-active][data-screen="tab:${to}"]`),
    }
  }
  if (
    target.closest?.('.player') &&
    !target.closest('.like-btn, .dislike-btn, .add-btn, .play-pause-btn, .control-btn, .player-progress-top, input')
  ) {
    return { name: 'плеер', done: () => document.querySelector('.fullscreen-player') }
  }
  return null
}

const onClick = (e) => {
  const now = performance.now()
  const t0 = now - lastTapAt < TAP_CLICK_WINDOW_MS ? lastTapAt : e.timeStamp
  requestAnimationFrame((frame) => noteReaction('тап', frame - t0))
  const next = e.target instanceof Element ? probeFor(e.target) : null
  if (next) probe = { ...next, t0 }
}

function checkProbe(now) {
  if (!probe) return
  if (probe.done()) {
    noteReaction(probe.name, now - probe.t0)
    probe = null
  } else if (now - probe.t0 > REACTION_TIMEOUT_MS) {
    noteReaction(`${probe.name} (не дождались)`, now - probe.t0)
    probe = null
  }
}

export function noteFrameEvent(name) {
  if (!running) return
  const now = performance.now()
  recentEvents.push({ name, at: now })
  while (recentEvents.length && now - recentEvents[0].at > EVENT_WINDOW_MS) recentEvents.shift()
}

function eventsBefore(now) {
  return recentEvents
    .filter((e) => now - e.at <= EVENT_WINDOW_MS)
    .slice(-EVENTS_PER_FRAME)
    .map((e) => `${e.name} −${Math.round(now - e.at)}мс`)
    .join(', ')
}

// Короткое имя того, по чему тапнули: класс ближайшей кнопки или элемента.
function describeTarget(target) {
  const el = target instanceof Element ? target.closest('button, a, [role], [class]') : null
  if (!el) return 'tap'
  const cls = typeof el.className === 'string' ? el.className.split(' ')[0] : ''
  return `tap:${el.getAttribute('aria-label') || cls || el.tagName.toLowerCase()}`.slice(0, 40)
}

function readEnabled() {
  try {
    return localStorage.getItem(ENABLED_KEY) === '1'
  } catch {
    return false
  }
}

function loadReport() {
  try {
    const data = JSON.parse(localStorage.getItem(REPORT_KEY) || 'null')
    if (data && typeof data === 'object') {
      stats = data.stats || {}
      worst = data.worst || []
      reactions = data.reactions || {}
      startedAt = data.startedAt || Date.now()
      return
    }
  } catch {
    /* битый отчёт — начинаем заново */
  }
  stats = {}
  worst = []
  reactions = {}
  startedAt = Date.now()
}

function saveReport() {
  try {
    localStorage.setItem(REPORT_KEY, JSON.stringify({ stats, worst, reactions, startedAt }))
  } catch {
    /* хранилище недоступно — отчёт живёт до перезапуска */
  }
}

function screenName() {
  const segment = window.location.pathname.split('/')[1] || 'home'
  return segment.length > 16 ? segment.slice(0, 16) : segment
}

function activity(now) {
  if (now - lastScrollAt < SCROLL_HOLD_MS) return 'прокрутка'
  if (now - lastMoveAt < MOVE_HOLD_MS) return 'жест'
  if (touching) return 'касание'
  return 'покой'
}

function context(now) {
  const parts = [activity(now), screenName()]
  if (document.querySelector('.fullscreen-player')) parts.push('плеер')
  if (usePlayerStore.getState().isPlaying) parts.push('играет')
  return parts.join(' · ')
}

function record(delta, now) {
  const key = context(now)
  const entry = stats[key] || (stats[key] = { frames: 0, janky: 0, missed: 0, long: 0, worst: 0 })
  entry.frames += 1
  if (delta > JANK_MS) {
    entry.janky += 1
    entry.missed += Math.max(1, Math.round(delta / FRAME_MS) - 1)
  }
  if (delta > LONG_MS) {
    entry.long += 1
    worst.push({ ms: Math.round(delta), at: Date.now(), ctx: key, ev: eventsBefore(now) })
    worst.sort((a, b) => b.ms - a.ms)
    if (worst.length > WORST_KEEP) worst.length = WORST_KEEP
  }
  if (delta > entry.worst) entry.worst = Math.round(delta)
}

function loop() {
  let last = 0
  const tick = (now) => {
    if (!running) return
    if (last && !document.hidden) {
      const delta = now - last
      if (delta < GAP_MS) record(delta, now)
    }
    checkProbe(now)
    last = now
    if (now - lastSavedAt > SAVE_EVERY_MS) {
      lastSavedAt = now
      saveReport()
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

const onTouchStart = () => {
  touching = true
}
const onTouchMove = () => {
  lastMoveAt = performance.now()
}
const onTouchEnd = (e) => {
  touching = e.touches.length > 0
  if (e.type === 'touchend' && performance.now() - lastMoveAt > MOVE_HOLD_MS) {
    lastTapAt = e.timeStamp
    noteFrameEvent(describeTarget(e.target))
  }
}
let unsubscribeTrack = null
const onScroll = () => {
  lastScrollAt = performance.now()
}
const onHide = () => {
  if (document.hidden) saveReport()
}

function start() {
  if (running) return
  running = true
  loadReport()
  // scroll не всплывает — ловим на погружении, чтобы видеть прокрутку
  // вложенных контейнеров экранов, а не только документа.
  document.addEventListener('scroll', onScroll, { capture: true, passive: true })
  document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true })
  document.addEventListener('touchmove', onTouchMove, { capture: true, passive: true })
  document.addEventListener('touchend', onTouchEnd, { capture: true, passive: true })
  document.addEventListener('touchcancel', onTouchEnd, { capture: true, passive: true })
  document.addEventListener('click', onClick, { capture: true, passive: true })
  document.addEventListener('visibilitychange', onHide)
  unsubscribeTrack = usePlayerStore.subscribe((state, prev) => {
    if (state.currentTrack?.id !== prev.currentTrack?.id) noteFrameEvent('трек')
  })
  loop()
}

function stop() {
  if (!running) return
  running = false
  saveReport()
  document.removeEventListener('scroll', onScroll, { capture: true })
  document.removeEventListener('touchstart', onTouchStart, { capture: true })
  document.removeEventListener('touchmove', onTouchMove, { capture: true })
  document.removeEventListener('touchend', onTouchEnd, { capture: true })
  document.removeEventListener('touchcancel', onTouchEnd, { capture: true })
  document.removeEventListener('click', onClick, { capture: true })
  document.removeEventListener('visibilitychange', onHide)
  unsubscribeTrack?.()
  unsubscribeTrack = null
  recentEvents = []
  probe = null
}

export function isFrameMeterEnabled() {
  return readEnabled()
}

export function setFrameMeterEnabled(enabled) {
  try {
    if (enabled) localStorage.setItem(ENABLED_KEY, '1')
    else localStorage.removeItem(ENABLED_KEY)
  } catch {
    /* без хранилища замер просто не переживёт перезапуск */
  }
  if (enabled) start()
  else stop()
}

// Вызывается на старте приложения: включённый замер продолжает работу.
export function installFrameMeter() {
  if (typeof window === 'undefined' || typeof requestAnimationFrame !== 'function') return
  if (readEnabled()) start()
}

export function clearFrameMeter() {
  stats = {}
  worst = []
  reactions = {}
  startedAt = Date.now()
  try {
    localStorage.removeItem(REPORT_KEY)
  } catch {
    /* нечего удалять */
  }
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]

function formatReactions() {
  const rows = Object.entries(reactions).filter(([, list]) => list.length)
  if (!rows.length) return []
  const lines = ['', 'Отклик, тап → кадр с реакцией (+~16 мс до экрана):', 'действие | раз | медиана | p90 | худший']
  rows.forEach(([name, list]) => {
    const sorted = [...list].sort((a, b) => a - b)
    lines.push(
      `${name} | ${sorted.length} | ${percentile(sorted, 0.5)}мс | ${percentile(sorted, 0.9)}мс | ${sorted[sorted.length - 1]}мс`,
    )
  })
  return lines
}

const pct = (part, whole) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : '—')

export function formatFrameMeter() {
  if (running) saveReport()
  else loadReport()
  const rows = Object.entries(stats).filter(([, s]) => s.frames >= 30)
  if (!rows.length) return formatReactions().join('\n').trim()
  const total = rows.reduce(
    (acc, [, s]) => ({ frames: acc.frames + s.frames, janky: acc.janky + s.janky, missed: acc.missed + s.missed }),
    { frames: 0, janky: 0, missed: 0 },
  )
  const minutes = ((Date.now() - startedAt) / 60000).toFixed(1)
  let tier = '0'
  try {
    tier = sessionStorage.getItem('grainient-tier') || '0'
  } catch {
    /* неизвестно */
  }
  const lite = document.documentElement.classList.contains('lite-mode') ? 'да' : 'нет'
  const lines = [
    `Замер ${minutes} мин, ${screen.width}×${screen.height}@${window.devicePixelRatio}, лёгкий режим: ${lite}, уровень фона: ${tier}`,
    `Всего: ${total.frames} кадров, рывков ${pct(total.janky, total.frames)}, пропущено кадров ${pct(total.missed, total.frames + total.missed)}`,
    '',
    'ситуация | кадров | рывков | пропущено | >50мс | худший',
  ]
  rows
    .sort((a, b) => b[1].missed - a[1].missed)
    .forEach(([key, s]) => {
      lines.push(
        `${key} | ${s.frames} | ${pct(s.janky, s.frames)} | ${pct(s.missed, s.frames + s.missed)} | ${s.long} | ${s.worst}мс`,
      )
    })
  lines.push(...formatReactions())
  if (worst.length) {
    lines.push('', 'Самые долгие кадры:')
    worst.forEach((w) => {
      const time = new Date(w.at).toTimeString().slice(0, 8)
      lines.push(`${time} ${w.ms}мс ${w.ctx}${w.ev ? ` ← ${w.ev}` : ''}`)
    })
  }
  return lines.join('\n')
}
