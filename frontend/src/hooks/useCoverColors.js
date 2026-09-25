import { useEffect, useState } from 'react'
import { resolveCoverUrl } from '../utils/media'
import { SAMPLE, paletteFromPixels } from '../utils/coverColor'

// Хук отдаёт три цвета градиента hero под доминирующий тон обложки текущего
// трека. Возвращает null, пока цвета нет (обложка серая, ещё не загрузилась
// или canvas недоступен) — вызывающий в этом случае остаётся на дефолтной
// палитре.

// Результат разбора кэшируется по URL: треки ходят по кругу (поток, очередь,
// возврат назад), а разбор — это загрузка картинки и чтение пикселей.
// Ключ — тот же URL, что у <img> диска (resolveCoverUrl с highQuality), так
// что картинка берётся из кэша браузера и второй раз по сети не идёт.
// Хранится именно результат (done/hue), а не промис: разобранный цвет нужен
// синхронно, в том же рендере, где сменился трек (см. cachedPalette).
const hueCache = new Map()
const HUE_CACHE_LIMIT = 64

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
// drawImage — это и есть усреднение по ячейке.
function samplePixels(img) {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = SAMPLE
    canvas.height = SAMPLE
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
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
  if (!coverUrl) return
  cacheEntry(resolveCoverUrl(coverUrl, true))
}

export function useCoverColors(coverUrl) {
  const [colors, setColors] = useState(null)
  const src = coverUrl ? resolveCoverUrl(coverUrl, true) : null
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
