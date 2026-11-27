import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { shallow } from 'zustand/shallow'
import { Loader2, Pause, Play, SkipBack, SkipForward } from '@/components/icons'
import { spring } from 'motion'
import { animate } from 'motion/mini'
import { usePlayerStore } from '../store/playerStore'
import { useUiSettingsStore } from '../store/uiSettingsStore'
import { queueStep } from '../utils/playerQueue'
import { createCdTrackSwipe, updateCdTrackSwipe, cdTrackSwipeDirection, cdTrackSwipeVelocity } from '../utils/cdTrackSwipe'
import { createCdDiscSwipe } from '../utils/cdDiscSwipe'
import { haptic, HAPTIC } from '../utils/haptics'
import { skipForward } from '../services/playerTransport'
import { isSoftwareRendering } from '../utils/gpu'
import { resolveCoverUrl } from '../utils/media'
import { isLowQuality } from '../utils/streamQuality'
import { createDiscSpin, DISC_REVOLUTION_SECONDS, SOFTWARE_DISC_FPS } from '../utils/discSpin'
import { squareToQuadTransform, cdPointInQuad } from '../utils/cdProjection'
import { paintCdDiscArtwork, paintCdDiscReflection } from '../utils/cdDiscArtwork'
import { createCdBodyMotion, cdBodyKeyframes } from '../utils/cdBodyMotion'
import { createCdDiscExchange } from '../utils/cdDiscExchange'
import { createCdDiscNavigation } from '../utils/cdDiscNavigation'
import { cdDiscRecordKey, cdQueueRecords, parkCdDiscRecord } from '../utils/cdDiscRecords'
import { isCdQueueFrameReady } from '../utils/cdQueueHandoff'
import { useDiscCover } from '../hooks/useDiscCover'
import { useScreen } from '../hooks/useScreen'
import { usePowerSave } from '../hooks/usePowerSave'
import HeroDisc from './HeroDisc'
import CdQueueMotion from './CdQueueMotion'
import CdQueueDisc from './CdQueueDisc'
import './DesktopCdPlayer.css'

const SOFTWARE_DISC_SIZE = 512

const QueueDiscs = memo(function QueueDiscs({ mobile = false, snapshot = null, held = false, generation = 0, playedRecords, onCommit }) {
  const { active } = useScreen()
  const powerSave = usePowerSave()
  const swipeRef = useRef(null)
  const stripRef = useRef(null)
  const settleRef = useRef(null)
  const suppressClickRef = useRef(false)
  useEffect(() => () => settleRef.current?.stop(), [])
  const liveState = usePlayerStore((s) => ({
    currentTrack: s.currentTrack,
    queue: s.queue,
    currentIndex: s.currentIndex,
    isShuffle: s.isShuffle,
    shuffledOrder: s.shuffledOrder,
    currentShuffleIndex: s.currentShuffleIndex,
    dislikedTrackIds: s.dislikedTrackIds,
    dislikedTrackKeys: s.dislikedTrackKeys,
    flowPreview: s.flowPreview,
    flowPreload: s.flowPreload,
  }), shallow)
  const state = snapshot || liveState
  useLayoutEffect(() => {
    // Child disc slots have adopted their canvases before this parent effect.
    if (!held) onCommit?.()
  }, [snapshot, held, generation, onCommit])
  const discs = cdQueueRecords(state, mobile)
  const select = (direction) => {
    const player = usePlayerStore.getState()
    if (direction > 0) player.advanceBy(direction, 'cd_queue')
    else if (direction < 0) for (let count = 0; count < -direction; count++) player.previousTrack()
  }
  const position = (direction) => ({ '--queue-arc-x': direction, '--queue-arc-y': 0 })
  const settle = () => {
    const strip = stripRef.current
    if (!strip) return
    settleRef.current?.stop()
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!active || powerSave || reduced) strip.style.transform = ''
    else settleRef.current = animate(strip, { transform: 'translateX(0px)' }, { type: spring, bounce: 0, duration: 0.25 })
  }
  useEffect(() => {
    if (!active || powerSave) {
      swipeRef.current = null
      settleRef.current?.stop()
      if (stripRef.current) stripRef.current.style.transform = ''
    }
  }, [active, powerSave])
  const startSwipe = (event) => {
    suppressClickRef.current = false
    if (event.button !== 0 || !state.currentTrack) return
    settleRef.current?.stop()
    const transform = stripRef.current && getComputedStyle(stripRef.current).transform
    const offset = transform && transform !== 'none' ? new DOMMatrixReadOnly(transform).m41 : 0
    swipeRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, offset, dx: 0, time: event.timeStamp, velocity: 0, locked: false }
  }
  const moveSwipe = (event) => {
    const swipe = swipeRef.current
    if (!swipe || event.pointerId !== swipe.id) return
    const dx = event.clientX - swipe.x
    const dy = event.clientY - swipe.y
    if (!swipe.locked) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 10) return
      if (Math.abs(dy) > Math.abs(dx)) { swipeRef.current = null; settle(); return }
      swipe.locked = true
      suppressClickRef.current = true
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    const elapsed = event.timeStamp - swipe.time
    if (elapsed > 0) swipe.velocity = (dx - swipe.dx) / elapsed
    swipe.time = event.timeStamp
    swipe.dx = dx
    const available = queueStep(usePlayerStore.getState(), dx < 0 ? 1 : -1)
    const travel = available ? Math.max(-110, Math.min(110, dx + swipe.offset)) : (dx + swipe.offset) * 0.2
    if (stripRef.current) stripRef.current.style.transform = `translateX(${travel}px)`
  }
  const finishSwipe = (event) => {
    const swipe = swipeRef.current
    if (!swipe || event.pointerId !== swipe.id) return
    swipeRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    const velocity = event.timeStamp - swipe.time < 100 ? swipe.velocity : 0
    const projected = swipe.dx + velocity * 120
    if (event.type === 'pointerup' && swipe.locked && Math.abs(projected) > 42) {
      const direction = projected < 0 ? 1 : -1
      if (queueStep(usePlayerStore.getState(), direction)) select(direction)
    }
    settle()
  }
  const queue = (
    <CdQueueMotion layout="linear" navigationMotion={mobile} active={active && !held} powerSave={powerSave} position={state.isShuffle ? state.currentShuffleIndex : state.currentIndex}>
      {discs.map(({ track, direction, key }) => (
        <button type="button" key={key} data-queue-record={key} data-queue-direction={direction} data-queue-slot={direction} className={`cd-deck-queue-track${direction === 0 ? ' is-featured' : ''}${direction !== 0 && (direction < 0 || playedRecords?.has(key)) ? ' is-played' : ''}`} style={position(direction)} disabled={!state.currentTrack || direction === 0} onClick={() => select(direction)} aria-label={`${direction === 0 ? 'Текущий трек' : 'Включить'}: ${track.title || 'Без названия'}`} title={`${direction === 0 ? 'Текущий' : direction > 0 ? 'Следующий' : 'Предыдущий'}: ${track.title || 'Без названия'} — ${track.artist || 'Неизвестный исполнитель'}`}>
          <span className="cd-deck-queue-disc"><CdQueueDisc track={track} recordKey={key} slot={direction} generation={generation} featured={direction === 0} mobile={mobile} /></span>
          <span className="cd-deck-queue-copy"><strong>{track.title || 'Без названия'}</strong><span>{track.artist || 'Неизвестный исполнитель'}</span></span>
          {direction !== 0 && (direction > 0 ? <SkipForward className="cd-deck-queue-action" /> : <SkipBack className="cd-deck-queue-action" />)}
        </button>
      ))}
      {!discs.length && <p className="cd-deck-queue-empty">Пока нет треков</p>}
    </CdQueueMotion>
  )
  return mobile ? (
    <div className="cd-mobile-queue" data-swipe-ignore="" data-no-fast-tap="" aria-label="Очередь треков" onPointerDown={startSwipe} onPointerMove={moveSwipe} onPointerUp={finishSwipe} onPointerCancel={finishSwipe} onLostPointerCapture={(event) => {
      if (event.target === event.currentTarget) finishSwipe(event)
    }} onClickCapture={(event) => {
      if (suppressClickRef.current) { event.preventDefault(); event.stopPropagation() }
    }}>
      <div ref={stripRef} className="cd-mobile-queue-strip">{queue}</div>
    </div>
  ) : queue
})

