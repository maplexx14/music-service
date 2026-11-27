import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import DesktopCdPlayer from './src/components/DesktopCdPlayer'
import { ScreenContext } from './src/hooks/useScreen'
import { usePlayerStore } from './src/store/playerStore'
import { useUiSettingsStore } from './src/store/uiSettingsStore'
import './src/index.css'
import './src/pages/Home.css'
import { WebGLRenderer, Vector3 } from 'three'

const originalRender = WebGLRenderer.prototype.render
window.__renderCount = 0
WebGLRenderer.prototype.render = function(scene, camera) {
  const deck = scene.children.find(child => child.type === 'Group' && child.children.some(object => object.userData.action === 'play'))
  if (deck) {
    window.__renderCount++
    window.__deck = deck
    window.__camera = camera
    window.__renderer = this
  }
  return originalRender.call(this, scene, camera)
}
window.__point = (action) => {
  const object = window.__deck.children.find(child => child.userData.action === action)
  const point = object.getWorldPosition(new Vector3()).project(window.__camera)
  const rect = document.querySelector('.cd-deck-canvas').getBoundingClientRect()
  return { x: rect.left + (point.x + 1) * rect.width / 2, y: rect.top + (1 - point.y) * rect.height / 2 }
}
window.__worldPoint = (x, y, z) => {
  const point = new Vector3(x, y, z).project(window.__camera)
  const rect = document.querySelector('.cd-deck-canvas').getBoundingClientRect()
  return { x: rect.left + (point.x + 1) * rect.width / 2, y: rect.top + (1 - point.y) * rect.height / 2 }
}

const queue = ['Prison Song', 'Needles', 'Chop Suey!', 'Toxicity', 'Aerials', 'ATWA'].map((title, id) => ({ id: id + 100, title, artist: 'System Of A Down', duration: 240, cover_url: '/__cd-preview-cover.jpg' }))
window.__calls = []
const log = (action, value) => window.__calls.push({ action, value })
useUiSettingsStore.setState({ vinylDisc: true })
usePlayerStore.setState({
  currentTrack: queue[2], currentIndex: 2, queue, currentTime: 37, duration: 240, volume: 0.72, isPlaying: false, source: 'flow', playContext: { kind: 'flow' },
  setVolume: (value) => { log('volume', value); usePlayerStore.setState({ volume: value }) },
  seekTo: (value) => { log('seek', value); usePlayerStore.setState({ currentTime: value }) },
  nextTrack: () => { log('next'); const state = usePlayerStore.getState(); const index = Math.min(queue.length - 1, state.currentIndex + 1); usePlayerStore.setState({ currentTrack: queue[index], currentIndex: index, currentTime: 0 }) },
  previousTrack: () => { log('previous'); const state = usePlayerStore.getState(); const index = Math.max(0, state.currentIndex - 1); usePlayerStore.setState({ currentTrack: queue[index], currentIndex: index, currentTime: 0 }) },
  advanceBy: (distance) => { log('advance', distance); const state = usePlayerStore.getState(); const index = Math.min(queue.length - 1, state.currentIndex + distance); usePlayerStore.setState({ currentTrack: queue[index], currentIndex: index, currentTime: 0 }) },
  toggleShuffle: () => { log('shuffle'); usePlayerStore.setState({ isShuffle: !usePlayerStore.getState().isShuffle }) },
  toggleRepeatOne: () => { log('repeat'); usePlayerStore.setState({ isRepeatOne: !usePlayerStore.getState().isRepeatOne }) },
})
window.__store = usePlayerStore
function Preview() {
  const [active, setActive] = useState(true)
  const [mounted, setMounted] = useState(true)
  window.__setActive = setActive
  window.__setMounted = setMounted
  return <ScreenContext.Provider value={{ active }}>
    <div style={{ padding: '32px', background: '#0d0b10', minHeight: '100vh' }}>
      <div className="hero-section has-cd has-solid-backdrop has-desktop-deck" style={{ height: 'calc(100vh - 64px)', minHeight: '350px' }}>
        <h1 style={{ position: 'absolute', left: 36, top: 28, margin: 0, color: '#f2eff6', font: '900 40px Arial' }}>МОЙ ПОТОК</h1>
        {mounted && <DesktopCdPlayer onPlay={() => { log('play'); usePlayerStore.setState({ isPlaying: !usePlayerStore.getState().isPlaying }) }} onStartFlow={() => { log('flow'); usePlayerStore.setState({ source: 'flow', playContext: { kind: 'flow' }, currentTrack: queue[0], currentIndex: 0, isPlaying: true, currentTime: 0 }) }} />}
      </div>
    </div>
  </ScreenContext.Provider>
}
createRoot(document.getElementById('root')).render(<React.StrictMode><Preview /></React.StrictMode>)
