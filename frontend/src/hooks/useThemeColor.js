import { useEffect, useState } from 'react'

const DEFAULT_THEME_COLOR = '#252933'

let themeMeta = null

function getThemeMeta() {
  if (themeMeta) return themeMeta
  themeMeta = document.querySelector('meta[name="theme-color"]')
  return themeMeta
}

// Средний цвет обложки по даунскейлу: canvas 1x1 с imageSmoothing
// отрисовкой картинки даёт нам «доминирующий» цвет почти бесплатно
// (браузер сам усредняет пиксели при масштабировании).
//
// crossOrigin ставим ТОЛЬКО для кросс-доменных URL (dev): canvas имеет
// право читать пиксели лишь с CORS-чистого изображения. Для same-origin
// (прод) атрибут не нужен и ВРЕДЕН: он переводит запрос в CORS-режим, а
// ответы с Vary: Origin (или просто разные режимы) браузер кэширует
// отдельными ячейками — обложка перекачивалась бы при каждом открытии
// плеера параллельно с обычным <img>.
function isCrossOriginUrl(src) {
  try {
    return new URL(src, window.location.origin).origin !== window.location.origin
  } catch {
    return false
  }
}

// Цвет обложки идёт фоном полноэкранного плеера под белым текстом, поэтому
// приглушаем его: светлую обложку затемняем так, чтобы яркость не превышала
// TINT_MAX_LUMA, тёмную не трогаем.
const TINT_MAX_LUMA = 0.32

function tint(r, g, b) {
  const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  const k = luma > TINT_MAX_LUMA ? TINT_MAX_LUMA / luma : 1
  const c = (v) => Math.round(v * k)
  return `rgb(${c(r)}, ${c(g)}, ${c(b)})`
}

async function extractDominantColor(src) {
  return new Promise((resolve) => {
    const img = new Image()
    if (isCrossOriginUrl(src)) img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 1
        canvas.height = 1
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) return resolve(null)
        ctx.imageSmoothingEnabled = true
        ctx.drawImage(img, 0, 0, 1, 1)
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
        resolve(tint(r, g, b))
      } catch {
        // tainted canvas / пустые данные — молча остаёмся на дефолте
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = src
  })
}

// Пока полноэкранный плеер открыт, статус-бар Android (и заголовок окна
// на десктопе) окрашивается в приглушённый цвет обложки — как это делают
// нативные музыкальные приложения. При размонтировании цвет возвращается.
// Тот же цвет хук возвращает (null — пока не посчитан): плеер красит им
// свой фон, и статус-бар сливается с ним.
export function useThemeColor(active, coverUrl) {
  const [color, setColor] = useState(null)

  useEffect(() => {
    if (!active) return undefined
    let cancelled = false

    extractDominantColor(coverUrl).then((next) => {
      if (cancelled || !next) return
      setColor(next)
      getThemeMeta()?.setAttribute('content', next)
    })

    return () => {
      cancelled = true
      getThemeMeta()?.setAttribute('content', DEFAULT_THEME_COLOR)
    }
  }, [active, coverUrl])

  return color
}
