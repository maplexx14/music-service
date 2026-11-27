// Loaded only through CDP into a disposable debug emulator. The player, store,
// audio engine and native bridge are real; account UI and write telemetry are omitted.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import Player from '../../src/components/Player'
import { usePlayerStore } from '../../src/store/playerStore'
import { useUiSettingsStore } from '../../src/store/uiSettingsStore'
import * as engine from '../../src/services/audioEngine'
import api from '../../src/services/api'
import { readDiag } from '../../src/utils/playerDiag'

const events = []
function record(event, audio) {
  events.push({
    at: Date.now(), event, hidden: document.hidden,
    index: usePlayerStore.getState().currentIndex,
    track: usePlayerStore.getState().currentTrack?.id,
    position: audio?.currentTime, paused: audio?.paused,
    readyState: audio?.readyState, error: audio?.error?.code,
  })
  if (events.length > 2000) events.shift()
}

api.interceptors.request.use((config) => {
  if ((config.method || 'get').toLowerCase() !== 'get' || /\/me\b|\/auth\//.test(config.url)) {
    config.adapter = async () => ({ data: [], status: 200, statusText: 'OK', headers: {}, config })
  }
  return config
})

for (const audio of [engine.getActive(), engine.getIdle()]) {
  let sampledAt = 0
  for (const event of ['playing', 'pause', 'ended', 'waiting', 'stalled', 'error', 'emptied', 'loadedmetadata']) {
    audio.addEventListener(event, () => record(event, audio))
  }
  // Passive observation of actual playback events, with no polling timer.
  audio.addEventListener('timeupdate', () => {
    if (audio !== engine.getActive() || Date.now() - sampledAt < 10_000) return
    sampledAt = Date.now()
    record('progress', audio)
  })
}
document.addEventListener('visibilitychange', () => record('visibility', engine.getActive()))
usePlayerStore.subscribe((state, previous) => {
  if (state.currentTrack?.id !== previous.currentTrack?.id) record('track', engine.getActive())
})

useUiSettingsStore.setState({ rememberPlayer: false })
document.getElementById('root').style.display = 'none'
const root = document.createElement('div')
root.id = 'emulator-playback-test'
document.body.appendChild(root)
createRoot(root).render(<MemoryRouter><Player /></MemoryRouter>)

window.__boltEmulatorProbe = {
  start(tracks) {
    usePlayerStore.getState().playPlaylist(tracks, 0, 'playlist', null, {
      recordClick: false,
      context: { kind: 'playlist', title: 'Emulator background test' },
    })
  },
  snapshot() {
    const audio = engine.getActive()
    const state = usePlayerStore.getState()
    return {
      at: Date.now(), hidden: document.hidden,
      track: state.currentTrack?.id, title: state.currentTrack?.title,
      index: state.currentIndex, requested: state.isPlaying,
      playback: navigator.mediaSession.playbackState,
      audio: {
        src: audio.src, position: audio.currentTime, duration: audio.duration,
        paused: audio.paused, ended: audio.ended, readyState: audio.readyState,
        networkState: audio.networkState, error: audio.error?.code,
        buffered: Array.from({ length: audio.buffered.length }, (_, i) => [audio.buffered.start(i), audio.buffered.end(i)]),
      },
      events: [...events], diagnostics: readDiag(),
    }
  },
}
