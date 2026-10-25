// Обложка во весь верх полноэкранного плеера (hero): подходит ли картинка и
// сколько срезать вшитых чёрных полей. Ответ по URL запоминается — плеер
// открывают снова и снова на тех же треках, и с готовым ответом он сразу
// открывается в нужной раскладке, а не перестраивается после загрузки.

// Только квадратные и не мельче HERO_MIN_SIDE: превью клипа 16:9 на весь
// экран режется, мелкая картинка мылится — для них остаётся карусель.
const HERO_MIN_SIDE = 400

// Чёрные поля, вшитые в саму картинку: YouTube Music отдаёт кадр клипа,
// вписанный в квадрат, — сверху и снизу чёрные полосы. На весь экран
// верхняя полоса легла бы под шапку чёрной лентой. Ищем по уменьшенной
// копии строки, где все пиксели почти чёрные; не больше четверти с края.
const LETTERBOX_SAMPLE = 64
const LETTERBOX_MAX_CHANNEL = 24

const HERO_CACHE_MAX = 300
const results = new Map()
const pending = new Map()

function findLetterbox(img) {
  const n = LETTERBOX_SAMPLE
  try {
    const canvas = document.createElement('canvas')
    canvas.width = n
    canvas.height = n
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return { top: 0, bottom: 0 }
    ctx.drawImage(img, 0, 0, n, n)
    const data = ctx.getImageData(0, 0, n, n).data
    const isBar = (y) => {
      for (let x = 0; x < n; x++) {
        const i = (y * n + x) * 4
        if (Math.max(data[i], data[i + 1], data[i + 2]) > LETTERBOX_MAX_CHANNEL) return false
      }
      return true
    }
    let top = 0
    while (top < n / 4 && isBar(top)) top++
    let bottom = 0
    while (bottom < n / 4 && isBar(n - 1 - bottom)) bottom++
    // Граничная строка уменьшенной копии смешивает поле с картинкой и уже
    // не «чёрная», а край поля размыт сжатием JPEG: без запаса в две строки
    // от поля оставалась полоска (8px, потом 1px).
    const pad = (rows) => (rows ? rows + 2 : 0) / n
    return { top: pad(top), bottom: pad(bottom) }
  } catch {
    // Пиксели не прочитать (картинка с чужого домена без CORS) — без обрезки.
    return { top: 0, bottom: 0 }
  }
}

// Пиксели читаются только с картинки своего домена или с CORS-запросом.
// crossOrigin — только для чужого домена (dev): для своего он перевёл бы
// запрос в CORS-режим, и браузер скачал бы обложку второй раз мимо кэша
// обычного <img> (см. useThemeColor).
function isCrossOrigin(src) {
  try {
    return new URL(src, window.location.origin).origin !== window.location.origin
  } catch {
    return false
  }
}

function remember(url, result) {
  results.delete(url)
  results.set(url, result)
  if (results.size > HERO_CACHE_MAX) results.delete(results.keys().next().value)
}

// Готовый ответ: { url, top, bottom } — подходит, null — нет, undefined —
// ещё не проверяли.
export function getHeroCover(url) {
  return url ? results.get(url) : null
}

// Догадка до проверки. Превью видео YouTube (i.ytimg.com) всегда 16:9 —
// сразу нет; остальные источники отдают квадратные обложки — сразу да,
// без обрезки полей (её досчитает проверка).
export function guessHeroCover(url) {
  if (!url || decodeURIComponent(url).includes('ytimg.com')) return null
  return { url, top: 0, bottom: 0 }
}

// Скачивает и декодирует обложку, проверяет размер и ищет поля. Повторный
// вызов того же URL ждёт тот же запрос.
export function analyzeHeroCover(url) {
  if (!url) return Promise.resolve(null)
  if (results.has(url)) return Promise.resolve(results.get(url))
  if (pending.has(url)) return pending.get(url)
  const promise = new Promise((resolve) => {
    const img = new Image()
    if (isCrossOrigin(url)) img.crossOrigin = 'anonymous'
    const finish = (result, cache = true) => {
      pending.delete(url)
      if (cache) remember(url, result)
      resolve(result)
    }
    img.onload = () => {
      const w = img.naturalWidth
      const h = img.naturalHeight
      const ok = Math.min(w, h) >= HERO_MIN_SIDE && Math.abs(w / h - 1) < 0.05
      const done = () => finish(ok ? { url, ...findLetterbox(img) } : null)
      if (typeof img.decode === 'function') img.decode().then(done, done)
      else done()
    }
    // Сеть моргнула — не запоминаем, в следующий раз проверим снова.
    img.onerror = () => finish(null, false)
    img.src = url
  })
  pending.set(url, promise)
  return promise
}
