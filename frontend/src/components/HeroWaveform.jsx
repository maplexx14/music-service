import { useEffect, useRef } from 'react'
import { useScreen } from '../hooks/useScreen'
import { createWaveformReader } from '../services/audioVisualization'
import { heavyAnimationsHeld, onHeavyAnimationsHold } from '../services/navigation'
import { isPowerSave, onPowerSaveChange } from '../utils/powerSave'
import glowReference from '../assets/audio-glow-reference.webp'
import './HeroWaveform.css'

const POINTS = 128
const FRAME_MS = 1000 / 30

export default function HeroWaveform({ playing, enabled = true, trackKey, colors }) {
  const canvasRef = useRef(null)
  const syncRef = useRef(null)
  const refreshRef = useRef(null)
  const { active: screenActive } = useScreen()
  const state = useRef(null)
  state.current = { playing, enabled, screenActive, colors, trackKey }

  useEffect(() => {
    const canvas = canvasRef.current
    const display = canvas?.getContext('2d')
    if (!display) return undefined
    const reader = createWaveformReader(POINTS)
    const resting = new Float32Array(POINTS)
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    let inViewport = true
    let held = heavyAnimationsHeld()
    let powerSave = isPowerSave()
    let running = false
    let raf = 0
    let lastTime = null
    let width = 0
    let height = 0
    let phase = 0
    let frame = { values: resting, level: 0 }
    let centerX = 0
    let centerY = 0
    let radius = 0
    let textureReady = false
    const texture = new Image()
    texture.decoding = 'async'

    function measure() {
      const box = canvas.getBoundingClientRect()
      width = box.width
      height = box.height
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      display.setTransform(dpr, 0, 0, dpr, 0, 0)
      const disc = canvas.parentElement.querySelector('.flow-disc-slot.is-current .flow-disc-position')
      const discBox = disc?.getBoundingClientRect()
      centerX = discBox ? discBox.left + discBox.width / 2 - box.left : width / 2
      centerY = discBox ? discBox.top + discBox.height / 2 - box.top : height * 0.53
      radius = discBox?.width ? discBox.width / 2 : Math.min(width, height) * 0.28
    }

    function draw(values, level) {
      display.clearRect(0, 0, width, height)
      if (!textureReady || !(width > 0 && height > 0) || state.current.trackKey == null) return
      // Use the supplied picture itself: its exact wisps, highlights and softness.
      // The record masks the inner portion, so the light starts beneath its edge.
      const size = radius * 4.2
      const breathing = 1 + Math.sin(phase * 0.48) * 0.012 + level * 0.005
      display.save()
      display.translate(centerX, centerY)
      display.rotate(phase * 0.055)
      display.scale(breathing, breathing)
      display.globalAlpha = 0.92 + level * 0.08
      display.drawImage(texture, -size / 2, -size / 2, size, size)
      display.restore()
    }

    function loop(now) {
      if (!running) return
      raf = requestAnimationFrame(loop)
      if (lastTime !== null && now - lastTime < FRAME_MS - 4) return
      const delta = lastTime === null ? 1 / 30 : (now - lastTime) / 1000
      lastTime = now
      frame = reader.supported ? reader.read(delta, state.current.playing) : { values: resting, level: 0 }
      const { values, level } = frame
      phase += Math.min(delta, 0.1)
      draw(values, level)
      if (!reader.supported) reader.pause()
    }

    function sync() {
      const { playing, enabled, screenActive } = state.current
      const next = playing && enabled && screenActive && inViewport &&
        !document.hidden && !reduced.matches && !held && !powerSave
      if (next && !running) {
        running = true
        lastTime = null
        measure()
        raf = requestAnimationFrame(loop)
      } else if (!next) {
        running = false
        cancelAnimationFrame(raf)
        reader.pause()
        frame = { values: resting, level: 0 }
        draw(resting, 0)
      }
    }
    syncRef.current = sync
    refreshRef.current = () => {
      reader.pause()
      frame = { values: resting, level: 0 }
      measure()
      draw(resting, 0)
      sync()
    }

    const ro = new ResizeObserver(() => { measure(); draw(frame.values, frame.level) })
    ro.observe(canvas)
    const io = new IntersectionObserver((entries) => {
      inViewport = entries[0]?.isIntersecting ?? true
      sync()
    })
    io.observe(canvas)
    const offHold = onHeavyAnimationsHold((value) => { held = value; sync() })
    const offPowerSave = onPowerSaveChange((value) => { powerSave = value; sync() })
    texture.onload = () => {
      textureReady = true
      draw(frame.values, frame.level)
    }
    texture.src = glowReference
    document.addEventListener('visibilitychange', sync)
    reduced.addEventListener('change', sync)
    measure()
    draw(resting, 0)
    sync()

    return () => {
      running = false
      cancelAnimationFrame(raf)
      reader.dispose()
      texture.onload = null
      ro.disconnect()
      io.disconnect()
      offHold()
      offPowerSave()
      document.removeEventListener('visibilitychange', sync)
      reduced.removeEventListener('change', sync)
      syncRef.current = null
      refreshRef.current = null
    }
  }, [])

  useEffect(() => { syncRef.current?.() }, [playing, enabled, screenActive])
  useEffect(() => { refreshRef.current?.() }, [trackKey, colors])

  return <canvas ref={canvasRef} className="hero-waveform" aria-hidden="true" />
}
