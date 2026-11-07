import { createRef, PureComponent } from 'react'
import { usePlayerStore } from '../store/playerStore'
import { useLyrics, useActiveLyricIndex } from '../hooks/useLyrics'
import { AlignLeft } from 'lucide-react'
import BoltLoader from './BoltLoader'
import './LyricsPanel.css'

const LINE_TRANSITION = {
  duration: 360,
  easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
}

class SyncedLyrics extends PureComponent {
  containerRef = createRef()
  animations = []

  // Снимок до изменения DOM сохраняет и промежуточные позиции при перемотке.
  getSnapshotBeforeUpdate(previous) {
    const { lines, activeIndex } = this.props
    const container = this.containerRef.current
    if (previous.lines !== lines || previous.activeIndex === activeIndex || !container.getClientRects().length) return null
    return new Map(Array.from(container.children, (element) => {
      const style = getComputedStyle(element)
      return [element.dataset.lineIndex, {
        rect: element.getBoundingClientRect(),
        opacity: style.opacity,
        visible: style.visibility === 'visible',
      }]
    }))
  }

  cancelAnimations = () => {
    this.animations.forEach((animation) => animation.cancel())
    this.animations = []
  }

  componentDidUpdate(previous, _state, snapshot) {
    const { lines, activeIndex } = this.props
    if (previous.lines === lines && previous.activeIndex === activeIndex) return
    this.cancelAnimations()
    const container = this.containerRef.current
    if (
      !snapshot ||
      !container.animate ||
      document.documentElement.classList.contains('lite-mode') ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) return

    const direction = activeIndex > previous.activeIndex ? 1 : -1
    const gap = parseFloat(getComputedStyle(container).rowGap) || 0
    // Сначала измеряем все строки, затем запускаем только transform/opacity.
    const positions = Array.from(container.children, (element) => {
      const style = getComputedStyle(element)
      return {
        element,
        rect: element.getBoundingClientRect(),
        before: snapshot.get(element.dataset.lineIndex),
        transform: style.transform,
        visible: style.visibility === 'visible',
      }
    }).filter(({ visible }) => visible)
    this.animations = positions.map(({ element, rect, before: snapshotLine, transform }) => {
      const before = snapshotLine?.visible ? snapshotLine : null
      const x = before ? before.rect.left + before.rect.width / 2 - rect.left - rect.width / 2 : 0
      const y = before
        ? before.rect.top + before.rect.height / 2 - rect.top - rect.height / 2
        : direction * (snapshotLine ? 12 : rect.height + gap)
      const scale = before && rect.width ? before.rect.width / rect.width : 1
      return element.animate([
        { transform: `translate(${x}px, ${y}px) scale(${scale}) ${transform}`, opacity: before?.opacity ?? 0 },
        { transform, opacity: 1 },
      ], LINE_TRANSITION)
    })
  }

  componentWillUnmount() {
    this.cancelAnimations()
  }

  render() {
    const { lines, activeIndex, seekTo } = this.props
    const firstVisibleIndex = Math.max(0, activeIndex - 1)
    return (
      <div className="lyrics-synced" ref={this.containerRef}>
        {lines.slice(firstVisibleIndex, activeIndex + 2).map((line, offset) => {
          const index = firstVisibleIndex + offset
          return (
            <div
              key={`${index}-${line.time}`}
              data-line-index={index}
              className={`lyrics-line ${index === activeIndex ? 'active' : ''} ${index < activeIndex ? 'sung' : ''}`}
              style={{ gridRow: index - activeIndex + 2 }}
              onClick={() => seekTo(line.time, 'lyrics')}
              role="button"
              tabIndex={0}
            >
              {line.text}
            </div>
          )
        })}
      </div>
    )
  }
}

function LyricsPanel({ isolateTouches = false }) {
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const currentTime = usePlayerStore((s) => s.currentTime)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const seekTo = usePlayerStore((s) => s.seekTo)
  const { syncedLines, plainText, loading, error, retry } = useLyrics(currentTrack)
  const activeIndex = useActiveLyricIndex(syncedLines, currentTime, isPlaying)
  const hasLyrics = syncedLines.length > 0 || plainText.length > 0
  const isSynced = syncedLines.length > 0
  const stopSwipe = isolateTouches ? (event) => event.stopPropagation() : undefined

  if (!currentTrack) return null

  if (loading) {
    return (
      <div className="lyrics-panel">
        <div className="lyrics-empty">
          <BoltLoader size={32} frame={80} />
          <div className="lyrics-empty-text">Поиск текста...</div>
        </div>
      </div>
    )
  }

  if (!hasLyrics) {
    return (
      <div className="lyrics-panel">
        <div className="lyrics-empty">
          <AlignLeft size={32} strokeWidth={1.5} />
          <div className="lyrics-empty-text">{error ? 'Не удалось загрузить текст' : 'Текст не найден'}</div>
          {error && <button type="button" className="lyrics-retry" onClick={retry}>Повторить</button>}
        </div>
      </div>
    )
  }

  return (
    <div
      className={`lyrics-panel${isSynced ? ' is-synced' : ''}`}
      onTouchStart={stopSwipe}
      onTouchMove={stopSwipe}
      onTouchEnd={stopSwipe}
    >
      {isSynced ? (
        <SyncedLyrics lines={syncedLines} activeIndex={activeIndex} seekTo={seekTo} />
      ) : (
        <div className="lyrics-plain">
          {plainText.split('\n').map((line, i) => (
            <div key={i} className="lyrics-line">{line || '\u00A0'}</div>
          ))}
        </div>
      )}
    </div>
  )
}

export { LyricsPanel }
export default LyricsPanel

