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
import { PRESSABLE, SCROLLABLE } from '../services/pressFeedback'
import { isFastTapClick } from '../services/fastTap'

// id фоновых анимаций воспроизведения (полосы прогресса, диск): они идут в
// каждом кадре, пока играет музыка, и в разбор рывков не попадают.
export const PLAYBACK_ANIMATION_ID = 'playback'

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
// Рендеры частей интерфейса (MeterProfiler): сколько раз и сколько времени.
let renders = {}
// Что анимировалось на видимом экране в кадрах с рывком: имя → число кадров.
let jankAnims = {}
let startedAt = 0
let lastSavedAt = 0

let touching = false
let lastMoveAt = 0
let lastScrollAt = 0

// Недавние события (смена трека, события плеера из diag, тапы) — чтобы у
// долгого кадра было видно, что его запустило. Хранится последняя секунда.
const EVENT_WINDOW_MS = 1000
const EVENTS_PER_FRAME = 6
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

// Тап по частям: доставка (палец отпущен → клик дошёл до документа),
// обработчики (все слушатели клика, включая React), ожидание кадра (от конца
// обработчиков до rAF — сюда попадает рендер, если React отложил его, и
// чужая работа в очереди). Конец обработчиков ловит слушатель на window в
// фазе всплытия: он срабатывает последним, после корня React.
let pendingTap = null

const onClick = (e) => {
  // Служебные клики (свитч тактильного отклика в haptics.js и т.п.) — не тап.
  // Быстрый тап (services/fastTap) — тап, хоть и не isTrusted.
  const fast = isFastTapClick()
  if (!e.isTrusted && !fast) return
  const now = performance.now()
  const fromTouch = now - lastTapAt < TAP_CLICK_WINDOW_MS
  const t0 = fromTouch ? lastTapAt : e.timeStamp
  // Тип цели — проверить, держит ли клик анимация нажатия (pressFeedback):
  // в списке она стартует с задержкой, вне списка — сразу на касании.
  const pressable = e.target instanceof Element ? e.target.closest(PRESSABLE) : null
  const kind = fast
    ? 'быстрый тап'
    : !pressable
      ? 'не кнопка'
      : pressable.closest(SCROLLABLE)
        ? 'кнопка в списке'
        : 'кнопка вне списка'
  const tap = { t0, dispatchAt: now, handledAt: 0, kind, fast }
  pendingTap = tap
  // Итог пишем в кадре, а не в onClickDone: обработчик мог остановить
  // всплытие, и тогда до window клик не дойдёт — без разбивки, но тап учтём.
  requestAnimationFrame((frame) => {
    if (pendingTap === tap) pendingTap = null
    noteReaction('тап', frame - t0)
    // Быстрый тап (services/fastTap) отсчитывается от отпускания пальца, а
    // доставки клика у него нет — её он и убирает.
    if (fast) noteReaction('тап: быстрый, отпускание → кадр', frame - t0)
    if (!tap.handledAt) return
    if (fromTouch) {
      noteReaction('тап: доставка клика', tap.dispatchAt - t0)
      noteReaction(`тап: доставка, ${tap.kind}`, tap.dispatchAt - t0)
    }
    noteReaction('тап: обработчики', tap.handledAt - tap.dispatchAt)
    noteReaction('тап: ожидание кадра', frame - tap.handledAt)
  })
  const next = e.target instanceof Element ? probeFor(e.target) : null
  if (next) probe = { ...next, t0 }
}

const onClickDone = (e) => {
  if (pendingTap && (e.isTrusted || pendingTap.fast)) pendingTap.handledAt = performance.now()
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

// Рендеры короче этого не пишем: они не делают кадр долгим, а забивают
// список событий у долгих кадров.
const RENDER_NOTE_MS = 4

// onRender у <Profiler> (components/MeterProfiler). actualDuration — время
// рендера поддерева в этом коммите, включая вложенные компоненты, которые
// перерисовались сами (подписки на стор).
export function noteRender(id, phase, actualDuration) {
  if (!running || actualDuration < RENDER_NOTE_MS) return
  const ms = Math.round(actualDuration)
  const entry = renders[id] || (renders[id] = { count: 0, total: 0, worst: 0 })
  entry.count += 1
  entry.total += ms
  if (ms > entry.worst) entry.worst = ms
  noteFrameEvent(`${id} ${ms}мс`)
}

// Отрезок синхронной работы вне рендера (эффекты плеера на смене трека).
export function noteSpan(name, ms) {
  if (!running || ms < RENDER_NOTE_MS) return
  noteRender(name, 'span', ms)
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
      renders = data.renders || {}
      jankAnims = data.jankAnims || {}
      startedAt = data.startedAt || Date.now()
      return
    }
  } catch {
    /* битый отчёт — начинаем заново */
  }
  stats = {}
  worst = []
  reactions = {}
  renders = {}
  jankAnims = {}
  startedAt = Date.now()
}

