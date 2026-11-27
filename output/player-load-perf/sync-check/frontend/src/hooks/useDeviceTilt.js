import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createDeviceTilt, deviceTiltPermission, requestDeviceTiltPermission } from '../utils/deviceTilt'

export function useDeviceTilt({ enabled, active, paused, ready, sceneRef, apiRef, dragRef }) {
  const [permission, setPermission] = useState(deviceTiltPermission)
  const syncRef = useRef(null)
  const latestRef = useRef(null)
  latestRef.current = { active, paused }

  useEffect(() => {
    const scene = sceneRef.current
    if (!enabled || !ready || permission !== 'granted' || !scene) return undefined
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    const calibration = createDeviceTilt()
    let inViewport = true
    let pointerDown = false
    let listening = false
    const screenAngle = () => window.screen.orientation?.angle ?? window.orientation ?? 0
    const onOrientation = (event) => {
      const { active, paused } = latestRef.current
      if (!active || paused || pointerDown || !inViewport || dragRef.current || document.hidden || reduced.matches) return
      const tilt = calibration.sample(event, screenAngle())
      if (tilt) apiRef.current?.setDeviceTilt(tilt.theta, tilt.phi)
    }
    const sync = () => {
      const { active, paused } = latestRef.current
      if (!active || !inViewport || document.hidden) pointerDown = false
      const shouldListen = active && !paused && !pointerDown && inViewport && !document.hidden && !reduced.matches
      if (shouldListen === listening) return
      listening = shouldListen
      calibration.reset()
      if (listening) window.addEventListener('deviceorientation', onOrientation, { passive: true })
      else {
        window.removeEventListener('deviceorientation', onOrientation)
        // Commit the current angle so grabbing the player never snaps it.
        apiRef.current?.holdDeviceTilt()
      }
    }
    const onPointerDown = (event) => {
      if (!scene.contains(event.target)) return
      pointerDown = true
      sync()
    }
    const onPointerUp = () => { pointerDown = false; sync() }
    const onScreenRotation = () => { calibration.reset(); apiRef.current?.holdDeviceTilt() }
    const intersection = new IntersectionObserver(([entry]) => { inViewport = entry.isIntersecting; sync() })
    intersection.observe(scene)
    syncRef.current = sync
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('pointerup', onPointerUp, true)
    window.addEventListener('pointercancel', onPointerUp, true)
    document.addEventListener('visibilitychange', sync)
    reduced.addEventListener('change', sync)
    window.screen.orientation?.addEventListener('change', onScreenRotation)
    window.addEventListener('orientationchange', onScreenRotation)
    sync()
    return () => {
      syncRef.current = null
      window.removeEventListener('deviceorientation', onOrientation)
      apiRef.current?.holdDeviceTilt()
      intersection.disconnect()
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('pointerup', onPointerUp, true)
      window.removeEventListener('pointercancel', onPointerUp, true)
      document.removeEventListener('visibilitychange', sync)
      reduced.removeEventListener('change', sync)
      window.screen.orientation?.removeEventListener('change', onScreenRotation)
      window.removeEventListener('orientationchange', onScreenRotation)
    }
  }, [enabled, ready, permission, sceneRef, apiRef, dragRef])

  useLayoutEffect(() => { syncRef.current?.() }, [active, paused])

  const requestPermission = () => {
    const request = requestDeviceTiltPermission()
    setPermission('requesting')
    request.then(setPermission)
  }
  return { permission, requestPermission }
}
