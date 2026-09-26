// Автовыбор качества потока под канал клиента.
//
// Бэкенд умеет отдать тот же трек вдвое легче: ?quality=low — HE-AAC 64 kbps
// вместо AAC-LC 128 (см. backend/app/storage.py:ensure_low_variant_async). Но
// решение «просить ли» принимает только клиент: узкий канал виден здесь, а не
// на сервере. До этого модуля параметр не слал никто, и медленное устройство
// тянуло те же 128 kbps, что и Wi-Fi — на узком туннеле (~140 КБ/с) это ровно
// разница между стартом трека за пару секунд и за десятки секунд.
//
// Откуда берётся решение:
//   1) Network Information API (Chrome/Android/Firefox) — saveData,
//      effectiveType, downlink. Доступен сразу, до первого запроса. В
//      Safari/WebKit его нет вовсе, а это половина сессий, поэтому один он
//      не годится.
//   2) Измерения самой игры — работают везде. Долгий старт и перебуферизация
//      посреди трека означают, что канал не тянет текущий битрейт.
//
// Качество применяется на ГРАНИЦЕ трека (URL вшивается в момент сборки ссылки
// на стрим) и никогда не меняется посреди трека. Причины:
//   • низкий вариант собирается на первом запросе (ffmpeg на бэкенде, единицы
//     секунд) — перезагрузка посреди трека дала бы тишину ровно там, где мы
//     лечим;
//   • load() вне жеста на iOS рвёт аудиосессию и виджет на экране блокировки
//     (см. services/audioEngine.js) — цена ошибки выше выигрыша.
// Отсюда же следует, что измерение ухудшает качество для СЛЕДУЮЩЕГО трека, а
// не для играющего.

import { diag } from './playerDiag'

const STORAGE_KEY = 'stream_quality_v1'
// Запомненное измерение переживает перезагрузку: иначе после каждого запуска
// PWA медленное устройство заново платит за первый тяжёлый трек. TTL — чтобы
// «медленно» не осталось навсегда: сеть меняется, в том числе посреди дня.
const MEMORY_TTL_MS = 6 * 60 * 60 * 1000

// Модель — «долг медленного канала» (evidence, обычно ≤ 0):
//   • медленный старт копит долг, быстрый его гасит;
//   • перебуферизация ставит долг не меньше стартового независимо от накопленного
//     кредита: это самый прямой сигнал («канал не тянет уже играющий битрейт»), и
//     гасить его историей нельзя — история набрана в других условиях;
//   • кредит ограничен сверху: измерениям нужно уметь перебить пессимистичную
//     оценку сети (Chrome держит '3g' по своим эвристикам и на приличном канале),
//     но не настолько, чтобы им можно было прикрыть медленный канал; в памяти
//     кредит вообще не хранится — новая сессия начинается без него.
// Возврат к высокому — только при долге 0 и выше (см. UPGRADE_THRESHOLD): это и
// есть гистерезис, иначе качество мигало бы на каждом треке, а каждая смена
// стоит выброшенного прогрева и, на первом низком запросе, сборки варианта на
// бэкенде.
const FAST_START_MS = 2500
const SLOW_START_MS = 6000
// Дольше этого — не «медленный канал», а аномалия (холодный резолв провайдера,
// замороженная фоновая вкладка). В зачёт не идёт: одно такое наблюдение не
// должно переводить устройство на низкое качество.
const IGNORE_START_MS = 45000

const W_FAST = 1
const W_SLOW = -2
// Долг, который оставляет перебуферизация, — не меньше этого.
const STARVE_DEBT = -2
const SCORE_MIN = -3
const SCORE_MAX = 2
const LOW_THRESHOLD = -2
const UPGRADE_THRESHOLD = 0

// Эндпоинты, которые действительно читают ?quality (routers/tracks.py,
// ytdlp.py, soulseek.py). Список путей — он же и защита: провайдерские
// stream_url (jamendo и прочие прямые ссылки, у которых в query может лежать
// подпись) и /soundcloud/stream/{token} под шаблоны не подходят и остаются
// нетронутыми.
const QUALITY_AWARE = [
  /\/tracks\/\d+\/stream(?:$|[?&])/,
  /\/ytdlp\/stream\//,
  /\/soulseek\/stream\//,
]

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function readConnection() {
  if (typeof navigator === 'undefined') return null
  return navigator.connection || navigator.mozConnection || navigator.webkitConnection || null
}

// Оценка канала по Network Information API. Ноль — «API молчит» (Safari), и
// тогда решение целиком за измерениями.
function networkScore() {
  const conn = readConnection()
  if (!conn) return { score: 0, why: 'no-api', forced: false }
  // saveData — не оценка канала, а решение пользователя экономить трафик.
  // Измерения его не перебивают: на быстром Wi-Fi с включённой экономией
  // клиент всё равно должен получить лёгкий вариант.
  if (conn.saveData) return { score: 0, why: 'saveData', forced: true }
  const type = conn.effectiveType
  if (type === 'slow-2g' || type === '2g' || type === '3g') {
    // Ровно на порог: пессимистичная оценка сразу даёт низкое качество, но
    // измерения всё ещё могут её перебить (см. SCORE_MAX).
    return { score: -2, why: type, forced: false }
  }
  const downlink = Number(conn.downlink)
  if (Number.isFinite(downlink) && downlink > 0 && downlink < 2.5) {
    return { score: downlink < 1 ? -2 : -1, why: `downlink=${downlink}`, forced: false }
  }
  // Заявленный '4g' кредита не даёт: это лишь «не 3g», а решает измерение.
  return { score: 0, why: type || 'unknown', forced: false }
}

