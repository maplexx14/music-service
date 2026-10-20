// Режим энергосбережения устройства. Прямо о нём не сообщает ни Safari, ни
// Chrome, но оба в нём урезают requestAnimationFrame ровно до 30 Гц: iOS и
// macOS — в «Режиме энергосбережения», Chrome — в Energy Saver. Это и ловим:
// короткий замер интервалов rAF на старте, при возврате на экран и изредка,
// пока страница видна, — режим включают и не уходя из приложения (Пункт
// управления, системный запрос на 20% заряда).
//
// Класс `power-save` на <html> и onPowerSaveChange гасят то, что крутится всё
// время, пока играет музыка: WebGL-фон главной встаёт на статичный кадр,
// диск и полоса прогресса идут шагами раз в секунду, эквалайзер в строке
// трека замирает, backdrop-filter уступает плотному фону (index.css). Юзер
// сам попросил систему экономить — без режима всё как было.
//
// Ложное срабатывание возможно на устройстве, которое и так не тянет 60
// кадров (главный поток стабильно занят), — ему облегчение тоже на пользу.

import { diag } from './playerDiag'

const CLASS_NAME = 'power-save'
// Результат на сессию вкладки, как детект GPU (utils/gpu.js): перезагрузка
// в режиме не должна сначала показывать тяжёлые эффекты, а потом их гасить.
const CACHE_KEY = 'power-save'
const SAMPLE_FRAMES = 30
// Старт и возврат на экран — это рендер, догрузка и медиасобытия: рывки там
// выглядели бы как урезанный rAF. Замер — после них.
const START_DELAY_MS = 3000
const RESUME_DELAY_MS = 1500
const RECHECK_MS = 2 * 60 * 1000
// Кадр 30-герцового rAF — 33.3 мс. Окно с запасом на дрожание, но уже 40 мс
// (25 Гц): дальше это не кап, а тормоза.
const CAPPED_MIN_MS = 28
const CAPPED_MAX_MS = 40
// Кап даёт ровный ряд, рывки — разброс. Выключаем по явно быстрым кадрам:
// в режиме их не бывает, а замер, попавший на рывок, состояние не меняет.
const CAPPED_SHARE = 0.7
const FAST_FRAME_MS = 22
const FAST_SHARE = 0.5

let active = false
let installed = false
let sampling = false
let resumeTimer = 0
const listeners = new Set()

function readCached() {
  try {
    return sessionStorage.getItem(CACHE_KEY) === '1'
  } catch {
    return false
  }
}

function setActive(next, why) {
  if (next === active) return
  active = next
  document.documentElement.classList.toggle(CLASS_NAME, active)
  try {
    sessionStorage.setItem(CACHE_KEY, active ? '1' : '0')
  } catch {
    // Storage недоступен — на перезагрузке просто замерим заново.
  }
  diag('power:save', { on: active, why })
  for (const cb of listeners) {
    try {
      cb(active)
    } catch {
      /* подписчик не должен ломать детект */
    }
  }
}

function sample() {
  if (sampling || document.hidden) return
  sampling = true
  const intervals = []
  let prev = null
  const tick = (t) => {
    // Ушли с экрана посреди замера — скрытой странице rAF не положен, и ряд
    // оборвался бы паузой.
    if (document.hidden) {
      sampling = false
      return
    }
    if (prev !== null) intervals.push(t - prev)
    prev = t
    if (intervals.length < SAMPLE_FRAMES) {
      requestAnimationFrame(tick)
      return
    }
    sampling = false
    const capped = intervals.filter((ms) => ms >= CAPPED_MIN_MS && ms <= CAPPED_MAX_MS).length
    const fast = intervals.filter((ms) => ms < FAST_FRAME_MS).length
    if (capped >= intervals.length * CAPPED_SHARE) setActive(true, 'raf30')
    else if (fast >= intervals.length * FAST_SHARE) setActive(false, 'raf')
  }
  requestAnimationFrame(tick)
}

export function isPowerSave() {
  return active
}

// Подписка на смену режима. Возвращает отписку (годится как возврат из
// useEffect и как subscribe для useSyncExternalStore).
export function onPowerSaveChange(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function installPowerSaveWatch() {
  if (installed || typeof window === 'undefined') return
  installed = true
  // До первого рендера, как класс no-gpu.
  if (readCached()) {
    active = true
    document.documentElement.classList.add(CLASS_NAME)
  }
  setTimeout(sample, START_DELAY_MS)
  document.addEventListener('visibilitychange', () => {
    clearTimeout(resumeTimer)
    if (!document.hidden) resumeTimer = setTimeout(sample, RESUME_DELAY_MS)
  })
  setInterval(sample, RECHECK_MS)
}