function SoftwareDiscOverlay({ geometry, geometryRef, coverSrc, coverSettled, trackKey, active, powerSave, gestureRef, swipeRef, lid, softwareRendering, mobile = false, sceneApiRef, onArtworkChange }) {
  const bitmapSize = Math.round(SOFTWARE_DISC_SIZE * Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1)))
  const canvasRef = useRef(null)
  const overlayRef = useRef(null)
  const setOverlay = useCallback(node => {
    overlayRef.current = node
    swipeRef.current = node
  }, [swipeRef])
  const layerRef = useRef(null)
  const exchangeRef = useRef(null)
  const exchangeHeldRef = useRef(false)
  const reflectionRef = useRef(null)
  const seatLightRef = useRef(null)
  const landingAnimationsRef = useRef([])
  const artworkImageRef = useRef(null)
  const trackKeyRef = useRef(trackKey)
  trackKeyRef.current = trackKey
  const artworkChangeRef = useRef(onArtworkChange)
  const syncRef = useRef(null)
  const environmentRef = useRef(null)
  const visibleRef = useRef(geometry?.facing !== false)
  const inViewportRef = useRef(true)
  const [spin] = useState(() => createDiscSpin({ rampMs: 480 }))
  const hasGeometry = Boolean(geometry)
  const hubRatio = geometry?.hubRadiusRatio
  artworkChangeRef.current = onArtworkChange
  useLayoutEffect(() => {
    const latest = geometryRef.current || geometry
    if (!overlayRef.current || !latest) return
    overlayRef.current.style.transform = latest.transform || squareToQuadTransform(latest.quad, SOFTWARE_DISC_SIZE)
    overlayRef.current.style.visibility = latest.facing === false ? 'hidden' : 'visible'
  })
  environmentRef.current = { active, powerSave }

  useLayoutEffect(() => {
    if (!hasGeometry || !layerRef.current) return
    if (!canvasRef.current) {
      canvasRef.current = document.createElement('canvas')
      layerRef.current.append(canvasRef.current)
    }
    canvasRef.current.width = canvasRef.current.height = bitmapSize
  }, [bitmapSize, hasGeometry])

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !hasGeometry) return undefined
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    const exchange = createCdDiscExchange({
      canvas, layer: layerRef.current,
      paint(image, targetCanvas) {
        artworkImageRef.current = image
        const currentCanvas = targetCanvas || canvasRef.current
        currentCanvas.dataset.cdTrackId = String(trackKeyRef.current ?? '')
        paintCdDiscArtwork(currentCanvas.getContext('2d'), bitmapSize, hubRatio, image)
        currentCanvas.dataset.cdTextureVersion = String(Number(currentCanvas.dataset.cdTextureVersion || 0) + 1)
        currentCanvas.dataset.cdArtworkReady = 'true'
      },
      onCanvas(next) {
        canvasRef.current = next
        gestureRef.current?.setCanvas(next)
        for (const animation of landingAnimationsRef.current) animation.cancel()
        landingAnimationsRef.current = []
        const environment = environmentRef.current
        if (!environment.active || environment.powerSave || reduced.matches || document.hidden ||
            !visibleRef.current || !inViewportRef.current) return
        // The real canvas has landed. Keep seating independent of its spin
        // so neither the artwork nor the exchange coordinates are replaced.
        const record = layerRef.current
        if (typeof record?.animate === 'function') {
          const seating = record.animate([
            { transform: 'scale(1.012)' },
            { offset: 0.55, transform: 'scale(0.998)' },
            { transform: 'scale(1)' },
          ], { duration: 180, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)' })
          seating.id = 'cd-disc-seat'
          landingAnimationsRef.current.push(seating)
        }
        if (mobile && typeof seatLightRef.current?.animate === 'function') {
          const light = seatLightRef.current.animate([
            { opacity: 0 }, { offset: 0.35, opacity: 0.24 }, { opacity: 0 },
          ], { duration: 180, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)' })
          light.id = 'cd-disc-seat-light'
          landingAnimationsRef.current.push(light)
        }
        sceneApiRef.current?.seatDisc()
      },
      // A disc change is a one-off transition, not background animation:
      // battery saving and a briefly turned-away disc must not cut it short.
      canAnimate: () => environmentRef.current.active && inViewportRef.current &&
        !reduced.matches && !document.hidden,
      align: () => sceneApiRef.current?.beginDiscExchange(),
      onHold(held) {
        exchangeHeldRef.current = held
        if (held) {
          for (const animation of landingAnimationsRef.current) animation.cancel()
          landingAnimationsRef.current = []
        }
        syncRef.current?.()
      },
      onSlide: value => sceneApiRef.current?.setDiscExchangeSliding(value),
      onChange: () => artworkChangeRef.current?.(),
      // Blur/brightness are raster effects: on phones they keep the disc on
      // the main thread and it freezes whenever React paints the next queue.
      animateFilter: !mobile,
      // The queue neighbors sit outside the phone viewport, so dimming the
      // incoming record only makes the tray show through it.
      animateOpacity: !mobile,
    })
    exchangeRef.current = exchange
    const sync = () => exchange.sync()
    document.addEventListener('visibilitychange', sync)
    reduced.addEventListener('change', sync)
    return () => {
      exchange.dispose()
      for (const animation of landingAnimationsRef.current) animation.cancel()
      landingAnimationsRef.current = []
      exchangeRef.current = null
      document.removeEventListener('visibilitychange', sync)
      reduced.removeEventListener('change', sync)
    }
  }, [bitmapSize, hasGeometry, hubRatio, mobile, sceneApiRef])

  useLayoutEffect(() => { exchangeRef.current?.sync() }, [active, powerSave, geometry?.facing])


  useLayoutEffect(() => { syncRef.current?.() }, [active, powerSave])
  useLayoutEffect(() => {
    visibleRef.current = geometry?.facing !== false
    syncRef.current?.()
  }, [geometry?.facing])

  // Reflections depend on the lid, not on which album is underneath it.
  useLayoutEffect(() => {
    const ctx = reflectionRef.current?.getContext('2d', { alpha: true })
    if (ctx && hasGeometry) {
      paintCdDiscReflection(ctx, bitmapSize, hubRatio, lid === 'smoked')
      reflectionRef.current.dataset.cdTextureVersion = String(Number(reflectionRef.current.dataset.cdTextureVersion || 0) + 1)
      artworkChangeRef.current?.()
    }
  }, [bitmapSize, hasGeometry, hubRatio, lid])

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d', { alpha: true })
    if (!ctx || !hasGeometry) return
    paintCdDiscArtwork(ctx, bitmapSize, hubRatio, artworkImageRef.current)
    canvas.dataset.cdTextureVersion = String(Number(canvas.dataset.cdTextureVersion || 0) + 1)
    artworkChangeRef.current?.()
  }, [bitmapSize, hasGeometry, hubRatio])

  // Keep the last painted disc while the next cover loads. This effect owns
  // only artwork; track changes must not remove the canvas or restart its spin.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !hasGeometry) return undefined
    if (!coverSrc) {
      if (coverSettled) exchangeRef.current?.setArtwork(null, trackKey)
      return undefined
    }
    if (artworkImageRef.current?.src === new URL(coverSrc, document.baseURI).href) {
      exchangeRef.current?.setArtwork(artworkImageRef.current, trackKey)
      return undefined
    }
    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) return undefined
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.decoding = 'async'
    let disposed = false
    let retriedWithoutCors = false
    image.onload = () => {
      if (disposed || !image.naturalWidth || !image.naturalHeight) return
      exchangeRef.current?.setArtwork(image, trackKey)
    }
    image.onerror = () => {
      // Legacy storage may omit ACAO. Retry without CORS, preserving the
      // already painted disc if that request also fails.
      if (disposed) return
      if (retriedWithoutCors) { exchangeRef.current?.failArtwork(trackKey); return }
      retriedWithoutCors = true
      image.removeAttribute('crossorigin')
      image.src = ''
      image.src = coverSrc
    }
    image.src = coverSrc
    return () => {
      disposed = true
      image.onload = null
      image.onerror = null
    }
  }, [bitmapSize, coverSrc, coverSettled, trackKey, hasGeometry, hubRatio])

  useEffect(() => {
    let canvas = canvasRef.current
    if (!canvas || !hasGeometry) return undefined
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    let inViewport = true
    let timer = 0
    spin.setEnabled(false)
    const duration = DISC_REVOLUTION_SECONDS * 1000
    // Paint once, then share the chassis's bounded cadence. The two native
    // animations update together instead of compositing every display refresh.
    const frameRate = softwareRendering ? SOFTWARE_DISC_FPS : 60
    const animateDisc = target => {
      const animation = target.animate([
        { transform: 'rotate(0turn)' }, { transform: 'rotate(1turn)' },
      ], { duration, iterations: Infinity, easing: `steps(${DISC_REVOLUTION_SECONDS * frameRate}, end)` })
      animation.id = 'cd-software-disc-spin'
      animation.pause()
      animation.currentTime = 0
      return animation
    }
    let animation = animateDisc(canvas)
    let rampAnimation = null
    let lastTrack = null

    const sync = (state = usePlayerStore.getState()) => {
      const { active, powerSave } = environmentRef.current
      if (!active || powerSave || reduced.matches || document.hidden || !visibleRef.current || !inViewport) {
        for (const landing of landingAnimationsRef.current) landing.cancel()
        landingAnimationsRef.current = []
      }
      if (exchangeHeldRef.current) {
        rampAnimation?.cancel()
        rampAnimation = null
        spin.setEnabled(false)
        animation.pause()
        clearTimeout(timer)
        return
      }
      const audioReady = state.audibleTrackId === state.currentTrack?.id || state.currentTime > 0
      spin.sync({ ...state, isPlaying: state.isPlaying && audioReady })
      spin.setEnabled(!exchangeHeldRef.current && visibleRef.current && inViewport && active && !powerSave && !reduced.matches && !document.hidden)
      const at = performance.now()
      const track = state.currentTrack?.id ?? state.currentTrack ?? null
      const running = spin.isAnimating(at)
      if (!running || track !== lastTrack) {
        rampAnimation?.cancel()
        rampAnimation = null
      }
      const rampRemaining = spin.rampRemainingMs(at)
      if (running && !rampAnimation && rampRemaining > 8 && typeof canvas.animate === 'function') {
        animation.pause()
        // Sample the integrated acceleration curve into one native animation.
        // Audio ticks renew its deadline without restarting the motor ramp.
        const count = Math.max(2, Math.ceil(rampRemaining * frameRate / 1000) + 1)
        const keyframes = Array.from({ length: count }, (_, index) => {
          const offset = index / (count - 1)
          return { offset, transform: `rotate(${spin.angle(at + offset * rampRemaining)}rad)` }
        })
        rampAnimation = canvas.animate(keyframes, { duration: rampRemaining, easing: 'linear' })
        rampAnimation.id = 'cd-disc-spin-up'
        rampAnimation.cdSpinFrames = keyframes
        rampAnimation.cdSpinDuration = rampRemaining
        const current = rampAnimation
        rampAnimation.onfinish = () => {
          if (rampAnimation !== current) return
          current.cancel()
          rampAnimation = null
          sync()
        }
      }
      // Ordinary audio ticks only renew the stall deadline. Reassigning
      // currentTime each tick restarts interpolation in Firefox.
      if (!rampAnimation && (!running || animation.playState !== 'running' || track !== lastTrack)) {
        animation.pause()
        animation.currentTime = ((spin.angle(at) / (Math.PI * 2)) % 1 + 1) % 1 * duration
        if (running) animation.play()
      }
      lastTrack = track
      clearTimeout(timer)
      if (running) timer = window.setTimeout(() => sync(), spin.remainingMs(at) + 1)
    }
    gestureRef.current = {
      setCanvas(next) {
        if (next === canvas) return
        // A new disc starts at the pose it arrived in. Retargeting the old
        // animation exposes its frozen rotation before sync resets the phase.
        animation.cancel()
        rampAnimation?.cancel()
        rampAnimation = null
        canvas = next
        spin.setEnabled(false)
        spin.reset()
        animation = animateDisc(canvas)
        observer.disconnect()
        observer.observe(canvas.parentElement)
      },
      changeDisc(direction, transfer, onComplete, targetKey) { exchangeRef.current?.begin(direction, transfer, onComplete, targetKey) },
      expedite() { exchangeRef.current?.expedite() },
      settleQueueHandoffs() { exchangeRef.current?.settleQueueHandoffs() },
      setVisible(visible) {
        if (visibleRef.current === visible) return
        visibleRef.current = visible
        sync()
      },
      turn(progress) {
        spin.turn(progress)
        sync()
      },
      release() {
        spin.release()
        sync()
      },
    }
    syncRef.current = () => sync()
    const onEnvironmentChange = () => sync()
    const unsubscribe = usePlayerStore.subscribe((state, previous) => {
      if (state.currentTime !== previous.currentTime || state.isPlaying !== previous.isPlaying ||
          state.duration !== previous.duration || state.currentTrack !== previous.currentTrack ||
          state.audibleTrackId !== previous.audibleTrackId) sync(state)
    })
    const observer = new IntersectionObserver(([entry]) => {
      inViewport = entry.isIntersecting
      inViewportRef.current = inViewport
      exchangeRef.current?.sync()
      sync()
    })
    observer.observe(canvas.parentElement)
    document.addEventListener('visibilitychange', onEnvironmentChange)
    reduced.addEventListener('change', onEnvironmentChange)
    sync()
    return () => {
      spin.setEnabled(false)
      clearTimeout(timer)
      animation.cancel()
      rampAnimation?.cancel()
      rampAnimation = null
      observer.disconnect()
      syncRef.current = null
      gestureRef.current = null
      unsubscribe()
      document.removeEventListener('visibilitychange', onEnvironmentChange)
      reduced.removeEventListener('change', onEnvironmentChange)
    }
  }, [bitmapSize, gestureRef, hasGeometry, spin, softwareRendering])

  if (!geometry) return null
  return <span
    ref={setOverlay}
    className="cd-deck-software-disc"
    style={{
      left: 0,
      top: 0,
      width: SOFTWARE_DISC_SIZE,
      height: SOFTWARE_DISC_SIZE,
      transform: geometry.transform || squareToQuadTransform(geometry.quad, SOFTWARE_DISC_SIZE),
      transformOrigin: '0 0',
      visibility: geometry.facing === false ? 'hidden' : 'visible',
    }}
    aria-hidden="true"
  ><span ref={layerRef} className="cd-deck-disc-record" data-cd-disc-slot="current" />
    <canvas ref={reflectionRef} className="cd-deck-disc-reflection" width={bitmapSize} height={bitmapSize} />
    {mobile && <span ref={seatLightRef} className="cd-deck-disc-seat-light" />}
  </span>
}

