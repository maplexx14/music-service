import { useEffect, useState } from 'react'
import { resolveCoverUrl } from '../utils/media'
import { SAMPLE, paletteFromPixels } from '../utils/coverColor'

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

// URL обложки для разбора — БЕЗ апскейла CDN (resolveCoverUrl без highQuality).
// Для выборки 16×16 апскейл до 1200×1200 не нужен: он стоит лишней сетевой
// загрузки и тяжёлого декода на каждый трек, а на цвет не влияет. Обычный URL
// обложки — тот же, что у карточек треков на странице, так что чаще всего он
// уже в кэше браузера.
const sampleUrl = (coverUrl) => (coverUrl ? resolveCoverUrl(coverUrl) : null)

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

// Пиксели уменьшенной копии обложки. Уменьшение делает сам браузер при
// drawImage — это и есть усреднение по ячейке. Canvas один на модуль: разбор
// идёт на каждой смене трека, и заводить под него новый элемент с буфером
// каждый раз незачем.
let sampleCanvas = null

function samplePixels(img) {
  try {
    if (!sampleCanvas) {
      sampleCanvas = document.createElement('canvas')
      sampleCanvas.width = SAMPLE
      sampleCanvas.height = SAMPLE
    }
    const ctx = sampleCanvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE)
    return ctx.getImageData(0, 0, SAMPLE, SAMPLE).data
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
