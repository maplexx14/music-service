import { useRef, useEffect, useState } from 'react'
import { usePlayerStore } from '../store/playerStore'
import { useLyrics, getActiveLyricIndex, LYRIC_LEAD_SEC } from '../hooks/useLyrics'
import { AlignLeft } from 'lucide-react'
import BoltLoader from './BoltLoader'
import { getActive } from '../services/audioEngine'
import './LyricsPanel.css'

// Таймер смены строки: не реже раза в LYRIC_CHECK_MS (время звука могло
// уйти), не чаще LYRIC_MIN_WAIT_MS (строки с одинаковым временем).
const LYRIC_CHECK_MS = 1000
const LYRIC_MIN_WAIT_MS = 16

function LyricsPanel({ showOnlyText = false }) {
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const currentTime = usePlayerStore((s) => s.currentTime)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const seekTo = usePlayerStore((s) => s.seekTo)
  const { syncedLines, plainText, loading } = useLyrics(currentTrack)
  const containerRef = useRef(null)
  const activeRef = useRef(null)
  const [isUserScrolling, setIsUserScrolling] = useState(false)
  const userScrollTimeoutRef = useRef(null)

  // Store тикает раз в секунду (троттлинг timeupdate в Player), и строка,
  // выбранная по нему, переключалась с опозданием до ~1,2 с. Пока играет,
  // строку выбираем по времени прямо из <audio> и будим себя таймером ровно
  // к началу следующей — раньше это делал rAF-цикл, 60 пробуждений главного
  // потока в секунду ради смены строки раз в несколько секунд. Таймер не
  // длиннее LYRIC_CHECK_MS: буферизация и перемотка сдвигают время звука.
  // Эффект перезапускается и на тике стора (currentTime), так что перемотка
  // подхватывается сразу. setState с тем же индексом React пропускает.
  const [liveIndex, setLiveIndex] = useState(-1)
  useEffect(() => {
    if (!isPlaying || !syncedLines.length) return undefined
    let timer = 0
    const tick = () => {
      const audio = getActive()
      if (!audio) return
      const time = audio.currentTime
      const index = getActiveLyricIndex(syncedLines, time)
      setLiveIndex(index)
      const next = syncedLines[index + 1]
      const untilNext = next
        ? ((next.time - LYRIC_LEAD_SEC - time) / (audio.playbackRate || 1)) * 1000
        : LYRIC_CHECK_MS
      timer = setTimeout(tick, Math.min(LYRIC_CHECK_MS, Math.max(LYRIC_MIN_WAIT_MS, untilNext)))
    }
    tick()
    return () => clearTimeout(timer)
  }, [isPlaying, syncedLines, currentTime])
  const storeIndex = getActiveLyricIndex(syncedLines, currentTime)
  const activeIndex = isPlaying && liveIndex >= 0 ? liveIndex : storeIndex
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
  const stopSwipe = showOnlyText ? (event) => event.stopPropagation() : undefined

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

  // Click on a synced line to seek
  const handleLineClick = (time) => {
    if (showOnlyText) return
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

