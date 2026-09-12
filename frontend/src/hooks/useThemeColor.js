import { useEffect, useRef } from 'react'

const DEFAULT_THEME_COLOR = '#252933'

let themeMeta = null

function getThemeMeta() {
  if (themeMeta) return themeMeta
  themeMeta = document.querySelector('meta[name="theme-color"]')
  return themeMeta
}

// Средний цвет обложки по даунскейлу: canvas 1x1 с imageSmoothing
// отрисовкой картинки даёт нам «доминирующий» цвет почти бесплатно
// (браузер сам усредняет пиксели при масштабировании). Взвешивать
// гистограмму незачем — для окраски статус-бара среднегармонического
// хватает, а кросс-доменные картинки в canvas и так опираются на CORS.
async function extractDominantColor(src) {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
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
        resolve(`rgb(${r}, ${g}, ${b})`)
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
// на десктопе) окрашивается в доминирующий цвет обложки — как это делают
// нативные музыкальные приложения. При размонтировании цвет возвращается.
// Тексты на статус-баре рисует ОС по яркости фона — специально затемнять
// цвет не пытаемся: у тёмной темы приложения он почти всегда тёмный.
export function useThemeColor(active, coverUrl) {
  const currentRef = useRef(DEFAULT_THEME_COLOR)

  useEffect(() => {
    if (!active) return undefined
    let cancelled = false

    extractDominantColor(coverUrl).then((color) => {
      if (cancelled || !color) return
      currentRef.current = color
      getThemeMeta()?.setAttribute('content', color)
    })

    return () => {
      cancelled = true
      getThemeMeta()?.setAttribute('content', DEFAULT_THEME_COLOR)
    }
  }, [active, coverUrl])
}
