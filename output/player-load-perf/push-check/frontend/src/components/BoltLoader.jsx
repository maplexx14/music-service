import heart from '../assets/loader-heart.webp'
import './BoltLoader.css'

const LEVELS = [0.45, 0.55, 0.65, 0.75, 0.85, 1]
const RIGHT_LEVELS = [...LEVELS].reverse()

// Match the launch splash: a stationary pulsing heart with a traveling sound wave.
function BoltLoader({ size = 32, frame = size * 3.2, active = true, className = '', style }) {
  return (
    <span
      className={`bolt-loader${active ? '' : ' is-idle'}${className ? ` ${className}` : ''}`}
      style={{ '--bl-size': `${size}px`, '--bl-frame': `${frame}px`, ...style }}
      aria-hidden="true"
    >
      {active ? (
        <span className="bolt-loader-wave">
          {LEVELS.map((level, i) => (
            <i key={i} className="bolt-loader-bar" style={{ '--level': level, '--i': i }} />
          ))}
          <img className="bolt-loader-heart" src={heart} alt="" draggable={false} />
          {RIGHT_LEVELS.map((level, i) => (
            <i key={i} className="bolt-loader-bar" style={{ '--level': level, '--i': LEVELS.length + i }} />
          ))}
        </span>
      ) : (
        <img className="bolt-loader-heart" src={heart} alt="" draggable={false} />
      )}
    </span>
  )
}

export default BoltLoader
