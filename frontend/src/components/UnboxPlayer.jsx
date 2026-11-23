import { useCallback, useEffect, useRef, useState } from 'react'
import { animate, motionValue } from 'motion'
import { ArrowUp } from '@/components/icons'
import DesktopCdPlayer from './DesktopCdPlayer'
import boltWordmark from '../assets/bolt-wordmark.webp'

export default function UnboxPlayer({ stage, onUnboxed, onReady }) {
  const [phase, setPhase] = useState(stage === 'customize' ? 'ready' : 'sealed')
  const [peel] = useState(() => motionValue(0))
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const sceneRef = useRef(null)
  const sealRef = useRef(null)
  const tailRef = useRef(null)
  const tabRef = useRef(null)
  const lidRef = useRef(null)
  const leftLidRef = useRef(null)
  const rightLidRef = useRef(null)
  const leftOuterRef = useRef(null)
  const rightOuterRef = useRef(null)
  const leftInnerRef = useRef(null)
  const rightInnerRef = useRef(null)
  const cartonRef = useRef(null)
  const deviceRef = useRef(null)
  const shineRef = useRef(null)
  const glowRef = useRef(null)
  const dragRef = useRef(null)
  const runningRef = useRef(false)
  const mountedRef = useRef(true)
  const animationsRef = useRef(new Set())
  const peelAnimationRef = useRef(null)
  const suppressClickRef = useRef(false)
  const clickResetRef = useRef(null)
  const modelReadyRef = useRef(false)
  const modelWaiterRef = useRef(null)
  const callbacksRef = useRef({ onUnboxed, onReady })
  callbacksRef.current = { onUnboxed, onReady }
  const customize = stage === 'customize'
  const markModelReady = useCallback(() => {
    modelReadyRef.current = true
    modelWaiterRef.current?.()
    modelWaiterRef.current = null
  }, [])

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReducedMotion(media.matches)
    media.addEventListener('change', update)
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      media.removeEventListener('change', update)
      animationsRef.current.forEach((animation) => animation.cancel())
      peelAnimationRef.current?.stop()
      modelWaiterRef.current?.()
      clearTimeout(clickResetRef.current)
    }
  }, [])

  useEffect(() => {
    const paint = (distance) => {
      const height = sceneRef.current?.clientHeight || 400
      const progress = Math.min(1, Math.max(0, distance / height))
      if (sealRef.current) sealRef.current.style.clipPath = 'inset(0 0 ' + progress * 100 + '% 0)'
      if (tabRef.current) tabRef.current.style.transform = 'translateY(' + -distance + 'px)'
      if (tailRef.current) {
        tailRef.current.style.transform = 'translateY(' + -distance + 'px) rotateX(24deg)'
        tailRef.current.style.opacity = String(Math.min(1, progress * 8) * (1 - progress))
        tailRef.current.style.height = Math.min(100, distance * 0.55) + 'px'
      }
    }
    paint(peel.get())
    return peel.on('change', paint)
  }, [peel])

  const play = async (element, frames, duration, easing = 'cubic-bezier(0.22, 1, 0.36, 1)') => {
    if (!mountedRef.current || !element) return false
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const safeFrames = reduce ? frames.map(({ transform, ...frame }) => frame) : frames
    const animation = element.animate(safeFrames, { duration: reduce ? Math.min(duration, 140) : duration, easing, fill: 'forwards' })
    animationsRef.current.add(animation)
    try { await animation.finished } catch { return false }
    return mountedRef.current
  }
  const hold = (duration) => play(sceneRef.current, [{ opacity: 1 }, { opacity: 1 }], duration, 'linear')

  const reveal = async (alreadyOpen = false, velocity = 0) => {
    if (runningRef.current || customize) return
    runningRef.current = true
    setPhase('peeling')
    peelAnimationRef.current?.stop()
    peelAnimationRef.current = animate(peel, (sceneRef.current?.clientHeight || 400) * 1.12,
      reducedMotion ? { duration: 0 } : { type: 'spring', bounce: 0, duration: 0.36, velocity })
    await peelAnimationRef.current
    if (!mountedRef.current) return
    // Keep the box closed until the actual player, including its textures, exists.
    if (!modelReadyRef.current) await new Promise((resolve) => { modelWaiterRef.current = resolve })
    if (!mountedRef.current) return
    setPhase('opening')
    const opened = await Promise.all([
      play(leftLidRef.current, [
        { opacity: 1, transform: 'translateZ(0) rotateY(0deg)' },
        { opacity: 1, transform: 'translateZ(12px) rotateY(-8deg)', offset: 0.16 },
        { opacity: 1, transform: 'translateZ(22px) rotateY(-86deg)', offset: 0.72 },
        { opacity: reducedMotion ? 0 : 1, transform: 'translateZ(8px) rotateY(-112deg)' },
      ], alreadyOpen ? 170 : 520, 'cubic-bezier(0.32, 0.72, 0, 1)'),
      play(rightLidRef.current, [
        { opacity: 1, transform: 'translateZ(0) rotateY(0deg)' },
        { opacity: 1, transform: 'translateZ(12px) rotateY(8deg)', offset: 0.16 },
        { opacity: 1, transform: 'translateZ(22px) rotateY(86deg)', offset: 0.72 },
        { opacity: reducedMotion ? 0 : 1, transform: 'translateZ(8px) rotateY(112deg)' },
      ], alreadyOpen ? 170 : 520, 'cubic-bezier(0.32, 0.72, 0, 1)'),
      ...[leftOuterRef.current, rightOuterRef.current].map((face) => play(face, [
        { opacity: 1 },
        { opacity: 1, offset: 0.58 },
        { opacity: 0, offset: 0.76 },
        { opacity: 0 },
      ], alreadyOpen ? 170 : 520, 'linear')),
      ...[leftInnerRef.current, rightInnerRef.current].map((face) => play(face, [
        { opacity: 0 },
        { opacity: 0, offset: 0.58 },
        { opacity: 1, offset: 0.76 },
        { opacity: 1 },
      ], alreadyOpen ? 170 : 520, 'linear')),
      play(cartonRef.current, [
        { transform: 'translateY(0) scale(1)' },
        { transform: 'translateY(1.2%) scale(0.985)', offset: 0.24 },
        { transform: 'translateY(0) scale(1)' },
      ], alreadyOpen ? 170 : 520),
    ])
    if (opened.some((done) => !done)) return
    setPhase('revealed')
    if (!alreadyOpen) callbacksRef.current.onUnboxed()
    if (!await hold(120)) return
    setPhase('lifting-top')
    // The top edge clears the insert first, then the player straightens as one continuous lift.
    if (!await play(deviceRef.current, [
      { transform: 'translateY(0) translateZ(0) rotateX(0deg)', filter: 'drop-shadow(0 0 0 #0000)' },
      { transform: 'translateY(-3%) translateZ(44px) rotateX(-17deg)', filter: 'drop-shadow(0 18px 16px #0004)', offset: 0.42 },
      { transform: 'translateY(-12%) translateZ(105px) rotateX(5deg)' },
    ], 620, 'cubic-bezier(0.65, 0, 0.35, 1)')) return
    setPhase('clearing-box')
    const cleared = await Promise.all([
      play(cartonRef.current, [
        { opacity: 1, transform: 'translateX(0) rotateZ(0deg) scale(1)' },
        { opacity: 0, transform: 'translateX(-125%) rotateZ(-12deg) scale(0.88)' },
      ], 480),
      play(lidRef.current, [
        { opacity: 1, transform: 'translateX(0) rotateZ(0deg) scale(1)' },
        { opacity: 0, transform: 'translateX(-125%) rotateZ(-12deg) scale(0.88)' },
      ], 480),
      play(deviceRef.current, [
        { transform: 'translateY(-12%) translateZ(105px) rotateX(5deg)' },
        { transform: 'translateY(0) translateZ(0) rotateX(0deg) scale(1.035)' },
      ], 520),
    ])
    if (cleared.some((done) => !done)) return
    setPhase('welcoming')
    const welcomed = await Promise.all([
      play(deviceRef.current, [
        { transform: 'translateY(0) scale(1.035)', filter: 'drop-shadow(0 26px 24px #0006)' },
        { transform: 'translateY(-0.5%) scale(1.045)', filter: 'drop-shadow(0 30px 26px #0005)', offset: 0.38 },
        { transform: 'translateY(0) scale(1)', filter: 'drop-shadow(0 18px 22px #0005)' },
      ], 480),
      play(shineRef.current, [
        { opacity: 0, transform: 'translateX(-130%) rotate(-22deg)' },
        { opacity: 0.65, offset: 0.35 },
        { opacity: 0, transform: 'translateX(150%) rotate(-22deg)' },
      ], 480, 'cubic-bezier(0.4, 0, 0.2, 1)'),
      play(glowRef.current, [
        { opacity: 0, transform: 'scale(0.94)' },
        { opacity: 0.7, transform: 'scale(1.08)', offset: 0.4 },
        { opacity: 0.2, transform: 'scale(1)' },
      ], 480),
    ])
    if (welcomed.some((done) => !done)) return
    setPhase('ready')
    callbacksRef.current.onReady()
  }
  const revealRef = useRef(reveal)
  revealRef.current = reveal
  useEffect(() => {
    // Resume a saved opened box by playing the remaining extraction sequence.
    if (stage === 'unboxed' && !runningRef.current) void revealRef.current(true)
  }, [stage])

  const startDrag = (event) => {
    if (event.button !== 0 || dragRef.current || runningRef.current || customize) return
    peelAnimationRef.current?.stop()
    clearTimeout(clickResetRef.current)
    suppressClickRef.current = false
    dragRef.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, base: peel.get(), lastY: event.clientY, lastAt: performance.now(), velocity: 0, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const moveDrag = (event) => {
    const drag = dragRef.current
    if (!drag || drag.id !== event.pointerId) return
    const now = performance.now()
    const delta = drag.startY - event.clientY
    if (Math.hypot(event.clientX - drag.startX, delta) > 6) drag.moved = true
    drag.velocity = (drag.lastY - event.clientY) / Math.max(8, now - drag.lastAt) * 1000
    drag.lastY = event.clientY
    drag.lastAt = now
    peel.set(Math.max(0, drag.base + delta))
  }
  const finishDrag = (event) => {
    const drag = dragRef.current
    if (!drag || drag.id !== event.pointerId) return
    dragRef.current = null
    suppressClickRef.current = drag.moved
    clickResetRef.current = window.setTimeout(() => { suppressClickRef.current = false }, 0)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    const velocity = performance.now() - drag.lastAt > 120 ? 0 : drag.velocity
    const threshold = Math.max(48, (sceneRef.current?.clientHeight || 400) * 0.24)
    if (event.type === 'pointerup' && drag.moved && velocity > -180 && (peel.get() > threshold || (velocity > 750 && peel.get() > 20))) {
      void reveal(false, velocity)
    } else peelAnimationRef.current = animate(peel, 0, reducedMotion ? { duration: 0 } : { type: 'spring', bounce: 0, duration: 0.35, velocity })
  }

  return <div ref={sceneRef} className={'unboxing-scene' + (customize ? ' is-customizing' : '')} data-phase={phase}>
    <div ref={glowRef} className="unboxing-glow" aria-hidden="true" />
    <div ref={cartonRef} className="unboxing-carton" aria-hidden="true">
      <div className="unboxing-carton-base" />
      <div className="unboxing-carton-walls">
        <span className="unboxing-carton-wall unboxing-carton-wall--top" />
        <span className="unboxing-carton-wall unboxing-carton-wall--right" />
        <span className="unboxing-carton-wall unboxing-carton-wall--bottom" />
        <span className="unboxing-carton-wall unboxing-carton-wall--left" />
      </div>
      <div className="unboxing-foam" />
    </div>
    <div ref={deviceRef} className="unboxing-device" aria-hidden={phase === 'sealed' || phase === 'peeling'}>
      <DesktopCdPlayer presentation="setup" interactive={customize && phase === 'ready'} onReady={markModelReady} />
      <div className="unboxing-reflection" aria-hidden="true"><div ref={shineRef} className="unboxing-shine" /></div>
    </div>
    <div ref={lidRef} className="unboxing-lid" aria-hidden={phase !== 'sealed' && phase !== 'peeling'}>
      <div ref={leftLidRef} className="unboxing-lid-half unboxing-lid-half--left">
        <div ref={leftOuterRef} className="unboxing-lid-face unboxing-lid-face--outer">
          <img className="unboxing-lid-logo" src={boltWordmark} alt="" aria-hidden="true" />
        </div>
        <div ref={leftInnerRef} className="unboxing-lid-face unboxing-lid-face--inner" />
      </div>
      <div ref={rightLidRef} className="unboxing-lid-half unboxing-lid-half--right">
        <div ref={rightOuterRef} className="unboxing-lid-face unboxing-lid-face--outer" />
        <div ref={rightInnerRef} className="unboxing-lid-face unboxing-lid-face--inner" />
      </div>
      <div className="unboxing-carton-seam" aria-hidden="true" />
      <div ref={sealRef} className="unboxing-tape-seal" aria-hidden="true" />
      <div ref={tailRef} className="unboxing-tape-tail" aria-hidden="true" />
      <button ref={tabRef} type="button" className="unboxing-pull-tab" disabled={runningRef.current || customize} aria-label="Потянуть скотч снизу вверх и открыть коробку" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={finishDrag} onLostPointerCapture={finishDrag} onClick={() => {
        if (suppressClickRef.current) { suppressClickRef.current = false; return }
        void reveal()
      }}><ArrowUp size={20} aria-hidden="true" /></button>
    </div>
    <div className="unboxing-instruction" aria-hidden="true">
      <strong>Потяните вверх</strong>
      <span>или нажмите, чтобы открыть</span>
    </div>
    <span className="player-setup-sr-only" role="status">{phase === 'sealed' ? 'Потяните скотч снизу вверх. Также можно нажать Enter на язычке.' : phase === 'ready' ? 'Проигрыватель распакован. Можно выбрать оформление.' : phase === 'revealed' ? 'Коробка открыта. Проигрыватель лежит внутри.' : 'Достаём проигрыватель из коробки.'}</span>
  </div>
}
