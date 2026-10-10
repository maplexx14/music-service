import { useState, useEffect, useRef, useCallback, useMemo } from 'react'

// Parse LRC timestamp line: [mm:ss.xx] text
function parseLrcLine(line) {
  const match = line.match(/^\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/)
  if (!match) return null
  const minutes = parseInt(match[1], 10)
  const seconds = parseInt(match[2], 10)
  const frac = match[3].padEnd(3, '0')
  const time = minutes * 60 + seconds + parseInt(frac, 10) / 1000
  const text = match[4].trim()
  return { time, text }
}

// Parse full LRC string into sorted timed lines
function parseLrc(lrc) {
  if (!lrc) return []
  const lines = lrc.split('\n')
  const result = []
  for (const line of lines) {
    const parsed = parseLrcLine(line)
    if (parsed) result.push(parsed)
  }
  return result.sort((a, b) => a.time - b.time)
}

// Расхождение длительности (сек), при котором синхронный текст из поиска ещё
// считается той же записью. /api/get сверяет длительность сам, ±2 с.
const SYNC_DURATION_TOLERANCE = 3

function stripLrcTimestamps(lrc) {
  return lrc
    .split('\n')
    .map((line) => line.replace(/^(\[\d{2}:\d{2}\.\d{2,3}\])+/, '').trim())
    .join('\n')
}

// Cache keyed by artist+title
const lyricsCache = new Map()

export function useLyrics(track) {
  const [syncedLines, setSyncedLines] = useState([])
  const [plainText, setPlainText] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const abortRef = useRef(null)
  const prevKeyRef = useRef(null)

  const artist = track?.artist
  const title = track?.title
  const duration = track?.duration

  const cacheKey = useMemo(
    () => `${(artist || '').toLowerCase()}|${(title || '').toLowerCase()}`,
    [artist, title],
  )

  useEffect(() => {
    if (!artist || !title) {
      setSyncedLines([])
      setPlainText('')
      setError(null)
      setLoading(false)
      prevKeyRef.current = null
      return
    }

    if (cacheKey === prevKeyRef.current) return
    prevKeyRef.current = cacheKey

    // Check in-memory cache
    if (lyricsCache.has(cacheKey)) {
      const cached = lyricsCache.get(cacheKey)
      setSyncedLines(cached.synced)
      setPlainText(cached.plain)
      setError(null)
      setLoading(false)
      return
    }

    // Abort previous request
    if (abortRef.current) abortRef.current.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setLoading(true)
    setError(null)
    setSyncedLines([])
    setPlainText('')

    const durSec = Math.round(Number(duration) || 0)

    const fetchSynced = async () => {
      const params = new URLSearchParams({ artist_name: artist, track_name: title })
      if (durSec > 0) params.set('duration', String(durSec))
      const res = await fetch(`https://lrclib.net/api/get?${params}`, {
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(res.status)
      const data = await res.json()
      return data.syncedLyrics || null
    }

    const fetchPlain = async () => {
      const params = new URLSearchParams({ q: `${artist} ${title}` })
      const res = await fetch(`https://lrclib.net/api/search?${params}`, { signal: controller.signal })
      if (!res.ok) return null
      const results = await res.json()
      // Синхронный текст — только той же записи: поиск отдаёт и live, и
      // радио-версии, и их тайминги расходятся с нашим треком на секунды
      // (строки «отставали» весь трек). Длительность не совпала — показываем
      // текст без подсветки: лучше честно без синхронизации, чем со сдвигом.
      const sameRecording = (r) =>
        durSec > 0 && Math.abs((Number(r.duration) || 0) - durSec) <= SYNC_DURATION_TOLERANCE
      const synced = results.find((r) => r.syncedLyrics && sameRecording(r))
      if (synced) return { synced: synced.syncedLyrics }
      for (const r of results) {
        if (r.plainLyrics) return { plain: r.plainLyrics }
        if (r.syncedLyrics) return { plain: stripLrcTimestamps(r.syncedLyrics) }
      }
      return null
    }

    ;(async () => {
      try {
        let synced = null
        let plain = ''

        // Try exact match first
        try {
          synced = await fetchSynced()
        } catch {
          // Exact failed — try search
        }

        if (!synced) {
          // Fallback: search endpoint
          const searchResult = await fetchPlain()
          if (searchResult?.synced) synced = searchResult.synced
          else if (searchResult?.plain) plain = searchResult.plain
        }

        const parsed = synced ? parseLrc(synced) : []

        lyricsCache.set(cacheKey, { synced: parsed, plain })

        if (!controller.signal.aborted) {
          setSyncedLines(parsed)
          setPlainText(plain)
          setError(null)
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          setError(err)
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    })()

    return () => controller.abort()
  }, [artist, title, duration, cacheKey])

  return { syncedLines, plainText, loading, error }
}

// Строка загорается чуть раньше своей метки времени.
export const LYRIC_LEAD_SEC = 0.1

// Find the active line index for a given time
export function getActiveLyricIndex(syncedLines, currentTime) {
  if (!syncedLines.length) return -1
  for (let i = syncedLines.length - 1; i >= 0; i--) {
    if (currentTime >= syncedLines[i].time - LYRIC_LEAD_SEC) return i
  }
  return 0
}
