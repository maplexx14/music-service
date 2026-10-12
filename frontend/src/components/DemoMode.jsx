import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { usePlayerStore } from '../store/playerStore'
import { useLyrics, useActiveLyricIndex, LYRIC_LEAD_SEC } from '../hooks/useLyrics'
import { usePlaybackProgress } from '../hooks/usePlaybackProgress'
import { getActive } from '../services/audioEngine'
import { resolveCoverUrl, handleCoverError } from '../utils/media'
import defaultCover from '../assets/default-cover.webp'
import './DemoMode.css'

// Демо-режим: тот же караоке-текст, но как клип для записи экрана (TikTok,
// Reels). Кнопок нет вовсе — в кадре только обложка, текст и эффекты в
// стиле промо-ролика (фиолетовый фон с растром, глитч циан/розовый,
// молнии-каракули). Выход — долгое нажатие в любом месте или Esc.

// Долгое нажатие для выхода, мс, и допуск дрожания пальца, px.
const EXIT_HOLD_MS = 600
const EXIT_SLOP_PX = 12
// Подсказка о выходе в начале — потом гаснет, чтобы не попадать в ролик.
const HINT_MS = 2600

// Слова строки загораются по очереди. В LRC времени слов нет, поэтому
// раскладываем длительность строки по словам пропорционально длине: не
// по слогам, но глаз рассинхрона почти не видит, а движение идёт в темп
// вокала. Последние 20% строки — запас: голос обычно заканчивает раньше,
// чем начинается следующая строка.
const LINE_FILL = 0.8
const LINE_MIN_SEC = 0.6
const LINE_MAX_SEC = 7
const LAST_LINE_SEC = 4

function splitWords(line, nextTime) {
  const words = line.text.split(/\s+/).filter(Boolean)
  const length = Math.min(
    LINE_MAX_SEC,
    Math.max(LINE_MIN_SEC, (nextTime ?? line.time + LAST_LINE_SEC) - line.time),
  )
  const weights = words.map((word) => word.length + 2)
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  let acc = 0
  return words.map((word, i) => {
    // От момента, когда строка загорелась (за LYRIC_LEAD_SEC до метки).
    const at = LYRIC_LEAD_SEC + (length * LINE_FILL * acc) / total
    acc += weights[i]
    return { word, at }
  })
}

// Кегль по длине строки: короткая — крупно, длинная — мельче, чтобы в
// портретном кадре влезала в 2–3 строки.
function sizeClass(text) {
  if (text.length <= 16) return ' is-short'
  if (text.length > 40) return ' is-long'
  return ''
}

// Молния-каракуля из промо (styles/promo.css): заливка, чернильный контур,
// глитч-копии контура циан/розовый.
const BOLT_PATH = 'M20 4l26 2-12 32h18L12 92l10-42H6z'

function Bolt({ className, style }) {
  return (
    <svg className={className} style={style} viewBox="0 0 64 96" aria-hidden="true">
      <g strokeLinejoin="round" strokeWidth="3" fill="none">
        <path d={BOLT_PATH} stroke="#22e4ff" transform="translate(-2 1)" />
        <path d={BOLT_PATH} stroke="#ff2fa0" transform="translate(2 1)" />
        <path d={BOLT_PATH} fill="#8b3cf0" stroke="#0d0420" />
      </g>
    </svg>
  )
}

// Молнии по краям кадра; на смене строки вспыхивает одна из них по кругу.
const BOLTS = [
  { x: 6, y: 14, r: -14, s: 1 },
  { x: 82, y: 9, r: 16, s: 0.8 },
  { x: 86, y: 66, r: 22, s: 1.1 },
  { x: 4, y: 72, r: -20, s: 0.85 },
]

const fillTransform = (ratio) => `scaleX(${ratio})`

function DemoProgress() {
  const fillRef = useRef(null)
  usePlaybackProgress([{ ref: fillRef, frame: fillTransform }])
  return (
    <div className="demo-progress" aria-hidden="true">
      <div className="demo-progress-fill" ref={fillRef} />
    </div>
  )
}

