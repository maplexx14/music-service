import { useEffect } from 'react'
import api from '../services/api'
import { usePlayerStore } from '../store/playerStore'

// Пульс «что сейчас играет» для админки (PUT /users/me/now-playing). Ключ на
// бэке живёт 90 с, поэтому пульс чаще TTL: закрытая вкладка сама пропадает из
// «сейчас слушает», а живая не мигает между пульсами.
const HEARTBEAT_MS = 30000

function sendState(state) {
  const track = state.currentTrack
  if (!track) {
    api.delete('/users/me/now-playing', { skipErrorToast: true }).catch(() => {})
    return
  }
  api
    .put(
      '/users/me/now-playing',
      {
        track_id: track.id != null ? String(track.id) : null,
        title: track.title || 'Без названия',
        artist: track.artist ?? null,
        cover_url: track.cover_url ?? null,
        source: track.source ?? null,
        position: Math.max(0, state.currentTime || 0),
        duration: Math.max(0, state.duration || track.duration || 0),
        is_playing: Boolean(state.isPlaying),
      },
      { skipErrorToast: true },
    )
    .catch(() => {})
}

export default function useNowPlayingReporter(enabled) {
  useEffect(() => {
    if (!enabled) return undefined
    const initial = usePlayerStore.getState()
    if (initial.currentTrack) sendState(initial)

    // Смена трека и play/pause уходят сразу — иначе админка до полуминуты
    // показывает прошлый трек. currentTime тикает постоянно, его несёт пульс.
    const unsubscribe = usePlayerStore.subscribe((state, prev) => {
      if (state.currentTrack?.id !== prev.currentTrack?.id || state.isPlaying !== prev.isPlaying) {
        sendState(state)
      }
    })
    const interval = window.setInterval(() => {
      const state = usePlayerStore.getState()
      if (state.currentTrack) sendState(state)
    }, HEARTBEAT_MS)
    return () => {
      unsubscribe()
      window.clearInterval(interval)
    }
  }, [enabled])
}
