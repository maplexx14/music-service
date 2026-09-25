import { useEffect, useState } from 'react'
import { resolveCoverUrl } from '../utils/media'
import { SAMPLE, dominantHue, paletteFromHue } from '../utils/coverColor'

// Хук отдаёт три цвета градиента hero под доминирующий тон обложки текущего
// трека. Возвращает null, пока цвета нет (обложка серая, ещё не загрузилась
// или canvas недоступен) — вызывающий в этом случае остаётся на дефолтной
// палитре.

// Результат разбора кэшируется по URL: треки ходят по кругу (поток, очередь,
// возврат назад), а разбор — это загрузка картинки и чтение пикселей.
// Ключ — тот же URL, что у <img> диска (resolveCoverUrl с highQuality), так
// что картинка берётся из кэша браузера и второй раз по сети не идёт.
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
  return dominantHue(samplePixels(img))
}

export function useCoverColors(coverUrl) {
  const [colors, setColors] = useState(null)

  useEffect(() => {
    if (!coverUrl) {
      setColors(null)
      return undefined
    }
    const src = resolveCoverUrl(coverUrl, true)
    let promise = hueCache.get(src)
    if (!promise) {
      promise = extractHue(src)
      if (hueCache.size >= HUE_CACHE_LIMIT) {
        hueCache.delete(hueCache.keys().next().value)
      }
      hueCache.set(src, promise)
    }

    // При смене трека прежний цвет НЕ сбрасывается: пока новый разбор не
    // доехал, фон остаётся в цвете предыдущей обложки — так смена трека не
    // мигает дефолтным фиолетовым.
    let cancelled = false
    promise.then((hue) => {
      if (cancelled) return
      setColors(hue == null ? null : paletteFromHue(hue))
    })
    return () => {
      cancelled = true
    }
  }, [coverUrl])

  return colors
}