// Запомненное измерение. Сверху клампим нулём: положительное всё равно ни на
// что не влияет (по умолчанию качество высокое), а отрицательное ценно — на iOS
// это единственный способ не переучиваться после каждой перезагрузки.
function loadEvidence() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return 0
    const saved = JSON.parse(raw)
    if (!saved || Date.now() - Number(saved.at) > MEMORY_TTL_MS) return 0
    return clamp(Number(saved.score) || 0, SCORE_MIN, 0)
  } catch {
    return 0
  }
}

// Итоговый вердикт. Порог зависит от текущего состояния — это и есть гистерезис:
// выйти из низкого качества можно только по явно здоровому каналу, а не по краю
// того же порога, на котором в него вошли. Жёсткое решение (saveData) перебивает
// всё.
function derive() {
  if (network.forced) return true
  const total = network.score + evidence
  return low ? total < UPGRADE_THRESHOLD : total <= LOW_THRESHOLD
}

let evidence = loadEvidence()
let network = networkScore()
// Стартовое состояние считается по порогу ухудшения: предыдущего вердикта в этой
// сессии ещё нет, а из памяти приходит только отрицательное измерение.
let low = network.forced || network.score + evidence <= LOW_THRESHOLD
const listeners = new Set()

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ score: evidence, at: Date.now() }))
  } catch {
    /* приватный режим — выбор просто не переживёт перезагрузку */
  }
}

// Применяет текущее состояние к клиенту: подписчиков дёргаем только на смене
// вердикта (редкое событие), логируем — тоже. Наблюдения пишутся отдельно, в
// noteStartup/noteStarvation: иначе кольцевой лог диагностики забивался бы
// записями на каждый трек.
function apply(reason) {
  persist()
  const next = derive()
  if (next === low) return
  low = next
  diag('quality:change', {
    q: low ? 'low' : 'high',
    why: reason,
    net: network.why,
    ev: evidence,
  })
  for (const cb of listeners) {
    try {
      cb(low)
    } catch {
      /* подписчик не должен ломать само решение */
    }
  }
}

// Время от старта загрузки src до первого звука. Середина диапазона — не
// сигнал: медленный, но живой канал там не отличить от холодного резолва
// внешнего трека, а ложное «медленно» стоит дороже пропущенного наблюдения.
export function noteStartup(ms) {
  if (!Number.isFinite(ms) || ms < 0 || ms > IGNORE_START_MS) return
  if (ms > SLOW_START_MS) evidence = clamp(evidence + W_SLOW, SCORE_MIN, SCORE_MAX)
  else if (ms <= FAST_START_MS) evidence = clamp(evidence + W_FAST, SCORE_MIN, SCORE_MAX)
  else {
    diag('quality:note', { start: Math.round(ms), ev: evidence, skip: 'midrange' })
    return
  }
  diag('quality:note', { start: Math.round(ms), ev: evidence, q: low ? 'low' : 'high' })
  apply('startup')
}

// Перебуферизация посреди трека: канал не тянет даже тот битрейт, что уже играет.
export function noteStarvation() {
  evidence = clamp(Math.min(evidence, STARVE_DEBT), SCORE_MIN, SCORE_MAX)
  diag('quality:note', { starve: 1, ev: evidence, q: low ? 'low' : 'high' })
  apply('starvation')
}

// Подписка на смену вердикта. Возвращает функцию отписки (годится как возврат
// из useEffect).
export function subscribeQuality(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

// Дописывает ?quality=low к ссылке на свой стрим. Звать только для URL,
// которые собирает клиент; чужие ссылки отсекает QUALITY_AWARE.
export function withQuality(url) {
  if (!low || !url) return url
  if (url.includes('quality=')) return url
  if (!QUALITY_AWARE.some((re) => re.test(url))) return url
  return `${url}${url.includes('?') ? '&' : '?'}quality=low`
}

// Смена сети в Chrome/Android приходит событием — пересчитываем сразу, не
// дожидаясь следующего трека. На iOS события нет, там решение обновляют
// измерения.
const conn = readConnection()
if (conn?.addEventListener) {
  conn.addEventListener('change', () => {
    const prev = network
    network = networkScore()
    const delta = network.score - prev.score
    // Сеть сменилась в лучшую сторону — прежние измерения относились к другому
    // каналу. Гасим их, иначе переезд с 3G на Wi-Fi стоил бы ещё двух треков.
    if (delta >= 2) evidence = Math.ceil(evidence / 2)
    // В худшую — снимаем кредит: он набран на прежнем, быстром канале, а
    // заявленная деградация должна действовать сразу, а не после двух
    // запнувшихся треков.
    else if (delta <= -2) evidence = Math.min(evidence, 0)
    apply('connection')
  })
}
