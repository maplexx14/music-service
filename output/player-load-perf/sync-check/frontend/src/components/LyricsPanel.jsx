import { createRef, PureComponent } from 'react'
import { usePlayerStore } from '../store/playerStore'
import { useLyrics, useActiveLyricIndex } from '../hooks/useLyrics'
import { AlignLeft } from '@/components/icons'
import BoltLoader from './BoltLoader'
import './LyricsPanel.css'

const LINE_TRANSITION = {
  duration: 360,
  easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
}
// Сколько держим ручной выбор строки, прежде чем вернуться к воспроизведению.
const SCROLL_HOLD_MS = 3200
// Один шаг прокрутки на колесо: нотики мыши прилетают пачками.
const WHEEL_STEP_MS = 220
const TOUCH_STEP_PX = 26

const centerOf = (props, state) => state.focus ?? props.activeIndex

class SyncedLyrics extends PureComponent {
  containerRef = createRef()
  animations = []
  state = { focus: null }
  holdTimer = 0
  lastWheelAt = 0
  touchY = null

  // Снимок до изменения DOM сохраняет промежуточные позиции при перемотке.
  getSnapshotBeforeUpdate(previous, previousState) {
    const { lines } = this.props
    const container = this.containerRef.current
    if (previous.lines !== lines || centerOf(previous, previousState) === centerOf(this.props, this.state) ||
        !container?.getClientRects().length) return null
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

  componentDidUpdate(previous, previousState, snapshot) {
    const { lines } = this.props
    const changed = previous.lines !== lines ||
      centerOf(previous, previousState) !== centerOf(this.props, this.state)
    if (!changed) return
    this.cancelAnimations()
    const container = this.containerRef.current
    if (
      !snapshot ||
      !container.animate ||
      document.documentElement.classList.contains('lite-mode') ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) return

    const direction = centerOf(this.props, this.state) > centerOf(previous, previousState) ? 1 : -1
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
    clearTimeout(this.holdTimer)
  }

  // Ручная прокрутка двигает окно из трёх строк. Раскладка остаётся прежней,
  // меняется только участок текста, а через паузу возвращается автоподстройка.
  scrollBy = (step) => {
    const { lines, activeIndex } = this.props
    if (!lines.length || !step) return
    const base = this.state.focus ?? activeIndex
    const next = Math.max(0, Math.min(lines.length - 1, base + step))
    clearTimeout(this.holdTimer)
    this.holdTimer = setTimeout(() => this.setState({ focus: null }), SCROLL_HOLD_MS)
    if (next !== base) this.setState({ focus: next })
  }

  onWheel = (event) => {
    const step = Math.sign(event.deltaY)
    if (!step) return
    const now = performance.now()
    if (now - this.lastWheelAt < WHEEL_STEP_MS) return
    this.lastWheelAt = now
    this.scrollBy(step)
  }

  onTouchStart = (event) => {
    this.touchY = event.touches[0]?.clientY ?? null
  }

  onTouchMove = (event) => {
    if (this.touchY == null) return
    const y = event.touches[0]?.clientY
    if (y == null) return
    const delta = this.touchY - y
    if (Math.abs(delta) < TOUCH_STEP_PX) return
    this.touchY = y
    this.scrollBy(Math.sign(delta))
  }

  onTouchEnd = () => { this.touchY = null }

  select = (line) => {
    clearTimeout(this.holdTimer)
    if (this.state.focus !== null) this.setState({ focus: null })
    this.props.seekTo(line.time, 'lyrics')
  }

  render() {
    const { lines } = this.props
    const center = centerOf(this.props, this.state)
    const firstVisibleIndex = Math.max(0, center - 1)
    return (
      <div
        className="lyrics-synced"
        ref={this.containerRef}
        onWheel={this.onWheel}
        onTouchStart={this.onTouchStart}
        onTouchMove={this.onTouchMove}
        onTouchEnd={this.onTouchEnd}
      >
        {lines.slice(firstVisibleIndex, center + 2).map((line, offset) => {
          const index = firstVisibleIndex + offset
          return (
            <div
              key={`${index}-${line.time}`}
              data-line-index={index}
              className={`lyrics-line ${index === center ? 'active' : ''} ${index < center ? 'sung' : ''}`}
              onClick={() => this.select(line)}
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
  const guestMode = usePlayerStore((state) => state.guestMode)
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const currentTime = usePlayerStore((s) => s.currentTime)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const seekTo = usePlayerStore((s) => s.seekTo)
  const { syncedLines, plainText, loading, error, retry } = useLyrics(guestMode ? null : currentTrack)
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
