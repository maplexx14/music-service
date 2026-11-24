import heart from '../assets/loader-heart.webp'
import './BoltLoader.css'

// Пульсирующее сердце с расходящимися кольцами (без эквалайзера).
function BoltLoader({ size = 32, frame = size * 3.2, active = true, className = '', style }) {
  return (
    <span
      className={`bolt-loader${active ? '' : ' is-idle'}${className ? ` ${className}` : ''}`}
      style={{ '--bl-size': `${size}px`, '--bl-frame': `${frame}px`, '--bl-heart': `url(${heart})`, ...style }}
      aria-hidden="true"
    >
      {active ? (
        <span className="bolt-loader-wave">
          <img className="bolt-loader-heart" src={heart} alt="" draggable={false} />
        </span>
      ) : (
        <img className="bolt-loader-heart" src={heart} alt="" draggable={false} />
      )}
    </span>
  )
}

export default BoltLoader