function DemoLine({ line, role, words, anchor, index }) {
  if (!line) return null
  const isBreak = words.length === 0
  // Слово не переносим посередине: кегль не больше, чем влезает самое
  // длинное слово (Unbounded широкий, ~0.85em на букву).
  const longest = words.reduce((max, { word }) => Math.max(max, word.length), 0)
  return (
    <p
      className={`demo-line is-${role}${sizeClass(line.text)}`}
      style={longest ? { '--fit': `calc((100vw - 48px) / ${(longest * 0.85).toFixed(2)})` } : undefined}
    >
      {isBreak ? (
        <span className="demo-break" aria-label="Проигрыш">
          <i />
          <i />
          <i />
        </span>
      ) : (
        // Ключ с anchor: после перемотки внутри строки слова стартуют заново
        // от новой позиции звука.
        <span className="demo-line-text" key={role === 'current' ? `${index}:${anchor}` : index}>
          {words.map(({ word, at }, i) => (
            <span key={i}>
              <span
                className="demo-word"
                style={role === 'current' ? { '--delay': `${(at - anchor).toFixed(3)}s` } : undefined}
              >
                {word}
              </span>
              {i < words.length - 1 ? ' ' : null}
            </span>
          ))}
        </span>
      )}
    </p>
  )
}

// На десктопе — во весь экран, без вкладок и панелей браузера в кадре.
// Звать прямо из обработчика нажатия.
export function enterDemoFullscreen() {
  const canFullscreen = window.matchMedia('(hover: hover) and (pointer: fine)').matches
  if (canFullscreen && !document.fullscreenElement) {
    document.documentElement.requestFullscreen?.().catch(() => {})
  }
}

