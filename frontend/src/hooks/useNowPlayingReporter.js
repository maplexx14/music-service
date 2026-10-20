import { useEffect } from 'react'
import api from '../services/api'
import { usePlayerStore } from '../store/playerStore'
import { getActive, getIdle } from '../services/audioEngine'

// «Что сейчас играет» для админки (PUT /users/me/now-playing) — только на
// событиях: смена трека, play/pause, перемотка, уточнённая длительность.
//
// Пульса нет. Большую часть прослушивания экран погашен, а на мобильной сети
// каждый запрос посреди трека будит модем на ~5–10 с: сам трек качается за
// одно пробуждение в начале, а пульс раз в 30 с держал радио включённым весь
// трек. Позицию между событиями админка досчитывает по updated_at
// (livePosition в pages/Admin.jsx), а ключ играющего трека бэкенд держит до
// конца трека с запасом (_now_playing_ttl) — событие следующего трека придёт
// раньше, чем он истечёт.

// Перемотка, о которой стоит сообщить. Свои микро-seek плеера (лечение
// зависшего старта, см. kickStalled в Player) сдвигают позицию на доли секунды.
const SEEK_REPORT_SEC = 2
// Длительность уточнилась: у трека без своей длительности стор в момент смены
// ещё держит длительность прошлого, а по ней бэкенд посчитал срок ключа.
const DURATION_REPORT_SEC = 5

// Позиция звука. В скрытой вкладке стор не тикает (Player пропускает
// setCurrentTime) — там берём её у элемента. На экране — из стора: на смене
// трека он уже обнулён, а активным элементом ещё может быть прежний.
function positionOf(state) {
  if (document.hidden) {
    const time = getActive()?.currentTime
    if (Number.isFinite(time)) return time
  }
  return Number(state.currentTime) || 0
}

// Как resolveTrackDuration в Player: своя длительность трека точнее, чем у
// потока (в ADTS её только оценивают).
function durationOf(state) {
  const own = Number(state.currentTrack?.duration)
  if (Number.isFinite(own) && own > 0) return own
  return Math.max(0, Number(state.duration) || 0)
}

export default function useNowPlayingReporter(enabled) {
  useEffect(() => {
    if (!enabled) return undefined
    // Последнее отправленное — от него считаем, где звук должен быть сейчас.
    let last = null

    const expectedPosition = () => {
      if (!last) return 0
      if (!last.playing) return last.position
      return last.position + (Date.now() - last.at) / 1000
    }

    const sendState = (state, position = positionOf(state)) => {
      const track = state.currentTrack
      if (!track) {
        last = null
        api.delete('/users/me/now-playing', { skipErrorToast: true }).catch(() => {})
        return
      }
      last = {
        trackId: track.id ?? null,
        playing: Boolean(state.isPlaying),
        position: Math.max(0, position),
        duration: durationOf(state),
        at: Date.now(),
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
            position: last.position,
            duration: last.duration,
            is_playing: last.playing,
          },
          { skipErrorToast: true },
        )
        .catch(() => {})
    }

    const initial = usePlayerStore.getState()
    if (initial.currentTrack) sendState(initial)

    const unsubscribe = usePlayerStore.subscribe((state, prev) => {
      if (state.currentTrack?.id !== prev.currentTrack?.id || state.isPlaying !== prev.isPlaying) {
        sendState(state)
        return
      }
      if (
        state.currentTrack &&
        last &&
        last.trackId === (state.currentTrack.id ?? null) &&
        Math.abs(durationOf(state) - last.duration) > DURATION_REPORT_SEC
      ) {
        sendState(state)
      }
    })

    // Перемотку слушаем на самих элементах: её делают и мини-плеер, и
    // фуллскрин, и виджет экрана блокировки, а в фоне стор позицию не видит.
    // Оба слота движка живут всю сессию; прогрев следующего трека не в счёт.
    const slots = [getActive(), getIdle()].filter(Boolean)
    const onSeeked = (event) => {
      const audio = event.target
      if (audio !== getActive()) return
      const state = usePlayerStore.getState()
      if (!state.currentTrack || !last || last.trackId !== (state.currentTrack.id ?? null)) return
      const time = audio.currentTime
      if (!Number.isFinite(time) || Math.abs(time - expectedPosition()) < SEEK_REPORT_SEC) return
      sendState(state, time)
    }
    for (const el of slots) el.addEventListener('seeked', onSeeked)

    // Закрытие вкладки и перезагрузка: без пульса ключ жил бы до конца трека,
    // поэтому снимаем его сразу. keepalive — запрос переживает выгрузку.
    const onPageHide = () => {
      if (!last) return
      last = null
      api
        .delete('/users/me/now-playing', {
          skipErrorToast: true,
          adapter: 'fetch',
          fetchOptions: { keepalive: true },
        })
        .catch(() => {})
    }
    window.addEventListener('pagehide', onPageHide)

    return () => {
      unsubscribe()
      for (const el of slots) el.removeEventListener('seeked', onSeeked)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [enabled])
}