function DesktopCdPlayer({ onPlay, onStartFlow = onPlay, busy = false, intentHandlers, presentation = 'default', interactive = true, onReady }) {
  const setupPreview = presentation === 'setup'
  const mobile = presentation === 'mobile'
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const preview = usePlayerStore((s) => s.flowPreview || s.flowPreload)
  const [visualTrack, setVisualTrack] = useState(currentTrack)
  const track = visualTrack || preview?.tracks?.[0]
  const heavyCoverAllowed = usePlayerStore((s) => !s.currentTrack || !s.isPlaying ||
    (s.heavyCoverTrackId === s.currentTrack.id || (s.audibleTrackId === s.currentTrack.id && !isLowQuality())))
  const { src: coverSrc, settled: coverSettled } = useDiscCover(resolveCoverUrl(track?.cover_url, 'card'), resolveCoverUrl(track?.cover_url, 'hero'), 'auto', {
    allowUpgrade: heavyCoverAllowed,
  })
  const { active: screenActive } = useScreen()
  const powerSave = usePowerSave()
  const liteMode = useUiSettingsStore((s) => s.liteMode)
  const appearance = useUiSettingsStore((s) => s.cdPlayerAppearance)
  // The user may disable lite mode even without hardware acceleration. Keep
  // the deck on its software-safe renderer in that case: full WebGL effects
  // can lose the context and would replace the chassis with the disc fallback.
  const safeRendering = liteMode || isSoftwareRendering()
  const cachedRendering = !setupPreview || safeRendering
  const canvasRef = useRef(null)
  const sceneRef = useRef(null)
  const motionRef = useRef(null)
  const pointerPlaneRef = useRef(null)
  const seekPointerPlaneRef = useRef(null)
  const bodyRef = useRef(null)
  const bodyAnimationRef = useRef(null)
  const bodyMotionRef = useRef(null)
  const swipeAnimationRef = useRef(null)
  const discSwipeRef = useRef(null)
  const discSwipeMotionRef = useRef(null)
  const enteredRef = useRef(false)
  const hoverActionRef = useRef(null)
  const sceneApiRef = useRef(null)
  const softwareDiscApiRef = useRef(null)
  const onQueueCommit = useCallback(() => softwareDiscApiRef.current?.settleQueueHandoffs(), [])
  const discNavigationRef = useRef(null)
  const discControlRef = useRef(null)
  const playbackControlRef = useRef(null)
  const playbackPositionRef = useRef(null)
  const discOverlayFrameRef = useRef(0)
  const pendingDiscOverlayRef = useRef(null)
  const mountedRef = useRef(false)
  const closingRef = useRef(false)
  const latestRef = useRef(null)
  const dragRef = useRef(null)
  const [interacting, setInteracting] = useState(false)
  const [modelStatus, setModelStatus] = useState('loading')
  const [lidClosing, setLidClosing] = useState(false)
  const [discOverlay, setDiscOverlay] = useState(null)
  const [queueDisplay, setQueueDisplay] = useState(() => ({ snapshot: usePlayerStore.getState(), held: false, generation: 0 }))
  const { snapshot: queueSnapshot, held: queueHeld, generation: queueGeneration } = queueDisplay
  const setQueueSnapshot = snapshot => setQueueDisplay(state => ({ ...state, snapshot }))
  const setQueueHeld = held => setQueueDisplay(state => ({ ...state, held }))
  const setQueueGeneration = update => setQueueDisplay(state => ({ ...state, generation: update(state.generation) }))
  const playedRecordsRef = useRef(new Set())
  const queueHeldRef = useRef(false)
  const discGeometryRef = useRef(null)
  const [playbackRequested, setPlaybackRequested] = useState(false)
  const initialPlayback = !currentTrack && !playbackRequested
  const deckBusy = busy || lidClosing
  const playbackMotionEligible = !setupPreview && screenActive &&
    !powerSave && !liteMode && !deckBusy && modelStatus === 'ready'
  const playbackMotionAllowed = playbackMotionEligible && Boolean(currentTrack) && isPlaying
  const playbackMotionActive = playbackMotionAllowed && !interacting && !queueHeld && !discSwipeMotionRef.current && !discNavigationRef.current?.isBusy()
  const playbackLabel = deckBusy ? 'Запускаем поток рекомендаций…'
    : !currentTrack ? 'Включить поток рекомендаций'
      : isPlaying ? 'Приостановить воспроизведение' : 'Продолжить воспроизведение'
  latestRef.current = { busy: deckBusy, coverSrc, screenActive, powerSave, appearance, initialPlayback, playbackMotionActive, playbackMotionEligible }
  useEffect(() => {
    if (!queueHeldRef.current && !discNavigationRef.current?.isBusy()) {
      setQueueSnapshot(usePlayerStore.getState())
      setVisualTrack(usePlayerStore.getState().currentTrack)
    }
    return usePlayerStore.subscribe((next, previous) => {
      if (queueHeldRef.current || discNavigationRef.current?.isBusy()) return
      const changedTrack = next.currentTrack?.id !== previous.currentTrack?.id
      if (changedTrack && previous.currentTrack && next.currentTrack && modelStatus === 'ready') return
      if (['currentTrack', 'queue', 'currentIndex', 'isShuffle', 'shuffledOrder', 'currentShuffleIndex',
        'dislikedTrackIds', 'dislikedTrackKeys', 'flowPreview', 'flowPreload'].some(key => next[key] !== previous[key])) {
        setQueueSnapshot(next)
        if (changedTrack) { setVisualTrack(next.currentTrack); discNavigationRef.current?.reset(next) }
      }
    })
  }, [modelStatus])
  const animateBody = (action) => {
    const body = bodyRef.current
    const previous = bodyAnimationRef.current
    const disabled = !latestRef.current.screenActive || latestRef.current.powerSave || document.hidden ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!body || !action || disabled) {
      previous?.cancel()
      bodyAnimationRef.current = null
      bodyMotionRef.current = null
      return
    }
    const motion = createCdBodyMotion(action, bodyMotionRef.current, previous?.currentTime ?? 0)
    if (!motion || typeof body.animate !== 'function') return
    previous?.cancel()
    const animation = body.animate(cdBodyKeyframes(motion), { duration: motion.duration, easing: 'linear' })
    animation.id = 'cd-player-action'
    bodyAnimationRef.current = animation
    bodyMotionRef.current = motion
    animation.onfinish = () => {
      if (bodyAnimationRef.current === animation) {
        bodyAnimationRef.current = null
        bodyMotionRef.current = null
      }
    }
  }
  useEffect(() => () => {
    bodyAnimationRef.current?.cancel()
    swipeAnimationRef.current?.stop()
    discSwipeMotionRef.current?.clear()
  }, [])
  useLayoutEffect(() => {
    if (!screenActive || modelStatus === 'loading' || enteredRef.current || document.hidden) return undefined
    enteredRef.current = true
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    const scene = sceneRef.current
    if (powerSave || reduced.matches || typeof scene?.animate !== 'function') return undefined
    const animation = scene.animate([
      { opacity: 0, transform: setupPreview ? 'translate(20px, 12px) scale(0.97)' : 'translateY(100%)' },
      { opacity: 1, transform: 'none' },
    ], { duration: 300, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' })
    const cancel = () => animation.cancel()
    const onVisibility = () => { if (document.hidden) cancel() }
    reduced.addEventListener('change', cancel)
    document.addEventListener('visibilitychange', onVisibility)
    return () => { animation.cancel(); reduced.removeEventListener('change', cancel); document.removeEventListener('visibilitychange', onVisibility) }
  }, [screenActive, modelStatus, powerSave, setupPreview])

  useLayoutEffect(() => { sceneApiRef.current?.setPlaybackMotionEnabled(playbackMotionActive) }, [playbackMotionActive])

  useEffect(() => {
    mountedRef.current = true
    let disposed = false
    let api = null
    let unsubscribe = null
    const sceneLoad = new AbortController()
    const hero = sceneRef.current?.closest('.hero-section')
    const stage = sceneRef.current?.closest('.cd-deck-stage')
    const header = hero?.parentElement.querySelector('.mobile-header')
    const positionSource = ({ y }) => {
      if (disposed || !hero || !stage) return
      const heroTop = hero.getBoundingClientRect().top
      const headerBounds = header?.getBoundingClientRect()
      const headerBottom = headerBounds?.height ? headerBounds.bottom : heroTop
      const chassisTop = stage.getBoundingClientRect().top + y
      // Center the source between the brow and the resting visible chassis.
      const center = `${((headerBottom + chassisTop) / 2 - heroTop).toFixed(3)}px`
      if (hero.style.getPropertyValue('--cd-source-center-y') !== center) hero.style.setProperty('--cd-source-center-y', center)
    }
    const queueDiscOverlay = (geometry) => {
      if (disposed) return
      discGeometryRef.current = geometry
      if (geometry?.quad) {
        const projection = geometry.transform || squareToQuadTransform(geometry.quad, SOFTWARE_DISC_SIZE)
        const discMatrix = new DOMMatrix(projection)
        const center = discMatrix.transformPoint({ x: SOFTWARE_DISC_SIZE / 2, y: SOFTWARE_DISC_SIZE / 2 })
        const x = center.x / center.w, y = center.y / center.w
        if (Number.isFinite(x) && Number.isFinite(y)) {
          {
            const root = sceneRef.current?.closest('.desktop-cd-player')
            const left = discMatrix.transformPoint({ x: 0, y: SOFTWARE_DISC_SIZE / 2 })
            const right = discMatrix.transformPoint({ x: SOFTWARE_DISC_SIZE, y: SOFTWARE_DISC_SIZE / 2 })
            const lens = parseFloat(motionRef.current?.style.getPropertyValue('--cd-camera-lens')) || 1100
            const originX = parseFloat(motionRef.current?.style.getPropertyValue('--cd-motion-origin-x')) || x
            const originY = parseFloat(motionRef.current?.style.getPropertyValue('--cd-motion-origin-y')) || y
            const project = point => {
              const depth = point.z / lens, w = point.w - depth
              return { x: (point.x - originX * depth) / w, y: (point.y - originY * depth) / w }
            }
            const projectedCenter = project(center), projectedLeft = project(left), projectedRight = project(right)
            const diameter = Math.hypot(projectedRight.x - projectedLeft.x, projectedRight.y - projectedLeft.y)
            const sceneBounds = sceneRef.current?.getBoundingClientRect()
            const rootBounds = root?.getBoundingClientRect()
            root?.style.setProperty('--cd-queue-center-x', `${projectedCenter.x + (mobile ? sceneBounds.left - rootBounds.left : 0)}px`)
            root?.style.setProperty('--cd-queue-center-y', `${projectedCenter.y + (mobile ? sceneBounds.top - rootBounds.top : -20)}px`)
            root?.style.setProperty('--cd-queue-disc-size', `${diameter}px`)
          }
          // The control faces the screen while the disc tilts. Clear the
          // nearest edge of the disc across the control's entire 32px radius.
          const determinant = discMatrix.m11 * discMatrix.m22 - discMatrix.m21 * discMatrix.m12
          const slopeX = determinant ? (discMatrix.m13 * discMatrix.m22 - discMatrix.m23 * discMatrix.m12) / determinant : 0
          const slopeY = determinant ? (discMatrix.m23 * discMatrix.m11 - discMatrix.m13 * discMatrix.m21) / determinant : 0
          const clearance = geometry.transform ? 2 + 32 * Math.hypot(slopeX, slopeY) : 0
          playbackPositionRef.current = {
            '--cd-playback-x': `${x}px`, '--cd-playback-y': `${y}px`,
            '--cd-playback-z': `${center.z / center.w + clearance}px`,
            '--cd-disc-projection': projection,
          }
          const control = playbackControlRef.current
          if (control) {
            for (const [property, value] of Object.entries(playbackPositionRef.current)) control.style.setProperty(property, value)
            control.classList.toggle('has-disc-projection', !mobile)
          }
        }
      } else {
        playbackPositionRef.current = null
        const control = playbackControlRef.current
        for (const property of ['--cd-playback-x', '--cd-playback-y', '--cd-playback-z', '--cd-disc-projection']) control?.style.removeProperty(property)
        control?.classList.remove('has-disc-projection')
      }
      if (geometry && cachedRendering) {
        // Cached 2D turns already include the projected disc pose. Apply it
        // directly; artwork and its native spin stay live without React frames.
        const overlay = canvasRef.current?.parentElement.querySelector('.cd-deck-software-disc')
        const visibility = geometry.facing === false ? 'hidden' : 'visible'
        if (overlay) {
          overlay.style.transform = geometry.transform || squareToQuadTransform(geometry.quad, SOFTWARE_DISC_SIZE)
          overlay.style.visibility = visibility
          softwareDiscApiRef.current?.setVisible(geometry.facing !== false)
        }
        const control = discControlRef.current
        if (control) {
          control.style.transform = geometry.transform || squareToQuadTransform(geometry.quad, SOFTWARE_DISC_SIZE)
          control.style.visibility = visibility
        }
        if (overlay) return
      }
      pendingDiscOverlayRef.current = geometry
      if (discOverlayFrameRef.current) return
      discOverlayFrameRef.current = requestAnimationFrame(() => {
        discOverlayFrameRef.current = 0
        if (!disposed) setDiscOverlay(pendingDiscOverlayRef.current)
      })
    }
    const fallback = () => {
      if (disposed) return
      cancelAnimationFrame(discOverlayFrameRef.current)
      discOverlayFrameRef.current = 0
      pendingDiscOverlayRef.current = null
      unsubscribe?.()
      discNavigationRef.current?.dispose()
      discNavigationRef.current = null
      api?.dispose()
      api = null
      sceneApiRef.current = null
      dragRef.current = null
      setDiscOverlay(null)
      setInteracting(false)
      setModelStatus('fallback')
    }
    // Load Three.js only when the CD player is mounted.
    import('../utils/cdDeckScene').then(async ({ createCdDeckScene }) => {
      if (disposed) return
      const navigation = createCdDiscNavigation({
        initial: usePlayerStore.getState(),
        expedite: () => {
          sceneApiRef.current?.expediteDiscExchange()
          softwareDiscApiRef.current?.expedite()
        },
        apply(state) {
          if (disposed) return
          queueHeldRef.current = false
          setQueueDisplay(previous => ({ snapshot: state, held: false, generation: previous.generation + 1 }))
          setVisualTrack(state.currentTrack)
        },
        move: (direction, previous, next, done) => {
          const departingKey = cdDiscRecordKey(previous.currentTrack, previous.currentIndex)
          playedRecordsRef.current.add(departingKey)
          const root = sceneRef.current?.closest('.desktop-cd-player')
          const key = cdDiscRecordKey(next.currentTrack, next.currentIndex)
          const record = [...root?.querySelectorAll('[data-queue-record]') || []]
            .find(node => node.dataset.queueRecord === key)
          const source = discSwipeMotionRef.current?.incomingFor(key) || record?.querySelector('.hero-disc')
          const incoming = source?.querySelector('canvas') ? source : null
          const neighbor = queueStep(previous, direction)
          const queue = root?.querySelector('.cd-deck-queue')
          const position = previous.isShuffle ? previous.currentShuffleIndex : previous.currentIndex
          if (!setupPreview && neighbor &&
            cdDiscRecordKey(previous.queue[neighbor.index], neighbor.index) === key &&
            (!incoming || !(isCdQueueFrameReady(queue, position, record, direction) ||
              discSwipeMotionRef.current?.incomingFor(key) && queue?.dataset.cdQueuePosition === String(position) && record?.dataset.queueSlot === String(direction)))) {
            // A prior handoff can finish before React commits its queue slots.
            // Render the visible queue first; never replay a stand-in disc.
            setQueueSnapshot(previous)
            setQueueGeneration(value => value + 1)
            return false
          }
          let transfer = null
          if (incoming) {
            const nextSlots = new Map(cdQueueRecords(next, mobile).map(record => [record.key, record.direction]))
            const keepsDeparture = nextSlots.get(departingKey) === -direction
            // A disliked disc leaves the queue. The preceding eligible disc
            // already occupies the free slot and should stay in place.
            const previousRecord = root.querySelector(`[data-queue-slot="${-direction}"]`)
            const previousSlot = nextSlots.get(previousRecord?.dataset.queueRecord)
            const movesPrevious = keepsDeparture && previousRecord && (previousSlot == null || previousSlot === -direction * 2)
            const swipe = discSwipeMotionRef.current
            const outgoing = movesPrevious
              ? swipe?.incomingFor(previousRecord.dataset.queueRecord) || previousRecord.querySelector('.hero-disc')
              : null
            const placement = swipe?.placementFor(key)
            // Return borrowed queue nodes before the exchange measures them,
            // retaining the finger's offset on the shared belt's first frame.
            const prepare = swipe ? () => {
              const offset = swipe.prepare()
              discSwipeMotionRef.current = null
              sceneApiRef.current?.setDiscSwipeActive(false)
              return offset
            } : undefined
            transfer = {
              incoming, parent: placement?.parent || incoming.parentElement, nextSibling: placement ? placement.nextSibling : incoming.nextSibling,
              style: placement ? placement.style : incoming.style.cssText, outgoing, outgoingVisibility: outgoing?.style.visibility,
              prepare,
              swipe: mobile && swipe && keepsDeparture ? () => swipe.release(direction) : null,
              incomingOpacity: mobile ? 1 : Number(getComputedStyle(incoming).opacity),
              incomingFilter: mobile ? 'none' : getComputedStyle(incoming).filter,
              outgoingOpacity: keepsDeparture ? (mobile ? 1 : 0.72) : 0,
              outgoingFilter: mobile ? 'none' : 'brightness(0.88) blur(2px)',
              outgoingTargetSlot: previousSlot,
              horizontal: true,
              preservePrevious: true,
              extras: [...root.querySelectorAll('[data-queue-record]')].flatMap(record => {
                const slot = Number(record.dataset.queueSlot)
                const targetSlot = nextSlots.get(record.dataset.queueRecord)
                const node = record.querySelector('.hero-disc')
                return Math.abs(slot) > 1 && node && (targetSlot == null || targetSlot === slot - direction)
                  ? [{ node, targetSlot }] : []
              }),
              alignQueue: target => {
                const bounds = root.getBoundingClientRect()
                root.style.setProperty('--cd-queue-center-x', `${target.left + target.width / 2 - bounds.left}px`)
                root.style.setProperty('--cd-queue-center-y', `${target.top + target.height / 2 - bounds.top}px`)
                root.style.setProperty('--cd-queue-disc-size', `${target.width}px`)
              },
              park: keepsDeparture ? record => parkCdDiscRecord(departingKey, record) : undefined,
            }
          }
          const controls = softwareDiscApiRef.current
          if (!controls) { done(); return }
          queueHeldRef.current = true
          setQueueHeld(true)
          setVisualTrack(next.currentTrack)
          controls.changeDisc(direction, transfer, done, next.currentTrack?.id)
        },
      })
      discNavigationRef.current = navigation
      api = await createCdDeckScene(canvasRef.current, {
        signal: sceneLoad.signal,
        appearance: latestRef.current.appearance,
        onError: fallback,
        softwareRendering: safeRendering,
        presentation,
        playbackElement: motionRef.current,
        mapPointer: (clientX, clientY, seeking = false) => {
          const corners = (seeking ? seekPointerPlaneRef : pointerPlaneRef).current?.children
          if (!corners || corners.length !== 4) return null
          const quad = Array.from(corners, corner => {
            const rect = corner.getBoundingClientRect()
            return { x: rect.left, y: rect.top }
          })
          return cdPointInQuad(quad, clientX, clientY)
        },
        // Project poses directly onto the live disc; camera frames need no
        // React commits.
        onDiscOverlayChange: mobile || cachedRendering ? queueDiscOverlay : undefined,
        onFramingChange: mobile ? positionSource : undefined,
        onAction: animateBody,
        onDiscChange: (_direction, _previous, next) => navigation.request(next),
      })
      if (disposed) { api.dispose(); api = null; return }
      sceneApiRef.current = api
      const latest = latestRef.current
      api.setActive(latest.screenActive)
      api.setPowerSave(latest.powerSave)
      api.setInitialPlayback(latest.initialPlayback)
      api.setAppearance(latest.appearance)
      api.setState(usePlayerStore.getState(), latest.busy)
      api.setPlaybackMotionEnabled(latest.playbackMotionActive)
      api.setCover(latest.coverSrc)
      unsubscribe = usePlayerStore.subscribe((state, previous) => {
        if (['currentTrack', 'currentTime', 'currentIndex', 'duration', 'volume', 'isPlaying', 'isShuffle', 'isRepeatOne', 'source'].some((key) => state[key] !== previous[key])) {
          api?.setState(state, latestRef.current.busy)
        }
      })
      setModelStatus('ready')
    }).catch(fallback)
    return () => {
      mountedRef.current = false
      disposed = true
      sceneLoad.abort()
      clearTimeout(dragRef.current?.holdTimer)
      cancelAnimationFrame(discOverlayFrameRef.current)
      discOverlayFrameRef.current = 0
      pendingDiscOverlayRef.current = null
      unsubscribe?.()
      discNavigationRef.current?.dispose()
      discNavigationRef.current = null
      api?.dispose()
      sceneApiRef.current = null
      hero?.style.removeProperty('--cd-source-center-y')
    }
  }, [safeRendering, cachedRendering, presentation, mobile])

  useEffect(() => { if (modelStatus === 'ready' || modelStatus === 'fallback') onReady?.() }, [modelStatus, onReady])
  useEffect(() => { sceneApiRef.current?.setCover(coverSrc) }, [coverSrc])
  useEffect(() => { sceneApiRef.current?.setAppearance(appearance) }, [appearance])
  useEffect(() => { sceneApiRef.current?.setState(usePlayerStore.getState(), deckBusy) }, [deckBusy])
  useLayoutEffect(() => { sceneApiRef.current?.setInitialPlayback(initialPlayback) }, [initialPlayback])
  useLayoutEffect(() => { sceneApiRef.current?.setActive(screenActive) }, [screenActive])
  useEffect(() => { sceneApiRef.current?.setPowerSave(powerSave) }, [powerSave])

  useEffect(() => {
    const cancelGesture = () => {
      const drag = dragRef.current
      resetSwipeMotion(true)
      if (!drag) return
      clearTimeout(drag.holdTimer)
      dragRef.current = null
      setInteracting(false)
      if (drag.mode === 'seek') {
        sceneApiRef.current?.releaseDisc(true)
        softwareDiscApiRef.current?.release()
      } else if (drag.mode === 'button') sceneApiRef.current?.press(drag.action, false)
      const scene = sceneRef.current
      if (scene?.hasPointerCapture(drag.id)) scene.releasePointerCapture(drag.id)
      restorePlaybackMotion()
    }
    if (!screenActive || powerSave || dragRef.current && dragRef.current.trackId !== currentTrack?.id) cancelGesture()
    const onVisibility = () => { if (document.hidden) cancelGesture() }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('blur', cancelGesture)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('blur', cancelGesture)
    }
  }, [screenActive, powerSave, currentTrack?.id])

  useEffect(() => {
    const control = discControlRef.current
    if (!mobile || !control) return undefined
    const preventPageScroll = (event) => {
      if (event.cancelable) event.preventDefault()
    }
    control.addEventListener('touchmove', preventPageScroll, { passive: false })
    return () => control.removeEventListener('touchmove', preventPageScroll)
  }, [mobile, modelStatus])

  const resetRotation = () => sceneApiRef.current?.reset()
  const resetSwipeMotion = (immediate = false) => {
    const disc = discSwipeRef.current
    swipeAnimationRef.current?.stop()
    swipeAnimationRef.current = null
    const finish = () => {
      discSwipeMotionRef.current?.clear()
      discSwipeMotionRef.current = null
      if (disc) disc.style.translate = ''
      sceneApiRef.current?.setDiscSwipeActive(false)
    }
    if (!disc || !disc.style.translate || immediate || !screenActive || powerSave || document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finish()
    } else {
      const animation = animate(disc, { translate: '0px 0px 2px' }, { type: spring, bounce: 0, duration: 0.25 })
      swipeAnimationRef.current = animation
      animation.then(() => {
        if (swipeAnimationRef.current !== animation) return
        swipeAnimationRef.current = null
        finish()
      })
    }
  }
  const runAction = async (action) => {
    if (setupPreview || !interactive) return
    const player = usePlayerStore.getState()
    if (action === 'play') {
      if (player.currentTrack) { onPlay?.(); return }
      if (busy || closingRef.current) return
      closingRef.current = true
      setLidClosing(true)
      try {
        const closed = await sceneApiRef.current?.closeLid()
        if (closed === false || !mountedRef.current) return
        const latest = usePlayerStore.getState()
        if (latest.currentTrack) {
          if (!latest.isPlaying) onPlay?.()
        } else await onStartFlow?.()
      } finally {
        closingRef.current = false
        if (mountedRef.current) setLidClosing(false)
      }
    }
    else if (action === 'previous' && player.currentTrack && queueStep(player, -1)) player.previousTrack()
    else if (action === 'next' && player.currentTrack && queueStep(player, 1)) player.nextTrack('cd_deck')
    else if (action === 'shuffle') player.toggleShuffle()
    else if (action === 'repeat') player.toggleRepeatOne()
  }
  const startInteraction = (event) => {
    if (dragRef.current && event.pointerType === 'touch' && event.pointerId !== dragRef.current.id) {
      finishInteraction({ pointerId: dragRef.current.id, type: 'pointercancel', currentTarget: event.currentTarget })
      return
    }
    if (!interactive || event.button !== 0 || event.isPrimary === false || dragRef.current || event.target.closest('button, input, label')) return
    const api = sceneApiRef.current
    if (!api) return
    api.setControlMotionEnabled(true)
    const action = event.target.closest('.cd-mobile-disc-control') ? 'seek' : api.hitTest(event.clientX, event.clientY)
    const player = usePlayerStore.getState()
    const canSwipe = mobile && !setupPreview && screenActive && event.pointerType === 'touch' && player.currentTrack && !latestRef.current.busy
    if (!action && !canSwipe) return
    const angle = action === 'seek' ? api.discAngleAt(event.clientX, event.clientY) : null
    if (mobile && action === 'seek' && event.cancelable) event.preventDefault()
    event.stopPropagation()
    const mode = setupPreview ? 'tap' : action === 'volume' ? 'volume'
      : action === 'seek' || mobile && action === 'rotate' || (!action && canSwipe) ? 'disc'
        : action === 'seek' || action === 'rotate' ? 'tap' : 'button'
    if (!setupPreview) event.currentTarget.style.cursor = mode === 'disc' ? 'grabbing' : mode === 'volume' ? 'ew-resize' : 'pointer'
    // Freeze the accepted pose immediately; a delayed React commit must not
    // let a moving control slip out from under a held pointer.
    api.setPlaybackMotionEnabled(false)
    swipeAnimationRef.current?.stop()
    swipeAnimationRef.current = null
    const swipeOffset = discSwipeMotionRef.current?.visibleOffset() ?? (discSwipeRef.current ? parseFloat(getComputedStyle(discSwipeRef.current).translate) || 0 : 0)
    event.currentTarget.setPointerCapture(event.pointerId)
    const progress = api.progress()
    dragRef.current = {
      id: event.pointerId, mode, action, x: event.clientX, y: event.clientY,
      startX: event.clientX, startY: event.clientY, volume: player.volume,
      angle, progress, base: progress, accum: 0, turned: false, lastSeekAt: 0,
      trackId: player.currentTrack?.id,
      swipe: canSwipe && mode === 'disc' ? createCdTrackSwipe(event) : null,
      swipeOffset,
    }
    if (mode === 'button') { api.press(action, true); if (action === 'play') intentHandlers?.onPointerDown?.(event) }
    if (mode === 'disc') {
      const drag = dragRef.current
      drag.holdTimer = setTimeout(() => {
        if (dragRef.current !== drag || usePlayerStore.getState().currentTrack?.id !== drag.trackId) return
        drag.held = true
        const latest = usePlayerStore.getState()
        const startAngle = api.discAngleAt(drag.x, drag.y)
        if (action !== 'seek' || (latest.duration || latest.currentTrack?.duration || 0) <= 0 || startAngle === null) return
        drag.mode = 'seek'
        animateBody(null)
        api.turnDisc(progress)
        drag.angle = api.discAngleAt(drag.x, drag.y) ?? startAngle
        softwareDiscApiRef.current?.turn(progress)
      }, 320)
    }
    setInteracting(true)
  }
  function restorePlaybackMotion() {
    const state = usePlayerStore.getState()
    sceneApiRef.current?.setPlaybackMotionEnabled(Boolean(latestRef.current.playbackMotionEligible && state.currentTrack && state.isPlaying))
  }
  const moveInteraction = (event) => {
    if (!interactive) return
    const drag = dragRef.current
    const api = sceneApiRef.current
    if (!api) return
    if (!drag) {
      const action = api.hitTest(event.clientX, event.clientY)
      if (action === 'play' && hoverActionRef.current !== action) intentHandlers?.onPointerEnter?.(event)
      hoverActionRef.current = action
      event.currentTarget.style.cursor = setupPreview ? 'default' : action === 'volume' ? 'ew-resize'
        : action === 'seek' ? 'grab'
          : action ? 'pointer' : 'default'
      return
    }
    if (!drag || event.pointerId !== drag.id) return
    const player = usePlayerStore.getState()
    if (drag.mode === 'disc' && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 10) {
      drag.tapCancelled = true
      clearTimeout(drag.holdTimer)
    }
    if (drag.mode === 'disc' && drag.swipe && !drag.held) {
      updateCdTrackSwipe(drag.swipe, event)
      if (drag.swipe.axis === 'x') {
        if (event.cancelable) event.preventDefault()
        const available = queueStep(player, drag.swipe.dx < 0 ? 1 : -1) || (drag.swipe.dx < 0 && player.queuePager)
        const distance = drag.swipe.dx + drag.swipeOffset
        if (discSwipeRef.current && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          api.setDiscSwipeActive(true)
          discSwipeMotionRef.current ||= createCdDiscSwipe(discSwipeRef.current, sceneRef.current.closest('.desktop-cd-player'))
          discSwipeMotionRef.current.update(available ? distance : distance * 0.2)
        }
      }
    }
    // The chassis is click-to-play only: dragging the body never changes the view.
    if (drag.mode === 'volume') player.setVolume(Math.min(1, Math.max(0, drag.volume + (event.clientX - drag.startX - event.clientY + drag.startY) * 0.006)))
    else if (drag.mode === 'seek' && player.currentTrack?.id === drag.trackId) {
      if (mobile && event.cancelable) event.preventDefault()
      const angle = api.discAngleAt(event.clientX, event.clientY)
      if (angle === null) return
      let delta = angle - drag.angle
      if (delta > Math.PI) delta -= Math.PI * 2
      else if (delta < -Math.PI) delta += Math.PI * 2
      drag.angle = angle
      drag.accum = Math.min((1 - drag.base) * Math.PI * 2, Math.max(-drag.base * Math.PI * 2, drag.accum + delta))
      drag.progress = drag.base + drag.accum / (Math.PI * 2)
      api.turnDisc(drag.progress)
      softwareDiscApiRef.current?.turn(drag.progress)
      if (Math.abs(drag.accum) >= 0.01) drag.turned = true
      const now = performance.now()
      if (drag.turned && now - drag.lastSeekAt >= 120) {
        drag.lastSeekAt = now
        player.seekTo(drag.progress * (player.duration || player.currentTrack?.duration || 0), 'disc')
      }
    }
    drag.x = event.clientX
    drag.y = event.clientY
  }
  const finishInteraction = (event) => {
    const drag = dragRef.current
    if (event.pointerId !== drag?.id) return
    clearTimeout(drag.holdTimer)
    dragRef.current = null
    setInteracting(false)
    const api = sceneApiRef.current
    let swipeCommitted = false
    if (drag.mode === 'button') {
      api?.press(drag.action, false)
      if (event.type === 'pointerup' && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6 && api?.hitTest(event.clientX, event.clientY) === drag.action) runAction(drag.action)
    } else if (drag.mode === 'disc') {
      const player = usePlayerStore.getState()
      const direction = !drag.held && player.currentTrack?.id === drag.trackId ? cdTrackSwipeDirection(drag.swipe, event) : 0
      discSwipeMotionRef.current?.setReleaseVelocity(cdTrackSwipeVelocity(drag.swipe, event))
      if (direction > 0 && (queueStep(player, 1) || player.queuePager)) {
        swipeCommitted = true
        skipForward(player.nextTrack, 'cd_swipe')
      } else if (direction < 0 && queueStep(player, -1)) {
        swipeCommitted = true
        player.previousTrack()
      }
      else if (event.type === 'pointerup' && drag.action && !drag.held && !drag.tapCancelled && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 10 && player.currentTrack?.id === drag.trackId) runAction('play')
    } else if (drag.mode === 'tap' && !setupPreview && event.type === 'pointerup' && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) {
      runAction('play')
    } else if (drag.mode === 'seek') {
      const player = usePlayerStore.getState()
      if (event.type === 'pointerup' && drag.turned && player.currentTrack?.id === drag.trackId) player.seekTo(drag.progress * (player.duration || player.currentTrack?.duration || 0), 'disc')
      api?.releaseDisc()
      softwareDiscApiRef.current?.release()
    }
    if (event.type === 'pointerup' && drag.mode === 'volume') api?.reactToAction('volume')
    if (swipeCommitted) haptic(HAPTIC.selection, { allowDomFallback: false })
    if (!swipeCommitted) resetSwipeMotion()
    event.currentTarget.style.cursor = ''
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (!swipeCommitted) restorePlaybackMotion()
  }
  const keyRotation = (event) => {
    if (!interactive || event.target !== event.currentTarget) return
    sceneApiRef.current?.setControlMotionEnabled(false)
    if (event.key === 'Enter' || event.key === ' ') {
      if (mobile) return
      event.preventDefault()
      if (!event.repeat) runAction('play')
      return
    }
    if (safeRendering || mobile) return
    const delta = { ArrowUp: [0, -20], ArrowDown: [0, 20], ArrowLeft: [-20, 0], ArrowRight: [20, 0] }[event.key]
    if (event.key === 'Home') { event.preventDefault(); resetRotation(); return }
    if (!delta) return
    event.preventDefault()
    sceneApiRef.current?.rotateBy(...delta)
  }
  return (
    <div className={`desktop-cd-player${setupPreview ? ' is-setup-preview' : ''}${mobile ? ' is-mobile' : ''}`} data-lid={appearance.lid} style={{ '--cd-control-accent': appearance.accentColor }}>
      {!setupPreview && !mobile && <QueueDiscs snapshot={queueSnapshot} held={queueHeld} generation={queueGeneration} playedRecords={playedRecordsRef.current} onCommit={onQueueCommit} />}
      {!setupPreview && mobile && <div className="cd-hidden-queue" aria-hidden="true" inert="">
        <QueueDiscs snapshot={queueSnapshot} held={queueHeld} generation={queueGeneration} playedRecords={playedRecordsRef.current} onCommit={onQueueCommit} />
      </div>}
      <div className="cd-deck-stage">
        <span ref={seekPointerPlaneRef} className="cd-deck-pointer-plane cd-deck-seek-plane" aria-hidden="true"><span /><span /><span /><span /></span>
        <div ref={motionRef} className="cd-deck-motion">
          <div ref={bodyRef} className="cd-deck-body">
            <div ref={sceneRef} className={`cd-deck-scene${interacting ? ' is-interacting' : ''}${!screenActive ? ' is-inactive' : ''}${safeRendering ? ' is-static' : ''}`} role="group" data-swipe-ignore={mobile ? "" : undefined} aria-label={mobile ? 'Мобильный CD-проигрыватель. Свайп влево — следующий трек, вправо — предыдущий. Кнопки на корпусе управляют воспроизведением; удерживайте и вращайте диск для перемотки трека.' : setupPreview ? 'Предпросмотр вашего CD-проигрывателя. Используйте стрелки, чтобы повернуть. Home — исходный ракурс.' : safeRendering ? '3D-проигрыватель. Кнопка Play/Pause на корпусе, Enter или пробел — включить, приостановить или продолжить воспроизведение.' : '3D-проигрыватель. Кнопка Play/Pause на корпусе, Enter или пробел — включить, приостановить или продолжить воспроизведение. Используйте стрелки, чтобы повернуть. Поворот диска перематывает трек. Home — исходный ракурс.'} aria-busy={deckBusy || undefined} tabIndex={!mobile && modelStatus === 'ready' && interactive ? 0 : -1} onPointerDownCapture={startInteraction} onPointerMove={moveInteraction} onPointerUp={finishInteraction} onPointerCancel={finishInteraction} onLostPointerCapture={finishInteraction} onKeyDown={keyRotation} onKeyUp={() => sceneApiRef.current?.setControlMotionEnabled(true)} onDoubleClick={safeRendering || !interactive || mobile ? undefined : resetRotation}>
              {/* Disposing a scene releases its WebGL context. A layout change
                  must create a fresh canvas before initializing the next scene. */}
              <canvas key={`${presentation}:${safeRendering ? 'software' : 'hardware'}`} ref={canvasRef} className={`cd-deck-canvas${modelStatus === 'ready' ? ' is-ready' : ''}`} aria-hidden="true" />
              <span ref={pointerPlaneRef} className="cd-deck-pointer-plane" aria-hidden="true"><span /><span /><span /><span /></span>
              {cachedRendering && modelStatus === 'ready' && <SoftwareDiscOverlay geometry={discOverlay} geometryRef={discGeometryRef} coverSrc={coverSrc} coverSettled={coverSettled} trackKey={track?.id} active={screenActive} powerSave={powerSave} gestureRef={softwareDiscApiRef} swipeRef={discSwipeRef} lid={appearance.lid} softwareRendering={safeRendering} mobile={mobile} sceneApiRef={sceneApiRef} onArtworkChange={() => sceneApiRef.current?.refreshDiscArtwork()} />}
              {mobile && modelStatus === 'ready' && (!cachedRendering || coverSrc) && <span
                ref={discControlRef}
                className="cd-mobile-disc-control"
                style={discOverlay ? {
                  left: 0,
                  top: 0,
                  width: SOFTWARE_DISC_SIZE,
                  height: SOFTWARE_DISC_SIZE,
                  transform: discOverlay.transform || squareToQuadTransform(discOverlay.quad, SOFTWARE_DISC_SIZE),
                  transformOrigin: '0 0',
                  visibility: discOverlay.facing === false ? 'hidden' : 'visible',
                } : undefined}
                aria-hidden="true"
              />}
              {modelStatus === 'loading' && <div className="cd-deck-loading" role="status" aria-label="Загрузка проигрывателя"><Loader2 className="wave-loading-icon" size={24} /></div>}
              {modelStatus === 'fallback' && <div className="cd-deck-fallback">
                <HeroDisc track={track} preview={!currentTrack} upgrade />
              </div>}
              {!setupPreview && interactive && screenActive && (!currentTrack || deckBusy) && <button
                ref={playbackControlRef}
                type="button"
                className={`cd-deck-playback${initialPlayback ? ' is-initial' : ''}${deckBusy ? ' is-busy' : ''}${!mobile && playbackPositionRef.current ? ' has-disc-projection' : ''}`}
                style={playbackPositionRef.current || undefined}
                onClick={() => {
                  setPlaybackRequested(true)
                  if (usePlayerStore.getState().currentTrack) onPlay?.()
                  else runAction('play')
                }}
                onDoubleClick={(event) => event.stopPropagation()}
                disabled={deckBusy}
                aria-label={playbackLabel}
                aria-busy={deckBusy || undefined}
                {...(!currentTrack ? intentHandlers : {})}
              >
                {deckBusy ? <Loader2 size={26} className="wave-loading-icon" aria-hidden="true" />
                  : isPlaying ? <Pause size={26} fill="currentColor" aria-hidden="true" />
                    : <Play size={26} fill="currentColor" aria-hidden="true" />}
              </button>}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default memo(DesktopCdPlayer)
