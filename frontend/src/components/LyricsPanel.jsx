import { useRef, useEffect, useState } from 'react'
import { usePlayerStore } from '../store/playerStore'
import { useLyrics, getActiveLyricIndex } from '../hooks/useLyrics'
import { AlignLeft } from 'lucide-react'
import './LyricsPanel.css'

function LyricsPanel({ showOnlyText = false }) {
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const currentTime = usePlayerStore((s) => s.currentTime)
  const seekTo = usePlayerStore((s) => s.seekTo)
  const { syncedLines, plainText, loading } = useLyrics(currentTrack)
  const containerRef = useRef(null)
  const activeRef = useRef(null)
  const [isUserScrolling, setIsUserScrolling] = useState(false)
  const userScrollTimeoutRef = useRef(null)

  const activeIndex = getActiveLyricIndex(syncedLines, currentTime)
  const hasLyrics = syncedLines.length > 0 || plainText.length > 0
  const isSynced = syncedLines.length > 0

  // Auto-scroll to active line
  useEffect(() => {
    if (isUserScrolling) return
    if (activeRef.current && containerRef.current) {
      const container = containerRef.current
      const el = activeRef.current
      const containerRect = container.getBoundingClientRect()
      const elRect = el.getBoundingClientRect()
      const offset = elRect.top - containerRect.top - containerRect.height / 2 + elRect.height / 2
      container.scrollTo({
        top: container.scrollTop + offset,
        behavior: 'smooth',
      })
    }
  }, [activeIndex, isUserScrolling])

  // Detect user scroll to disable auto-scroll temporarily
  const handleScroll = () => {
    setIsUserScrolling(true)
    if (userScrollTimeoutRef.current) clearTimeout(userScrollTimeoutRef.current)
    userScrollTimeoutRef.current = setTimeout(() => {
      setIsUserScrolling(false)
    }, 4000)
  }

  // Click on a synced line to seek
  const handleLineClick = (time) => {
    if (showOnlyText) return
    seekTo(time)
  }

  if (!currentTrack) return null

  if (loading) {
    return (
      <div className="lyrics-panel">
        <div className="lyrics-empty">
          <div className="lyrics-loading-spinner" />
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
    >
      {isSynced ? (
        <div className="lyrics-synced">
          {syncedLines.map((line, i) => (
            <div
              key={`${i}-${line.time}`}
              className={`lyrics-line ${i === activeIndex ? 'active' : ''} ${i < activeIndex ? 'sung' : ''}`}
              ref={i === activeIndex ? activeRef : undefined}
              onClick={() => handleLineClick(line.time)}
              role={showOnlyText ? undefined : 'button'}
              tabIndex={showOnlyText ? undefined : 0}
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
