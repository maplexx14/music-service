import heart from '../assets/loader-heart.webp'
import './BoltLoader.css'

// Порядок вылета: соседние молнии расходятся минимум на 60°, чтобы веер
// не бил в одно место. a — направление, spin — доворот в полёте, v — форма
// спрайта, k — масштаб.
const BOLTS = [
  { a: 20, spin: -15, v: 1, k: 0.9 },
  { a: 160, spin: 20, v: 2, k: 1.1 },
  { a: 290, spin: -10, v: 3, k: 0.85 },
  { a: 85, spin: 25, v: 1, k: 1 },
  { a: 225, spin: -20, v: 2, k: 1.05 },
]

// Лоадер в стиле логотипа: из сердца веером вылетают молнии (как на
// заставке в index.html). Чистый CSS — на экране их бывает несколько сразу.
// size — сердце, frame — рамка полёта: молнии гаснут у её края и не
// вылезают за неё на соседний текст и обложки.
// active={false} — сердце без молний (pull-to-refresh до отпускания).
function BoltLoader({ size = 32, frame = size * 2, active = true, className = '', style }) {
  return (
    <span
      className={`bolt-loader${active ? '' : ' is-idle'}${className ? ` ${className}` : ''}`}
      style={{ '--bl-size': `${size}px`, '--bl-frame': `${frame}px`, ...style }}
      aria-hidden="true"
    >
      {active && BOLTS.map((b, i) => (
        <i
          key={i}
          className={`bolt-loader-bolt v${b.v}`}
          style={{ '--a': `${b.a}deg`, '--spin': `${b.spin}deg`, '--k': b.k, '--i': i }}
        />
      ))}
      <img className="bolt-loader-heart" src={heart} alt="" draggable={false} />
    </span>
  )
}

export default BoltLoader