function DemoMode({ onExit }) {
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const currentTime = usePlayerStore((s) => s.currentTime)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const { syncedLines } = useLyrics(currentTrack)
  const activeIndex = useActiveLyricIndex(syncedLines, currentTime, isPlaying, { beforeFirst: -1 })
  const [showHint, setShowHint] = useState(true)
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit

  const coverUrl = useMemo(
    () => resolveCoverUrl(currentTrack?.cover_url, true) || defaultCover,
    [currentTrack?.cover_url],
  )

  const wordsByLine = useMemo(
    () => syncedLines.map((line, i) => splitWords(line, syncedLines[i + 1]?.time)),
    [syncedLines],
  )

  // Сколько секунд строка уже горит — от этого задержки слов. Пересчёт на
  // смене строки и после перемотки; до отрисовки, чтобы слова не мигнули.
  const [anchor, setAnchor] = useState(0)
  useLayoutEffect(() => {
    const line = syncedLines[activeIndex]
    if (!line) return undefined
    const measure = () => {
      const audio = getActive()
      const elapsed = audio ? audio.currentTime - (line.time - LYRIC_LEAD_SEC) : 0
      setAnchor(Math.max(0, Math.round(elapsed * 100) / 100))
    }
    measure()
    const audio = getActive()
    audio?.addEventListener('seeked', measure)
    return () => audio?.removeEventListener('seeked', measure)
  }, [activeIndex, syncedLines])

  // Включаемся — музыка играет: демо без звука записывать незачем, а
  // кнопки «играть» в кадре нет.
  useEffect(() => {
    const { isPlaying: playing, togglePlayPause } = usePlayerStore.getState()
    if (!playing) togglePlayPause()
  }, [])

  // Облегчённый режим глушит все анимации (.lite-mode * в index.css), а
  // демо — это и есть анимация, включённая намеренно. На время демо
  // снимаем класс и возвращаем на выходе.
  useEffect(() => {
    const root = document.documentElement
    const wasLite = root.classList.contains('lite-mode')
    if (wasLite) root.classList.remove('lite-mode')
    return () => {
      if (wasLite) root.classList.add('lite-mode')
    }
  }, [])

  // Экран не гаснет посреди записи. Во весь экран просит кнопка входа
  // (enterDemoFullscreen) — Safari разрешает это только внутри нажатия.
  useEffect(() => {
    let lock = null
    let released = false
    const requestLock = () => {
      navigator.wakeLock
        ?.request('screen')
        .then((sentinel) => {
          if (released) sentinel.release()
          else lock = sentinel
        })
        .catch(() => {})
    }
    requestLock()
    // Блокировка снимается сама, когда вкладка уходит в фон.
    const onVisible = () => {
      if (document.visibilityState === 'visible') requestLock()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      released = true
      lock?.release().catch(() => {})
      document.removeEventListener('visibilitychange', onVisible)
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
    }
  }, [])

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onExitRef.current()
    }
    window.addEventListener('keydown', onKey)
    const timer = setTimeout(() => setShowHint(false), HINT_MS)
    return () => {
      window.removeEventListener('keydown', onKey)
      clearTimeout(timer)
    }
  }, [])

  // Долгое нажатие — выход. Обычные касания ничего не делают: случайный тап
  // посреди записи не должен ставить паузу или листать трек.
  const holdRef = useRef(null)
  const cancelHold = () => {
    if (!holdRef.current) return
    clearTimeout(holdRef.current.timer)
    holdRef.current = null
  }
  const handlePointerDown = (event) => {
    cancelHold()
    holdRef.current = {
      x: event.clientX,
      y: event.clientY,
      timer: setTimeout(() => {
        holdRef.current = null
        onExitRef.current()
      }, EXIT_HOLD_MS),
    }
  }
  const handlePointerMove = (event) => {
    const hold = holdRef.current
    if (!hold) return
    if (Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > EXIT_SLOP_PX) cancelHold()
  }
  useEffect(() => cancelHold, [])

  // Жесты полноэкранного плеера (свайп вниз закрывает) сюда не доходят:
  // портал всплывает по дереву React, а не DOM.
  const stop = (event) => event.stopPropagation()

  if (!currentTrack) return null

  const hasSynced = syncedLines.length > 0
  const hasLine = hasSynced && activeIndex >= 0
  const lineProps = (offset, role) => {
    const index = activeIndex + offset
    return {
      index,
      role,
      line: syncedLines[index],
      words: wordsByLine[index] || [],
      anchor,
    }
  }
  // Ключ трека: на смене трека заставка и текст проявляются заново.
  const trackKey = currentTrack.id ?? `${currentTrack.artist}|${currentTrack.title}`

  return createPortal(
    <div
      className={`demo-mode${isPlaying ? '' : ' is-paused'}${hasLine ? ' has-line' : ''}`}
      role="dialog"
      aria-label="Демо-режим"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={cancelHold}
      onPointerCancel={cancelHold}
      onContextMenu={(event) => event.preventDefault()}
      onTouchStart={stop}
      onTouchMove={stop}
      onTouchEnd={stop}
      onClick={stop}
    >
      <div className="demo-bg" aria-hidden="true">
        <img
          className="demo-bg-cover"
          src={resolveCoverUrl(currentTrack.cover_url, 'thumb') || coverUrl}
          alt=""
          data-no-fade=""
          decoding="async"
          draggable={false}
          onError={handleCoverError}
        />
        <div className="demo-bg-tint" />
        <div className="demo-blob demo-blob--pink" />
        <div className="demo-blob demo-blob--cyan" />
        <div className="demo-dots" />
      </div>

      {hasLine && <div key={`flash-${activeIndex}`} className="demo-flash" aria-hidden="true" />}

      <div className="demo-bolts" aria-hidden="true">
        {BOLTS.map((bolt, i) => {
          const strike = hasLine && activeIndex % BOLTS.length === i
          return (
            <Bolt
              key={strike ? `bolt-${i}-${activeIndex}` : `bolt-${i}`}
              className={`demo-bolt${strike ? ' is-strike' : ''}`}
              style={{
                left: `${bolt.x}%`,
                top: `${bolt.y}%`,
                '--r': `${bolt.r}deg`,
                '--s': bolt.s,
                '--d': `${i * -1.7}s`,
              }}
            />
          )
        })}
      </div>

      <header className="demo-header" key={`head-${trackKey}`}>
        <img
          className="demo-header-cover"
          src={coverUrl}
          alt=""
          data-no-fade=""
          decoding="async"
          draggable={false}
          onError={handleCoverError}
        />
        <div className="demo-header-text">
          <div className="demo-header-title">{currentTrack.title}</div>
          <div className="demo-header-artist">{currentTrack.artist}</div>
        </div>
      </header>

      <main className="demo-stage">
        <div className="demo-hero" key={`hero-${trackKey}`}>
          <div className="demo-hero-art">
            <img
              src={coverUrl}
              alt={currentTrack.title}
              data-no-fade=""
              decoding="async"
              draggable={false}
              onError={handleCoverError}
            />
          </div>
          <h1 className="demo-hero-title" data-text={currentTrack.title}>
            {currentTrack.title}
          </h1>
          <div className="demo-hero-artist">{currentTrack.artist}</div>
        </div>

        {hasSynced && (
          <div className="demo-lines" key={`lines-${trackKey}`}>
            {activeIndex >= 1 && <DemoLine key={activeIndex - 1} {...lineProps(-1, 'prev')} />}
            {hasLine && <DemoLine key={activeIndex} {...lineProps(0, 'current')} />}
            <DemoLine key={activeIndex + 1} {...lineProps(1, 'next')} />
          </div>
        )}
      </main>

      <footer className="demo-footer">
        <DemoProgress />
        <img className="demo-logo" src="/logoBoltwo.webp" alt="bolt" draggable={false} />
      </footer>

      <div className={`demo-hint${showHint ? '' : ' is-hidden'}`} aria-live="polite">
        Удерживайте экран, чтобы выйти
      </div>
    </div>,
    document.body,
  )
}

export default DemoMode
