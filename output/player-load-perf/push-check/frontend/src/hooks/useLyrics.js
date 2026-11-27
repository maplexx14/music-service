import { useState, useEffect, useMemo, useCallback } from 'react'
import api from '../services/api'
import { getActive } from '../services/audioEngine'

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

// Текст ищет бэкенд (routers/lyrics.py): lrclib стоит за Cloudflare, который
// провайдеры в РФ душат, а его фолбэк-поиск отдаёт ~0.5 МБ — без VPN текст
// искался секундами. Сервер отдаёт только выбранный текст и кэширует его.
// Одна загрузка на трек: хук живёт сразу в нескольких местах (мини-плеер,
// фуллскрин, две панели текста), и раньше каждый слал свой запрос.
const lyricsCache = new Map()
const pendingLyrics = new Map()
const retryListeners = new Map()
const retryAfter = new Map()

function loadLyrics(cacheKey, artist, title, duration) {
  if (lyricsCache.has(cacheKey)) return Promise.resolve(lyricsCache.get(cacheKey))
  if (pendingLyrics.has(cacheKey)) return pendingLyrics.get(cacheKey)
  const delay = Math.max(0, (retryAfter.get(cacheKey) || 0) - Date.now())
  const request = (delay ? new Promise((resolve) => setTimeout(resolve, delay)) : Promise.resolve())
    .then(() => api.get('/lyrics', {
      params: { artist, title, duration: duration || undefined },
      skipErrorToast: true,
      timeout: 20000,
    }))
    .then(({ data }) => {
      const entry = { synced: parseLrc(data?.synced), plain: data?.plain || '' }
      lyricsCache.set(cacheKey, entry)
      retryAfter.delete(cacheKey)
      return entry
    })
    .catch((error) => {
      const seconds = Number(error.response?.headers?.['retry-after'])
      if (seconds > 0) retryAfter.set(cacheKey, Date.now() + Math.min(seconds, 60) * 1000)
      throw error
    })
    .finally(() => pendingLyrics.delete(cacheKey))
  pendingLyrics.set(cacheKey, request)
  return request
}

export function useLyrics(track) {
  const [syncedLines, setSyncedLines] = useState([])
  const [plainText, setPlainText] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [attempt, setAttempt] = useState(0)

  const artist = track?.artist
  const title = track?.title
  const duration = Math.round(Number(track?.duration) || 0)

  const cacheKey = useMemo(
    () => `${(artist || '').toLowerCase()}|${(title || '').toLowerCase()}`,
    [artist, title],
  )
  const retry = useCallback(() => {
    lyricsCache.delete(cacheKey)
    for (const listener of retryListeners.get(cacheKey) || []) listener()
  }, [cacheKey])

  useEffect(() => {
    const listeners = retryListeners.get(cacheKey) || new Set()
    retryListeners.set(cacheKey, listeners)
    const refresh = () => setAttempt((value) => value + 1)
    listeners.add(refresh)
    return () => {
      listeners.delete(refresh)
      if (listeners.size === 0) retryListeners.delete(cacheKey)
    }
  }, [cacheKey])

  useEffect(() => {
    if (!artist || !title) {
      setSyncedLines([])
      setPlainText('')
      setError(null)
      setLoading(false)
      return undefined
    }

    const cached = lyricsCache.get(cacheKey)
    if (cached) {
      setSyncedLines(cached.synced)
      setPlainText(cached.plain)
      setError(null)
      setLoading(false)
      return undefined
    }

    let cancelled = false
    setLoading(true)
    setError(null)
    setSyncedLines([])
    setPlainText('')

    loadLyrics(cacheKey, artist, title, duration)
      .then((entry) => {
        if (cancelled) return
        setSyncedLines(entry.synced)
        setPlainText(entry.plain)
      })
      .catch((err) => {
        if (!cancelled) setError(err)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
    // duration в зависимостях нет намеренно: текст привязан к артисту и
    // названию, а длительность лишь помогает выбрать синхронную версию.
  }, [artist, title, cacheKey, attempt])

  return { syncedLines, plainText, loading, error, retry }
}

// Строка загорается раньше своей метки времени. Метки lrclib запаздывают за
// голосом: сверка с распознанным вокалом (whisper, 8 треков из прослушанного,
// 158 строк) дала медиану +0.14 с, p75 +0.41, p90 +0.81, а с прежним
// опережением 0.1 с 15% строк загорались позже голоса больше чем на 0.5 с.
// При 0.4 таких 8%, раньше голоса больше чем на 0.8 с — 4%. В караоке раньше
// лучше, чем позже: строку успевают прочесть. Ещё ~0.1 с съедает проявление
// цвета (transition в LyricsPanel.css).
export const LYRIC_LEAD_SEC = 0.4

// Find the active line index for a given time. До первой строки — beforeFirst:
// обычный текст сразу подсвечивает первую, демо-режим держит заставку (-1).
export function getActiveLyricIndex(syncedLines, currentTime, beforeFirst = 0) {
  if (!syncedLines.length) return -1
  for (let i = syncedLines.length - 1; i >= 0; i--) {
    if (currentTime >= syncedLines[i].time - LYRIC_LEAD_SEC) return i
  }
  return beforeFirst
}

// Таймер смены строки: не реже раза в LYRIC_CHECK_MS (время звука могло
// уйти), не чаще LYRIC_MIN_WAIT_MS (строки с одинаковым временем).
const LYRIC_CHECK_MS = 1000
const LYRIC_MIN_WAIT_MS = 16

// Активная строка с точностью до кадра. Store тикает раз в секунду
// (троттлинг timeupdate в Player), и строка, выбранная по нему, переключалась
// с опозданием до ~1,2 с. Пока играет, строку выбираем по времени прямо из
// <audio> и будим себя таймером ровно к началу следующей — раньше это делал
// rAF-цикл, 60 пробуждений главного потока в секунду ради смены строки раз в
// несколько секунд. Таймер не длиннее LYRIC_CHECK_MS: буферизация и перемотка
// сдвигают время звука. Эффект перезапускается и на тике стора
// (currentTime), так что перемотка подхватывается сразу. setState с тем же
// индексом React пропускает.
export function useActiveLyricIndex(syncedLines, currentTime, isPlaying, { beforeFirst = 0 } = {}) {
  const [liveIndex, setLiveIndex] = useState(null)
  useEffect(() => {
    if (!isPlaying || !syncedLines.length) return undefined
    let timer = 0
    const tick = () => {
      const audio = getActive()
      if (!audio) return
      const time = audio.currentTime
      const index = getActiveLyricIndex(syncedLines, time, beforeFirst)
      setLiveIndex(index)
      const next = syncedLines[index + 1]
      const untilNext = next
        ? ((next.time - LYRIC_LEAD_SEC - time) / (audio.playbackRate || 1)) * 1000
        : LYRIC_CHECK_MS
      timer = setTimeout(tick, Math.min(LYRIC_CHECK_MS, Math.max(LYRIC_MIN_WAIT_MS, untilNext)))
    }
    tick()
    return () => clearTimeout(timer)
  }, [isPlaying, syncedLines, currentTime, beforeFirst])
  const storeIndex = getActiveLyricIndex(syncedLines, currentTime, beforeFirst)
  return isPlaying && liveIndex !== null ? liveIndex : storeIndex
}
