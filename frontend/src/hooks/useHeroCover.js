import { useEffect, useState } from 'react'
import { analyzeHeroCover, getHeroCover, guessHeroCover } from '../utils/heroCover'

// Обложка во весь верх экрана вместо квадрата (utils/heroCover): у
// полноэкранного плеера и у шапок страниц (CoverBackdrop). Экран
// открывается сразу в нужной раскладке: по готовому ответу, а если
// обложку ещё не проверяли — по догадке от источника. На смене обложки,
// пока новую не проверили, держим прежний ответ: фон не мигает пустотой,
// а раскладка не прыгает туда-обратно.
export function useHeroCover(url) {
  const [hero, setHero] = useState(() => {
    const known = getHeroCover(url)
    return known !== undefined ? known : guessHeroCover(url)
  })
  useEffect(() => {
    if (!url) {
      setHero(null)
      return undefined
    }
    const known = getHeroCover(url)
    if (known !== undefined) {
      setHero(known)
      return undefined
    }
    let cancelled = false
    analyzeHeroCover(url).then((result) => {
      if (!cancelled) setHero(result)
    })
    return () => {
      cancelled = true
    }
  }, [url])
  return hero
}

// Срез чёрных полей: картинка выше рамки на их долю и сдвинута вверх на
// верхнее — поля уходят за край (у рамки overflow: hidden).
// Подложка — миниатюра из кэша: пока большая качается, на её месте та же
// картинка, только мягче, а не пустой фон.
export function heroImageStyle(cover) {
  const style = cover.thumb ? { backgroundImage: `url("${cover.thumb}")` } : {}
  const visible = 1 - (cover.top || 0) - (cover.bottom || 0)
  if (visible < 1) {
    style.top = `${(-cover.top / visible) * 100}%`
    style.bottom = 'auto'
    style.height = `${100 / visible}%`
  }
  return style
}