function saveReport() {
  try {
    localStorage.setItem(REPORT_KEY, JSON.stringify({ stats, worst, reactions, renders, jankAnims, startedAt }))
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

// Имена запущенных анимаций на видимом экране: CSS-анимации — по
// animationName, переходы — по свойству, остальное (Web Animations, в т.ч.
// pressFeedback) — по классу цели. Скрытые экраны стека пропускаем.
const ANIMS_PER_FRAME = 8

function runningAnimations() {
  if (typeof document.getAnimations !== 'function') return []
  const names = new Set()
  for (const anim of document.getAnimations()) {
    if (anim.playState !== 'running') continue
    // Полосы прогресса и диск идут в каждом кадре, пока играет музыка, — их
    // присутствие в кадре с рывком ничего не говорит (их ведёт композитор).
    if (anim.id === PLAYBACK_ANIMATION_ID) continue
    const target = anim.effect?.target
    if (target instanceof Element && target.closest('.screen:not([data-active])')) continue
    let name = anim.animationName || (anim.transitionProperty && `transition:${anim.transitionProperty}`)
    if (!name) {
      const cls = target instanceof Element && typeof target.className === 'string' ? target.className.split(' ')[0] : ''
      name = `js:${cls || target?.tagName?.toLowerCase() || '?'}`
    }
    names.add(name)
    if (names.size >= ANIMS_PER_FRAME) break
  }
  return [...names]
}

function noteJankAnimations() {
  for (const name of runningAnimations()) jankAnims[name] = (jankAnims[name] || 0) + 1
}

function record(delta, now) {
  const key = context(now)
  const entry = stats[key] || (stats[key] = { frames: 0, janky: 0, missed: 0, long: 0, worst: 0 })
  entry.frames += 1
  if (delta > JANK_MS) {
    entry.janky += 1
    entry.missed += Math.max(1, Math.round(delta / FRAME_MS) - 1)
    noteJankAnimations()
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
  window.addEventListener('click', onClickDone, { passive: true })
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
  window.removeEventListener('click', onClickDone)
  document.removeEventListener('visibilitychange', onHide)
  unsubscribeTrack?.()
  unsubscribeTrack = null
  recentEvents = []
  probe = null
  pendingTap = null
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
  renders = {}
  jankAnims = {}
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

function formatRenders() {
  const rows = Object.entries(renders).sort((a, b) => b[1].total - a[1].total)
  if (!rows.length) return []
  const lines = ['', `Рендеры и работа дольше ${RENDER_NOTE_MS} мс:`, 'часть | раз | всего | худший']
  rows.forEach(([id, r]) => lines.push(`${id} | ${r.count} | ${r.total}мс | ${r.worst}мс`))
  return lines
}

function formatJankAnims() {
  const rows = Object.entries(jankAnims).sort((a, b) => b[1] - a[1])
  if (!rows.length) return []
  const lines = ['', 'Что анимировалось в кадрах с рывком (видимый экран):', 'анимация | кадров с рывком']
  rows.slice(0, 15).forEach(([name, n]) => lines.push(`${name} | ${n}`))
  return lines
}

const pct = (part, whole) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : '—')

export function formatFrameMeter() {
  if (running) saveReport()
  else loadReport()
  const rows = Object.entries(stats).filter(([, s]) => s.frames >= 30)
  if (!rows.length) return [...formatReactions(), ...formatRenders(), ...formatJankAnims()].join('\n').trim()
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
  lines.push(...formatReactions(), ...formatRenders(), ...formatJankAnims())
  if (worst.length) {
    lines.push('', 'Самые долгие кадры:')
    worst.forEach((w) => {
      const time = new Date(w.at).toTimeString().slice(0, 8)
      lines.push(`${time} ${w.ms}мс ${w.ctx}${w.ev ? ` ← ${w.ev}` : ''}`)
    })
  }
  return lines.join('\n')
}
