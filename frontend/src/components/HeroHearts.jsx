import { useLayoutEffect, useRef, useState } from 'react'
import heart from '../assets/loader-heart.webp'
import './HeroHearts.css'

// Шаг сетки сердец в пикселях. Сетка от размера hero, а не в процентах:
// плотность узора одна и та же на телефоне и на широком мониторе.
const CELL = 76

// Детерминированный шум по индексу: узор не прыгает между рендерами.
function noise(i, salt) {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453
  return x - Math.floor(x)
}

function layout(width, height) {
  const cols = Math.ceil(width / CELL) + 1
  const rows = Math.ceil(height / CELL) + 1
  const hearts = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      // Ряды сдвинуты на полшага — шахматный узор, как звёзды на макете.
      const x = (c + (r % 2 ? 0.5 : 0)) * CELL + (noise(i, 1) - 0.5) * CELL * 0.35
      const y = r * CELL + (noise(i, 2) - 0.5) * CELL * 0.35
      hearts.push({
        x,
        y,
        s: 0.75 + noise(i, 3) * 0.4,
        a: (noise(i, 4) - 0.5) * 40,
      })
    }
  }
  return hearts
}

// Фон hero: тёмно-синее небо, засеянное контурами сердца из логотипа (той же
// картинкой, что у лайка в мини-плеере). Статичный: ни WebGL, ни анимаций —
// браузеру нечего перерисовывать.
function HeroHearts() {
  const ref = useRef(null)
  const [hearts, setHearts] = useState([])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let size = ''
    const update = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      // Пересчёт только когда меняется число клеток, а не на каждый пиксель.
      const key = `${Math.ceil(w / CELL)}x${Math.ceil(h / CELL)}`
      if (key === size) return
      size = key
      setHearts(layout(w, h))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div ref={ref} className="hero-hearts" aria-hidden="true" style={{ '--heart-img': `url(${heart})` }}>
      {hearts.map((h, i) => (
        <i
          key={i}
          className="hero-heart"
          style={{ transform: `translate(${h.x}px, ${h.y}px) translate(-50%, -50%) rotate(${h.a}deg) scale(${h.s})` }}
        />
      ))}
    </div>
  )
}

export default HeroHearts
