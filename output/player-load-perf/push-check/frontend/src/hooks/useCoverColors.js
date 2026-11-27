import { useEffect, useState } from 'react'
import { resolveCoverUrl } from '../utils/media'
import { SAMPLE, boxDownsample, paletteFromPixels } from '../utils/coverColor'

// Хук отдаёт три цвета градиента hero по обложке текущего трека. Возвращает
// null, только когда цвета взять неоткуда (обложка не загрузилась или canvas
// недоступен) — вызывающий в этом случае остаётся на дефолтной палитре.
// Ч/б и чёрные обложки дают свою палитру (см. neutralPalette в utils/coverColor).

// Результат разбора кэшируется по URL: треки ходят по кругу (поток, очередь,
// возврат назад), а разбор — это загрузка картинки и чтение пикселей.
// Хранится именно результат (done/colors), а не промис: разобранный цвет нужен
// синхронно, в том же рендере, где сменился трек (см. cachedColors).
const hueCache = new Map()
const HUE_CACHE_LIMIT = 64

// URL обложки для разбора — самый мелкий вариант (thumb). Для выборки 16×16
// крупнее не нужно: лишний размер — это лишняя загрузка ровно в момент старта
// трека, когда канал нужен звуку, а на цвет он не влияет. Thumb — тот же URL,
// что у строк списков и мини-плеера, так что чаще всего он уже в кэше.
const sampleUrl = (coverUrl) => (coverUrl ? resolveCoverUrl(coverUrl, 'thumb') : null)

function isCrossOrigin(src) {
  try {
    return new URL(src, window.location.origin).origin !== window.location.origin
  } catch {
    return false
  }
}

function loadCoverImage(src) {
  return new Promise((resolve) => {
    const img = new Image()
    // crossOrigin ставим ТОЛЬКО для чужого origin (dev): читать пиксели
    // canvas имеет право лишь с CORS-чистой картинки, а в проде обложка идёт
    // через наш прокси и своего origin. Лишний атрибут там вреден — он
    // переводит запрос в CORS-режим и разводит ячейки кэша с обычным <img>,
    // из-за чего обложка качалась бы дважды.
    if (isCrossOrigin(src)) img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = src
  })
}

// Пиксели уменьшенной копии обложки. Картинку рисуем почти в натуральном
// размере (thumb — 120-300px, потолок SOURCE_MAX), а в сетку SAMPLE×SAMPLE
// усредняем сами (boxDownsample): drawImage при сжатии в разы не усредняет, а
// выбирает отдельные пиксели, и тон фона зависел от случайных мазков.
// Canvas один на модуль: разбор идёт на каждой смене трека, и заводить под
// него новый элемент с буфером каждый раз незачем.
const SOURCE_MAX = 128
let sampleCanvas = null

function samplePixels(img) {
  try {
    const nw = img.naturalWidth || SAMPLE
    const nh = img.naturalHeight || SAMPLE
    const scale = Math.min(1, SOURCE_MAX / Math.max(nw, nh))
    const w = Math.max(SAMPLE, Math.round(nw * scale))
    const h = Math.max(SAMPLE, Math.round(nh * scale))
    if (!sampleCanvas) sampleCanvas = document.createElement('canvas')
    if (sampleCanvas.width !== w) sampleCanvas.width = w
    if (sampleCanvas.height !== h) sampleCanvas.height = h
    const ctx = sampleCanvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, w, h)
    return boxDownsample(ctx.getImageData(0, 0, w, h).data, w, h)
  } catch {
    // Обложка с чужого origin без CORS-заголовков «портит» canvas, и
    // getImageData бросает. Фон — украшение: молча остаёмся на дефолте.
    return null
  }
}

async function extractHue(src) {
  const img = await loadCoverImage(src)
  if (!img) return null
  return paletteFromPixels(samplePixels(img))
}

// Запись кэша: { done, colors, promise }. colors — палитра или null.
function cacheEntry(src) {
  let entry = hueCache.get(src)
  if (entry) return entry
  entry = { done: false, colors: null, promise: null }
  entry.promise = extractHue(src).then((colors) => {
    entry.colors = colors
    entry.done = true
    return colors
  })
  if (hueCache.size >= HUE_CACHE_LIMIT) {
    hueCache.delete(hueCache.keys().next().value)
  }
  hueCache.set(src, entry)
  return entry
}

// Готовая палитра, если обложка уже разобрана, — синхронно, в этом же рендере.
// undefined означает «разбор ещё идёт»: тогда хук отдаёт цвет предыдущего
// трека, чтобы смена трека не мигала дефолтным фиолетовым.
function cachedColors(src) {
  const entry = hueCache.get(src)
  if (!entry || !entry.done) return undefined
  return entry.colors
}

// Прогрев разбора обложки трека, который заиграет следующим. Разбор — это
// загрузка картинки и чтение пикселей, то есть заметная задержка: без прогрева
// фон менялся бы уже после старта трека, и на быстрых переключениях цвет
// отставал бы на трек. Кладём в тот же кэш, поэтому сама смена трека берёт
// готовую палитру синхронно.
export function prefetchCoverColors(coverUrl) {
  const src = sampleUrl(coverUrl)
  if (!src) return
  cacheEntry(src)
}

export function useCoverColors(coverUrl) {
  const [colors, setColors] = useState(null)
  const src = sampleUrl(coverUrl)
  // Разобранный цвет отдаётся сразу, не дожидаясь эффекта: обложка могла быть
  // разобрана раньше (возврат к треку, повтор в потоке), а промис кэша может
  // резолвиться уже после того, как трек сменился, — и тогда результат
  // отбрасывался, а фон оставался от предыдущего трека.
  const ready = src ? cachedColors(src) : null

  useEffect(() => {
    if (!src) {
      setColors(null)
      return undefined
    }
    let cancelled = false
    cacheEntry(src).promise.then((next) => {
      if (cancelled) return
      setColors(next)
    })
    return () => {
      cancelled = true
    }
  }, [src])

  return ready === undefined ? colors : ready
}
