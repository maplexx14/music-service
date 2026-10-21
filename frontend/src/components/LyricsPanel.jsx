import { useRef, useEffect, useState } from 'react'
import { usePlayerStore } from '../store/playerStore'
import { useLyrics, useActiveLyricIndex } from '../hooks/useLyrics'
import { AlignLeft } from 'lucide-react'
import BoltLoader from './BoltLoader'
import './LyricsPanel.css'

function LyricsPanel({ isolateTouches = false }) {
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const currentTime = usePlayerStore((s) => s.currentTime)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const seekTo = usePlayerStore((s) => s.seekTo)
  const { syncedLines, plainText, loading } = useLyrics(currentTrack)
  const containerRef = useRef(null)
  const activeRef = useRef(null)
  const [isUserScrolling, setIsUserScrolling] = useState(false)
  const userScrollTimeoutRef = useRef(null)

  const activeIndex = useActiveLyricIndex(syncedLines, currentTime, isPlaying)
  const hasLyrics = syncedLines.length > 0 || plainText.length > 0
  const isSynced = syncedLines.length > 0

  // scroll приходит и от нашего же scrollTo: плавная доводка шлёт события
  // ~полсекунды, и раньше каждая смена строки сама выключала автопрокрутку
  // на 4 с. На частых строках подсвеченная уезжала вниз, к краю и за край, и
  // текст «отставал» от музыки. Ручной считаем только прокрутку после
  // касания, колеса, нажатия или клавиши; автопрокрутка этот флаг сбрасывает.
  const userInputRef = useRef(false)
  const markUserInput = () => {
    userInputRef.current = true
  }
  const stopSwipe = isolateTouches ? (event) => event.stopPropagation() : undefined

  // Auto-scroll to active line
  useEffect(() => {
    if (isUserScrolling) return
    if (activeRef.current && containerRef.current) {
      const container = containerRef.current
      const el = activeRef.current
      const containerRect = container.getBoundingClientRect()
      const elRect = el.getBoundingClientRect()
      const offset = elRect.top - containerRect.top - containerRect.height / 2 + elRect.height / 2
      userInputRef.current = false
      container.scrollTo({
        top: container.scrollTop + offset,
        behavior: 'smooth',
      })
    }
  }, [activeIndex, isUserScrolling])

  // Detect user scroll to disable auto-scroll temporarily
  const handleScroll = () => {
    if (!userInputRef.current) return
    setIsUserScrolling(true)
    if (userScrollTimeoutRef.current) clearTimeout(userScrollTimeoutRef.current)
    userScrollTimeoutRef.current = setTimeout(() => {
      setIsUserScrolling(false)
    }, 4000)
  }

  // Тап по строке — перемотка на неё, и на телефоне тоже. Прокрутка пальцем
  // клик не рождает: браузер гасит его, если касание сдвинулось.
  const handleLineClick = (time) => {
    seekTo(time, 'lyrics')
  }

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
          <div className="lyrics-empty-text">Текст не найден</div>
        </div>
      </div>
    )
  }

  return (
    <div
      className="lyrics-panel"
      ref={containerRef}
      onScroll={handleScroll}
      onWheel={markUserInput}
      onPointerDown={markUserInput}
      onKeyDown={markUserInput}
      onTouchStart={(event) => {
        markUserInput()
        stopSwipe?.(event)
      }}
      onTouchMove={(event) => {
        markUserInput()
        stopSwipe?.(event)
      }}
      onTouchEnd={stopSwipe}
    >
      {isSynced ? (
        <div className="lyrics-synced">
          {syncedLines.map((line, i) => (
            <div
              key={`${i}-${line.time}`}
              className={`lyrics-line ${i === activeIndex ? 'active' : ''} ${i < activeIndex ? 'sung' : ''}`}
              ref={i === activeIndex ? activeRef : undefined}
              onClick={() => handleLineClick(line.time)}
              role="button"
              tabIndex={0}
            >
              {line.text}
            </div>
          ))}
        </div>
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

