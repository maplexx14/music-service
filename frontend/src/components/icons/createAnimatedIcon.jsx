import { forwardRef, useId, useLayoutEffect, useRef } from 'react'
import { canAnimateIcons, registerAnimatedIcon } from '../../services/iconMotion'

// Bridge AnimateIcons' imperative animation handle to the app's SVG API.
// All motion is supplied by the official component; this adapter only triggers it.
export function createAnimatedIcon(name, NativeIcon) {
  const Icon = forwardRef(function AnimatedIcon({
    size = 24, color = 'currentColor', strokeWidth = 2, absoluteStrokeWidth = false,
    fill = 'none', className = '', style, duration = 1, ...props
  }, forwardedRef) {
    const id = useId()
    const nativeRef = useRef(null)
    const svgRef = useRef(null)
    const generation = useRef(0)
    const previousStyle = useRef({})

    useLayoutEffect(() => {
      const svg = document.getElementById(id)?.querySelector('svg')
      if (!svg) return undefined
      svgRef.current = svg
      const stopAnimation = () => {
        generation.current++
        return nativeRef.current?.stopAnimation()
      }
      const startAnimation = async () => {
        if (!nativeRef.current || !canAnimateIcons()) return
        const current = ++generation.current
        const playback = nativeRef.current.startAnimation()
        // Multi-controller icons return void and finish at rest themselves.
        if (!playback || typeof playback.then !== 'function') return
        await playback
        if (generation.current === current && nativeRef.current) {
          await nativeRef.current.stopAnimation()
        }
      }
      const unregister = registerAnimatedIcon(svg, { startAnimation, stopAnimation })
      if (typeof forwardedRef === 'function') forwardedRef(svg)
      else if (forwardedRef) forwardedRef.current = svg
      return () => {
        unregister()
        svgRef.current = null
        if (typeof forwardedRef === 'function') forwardedRef(null)
        else if (forwardedRef) forwardedRef.current = null
      }
    }, [id, forwardedRef])

    useLayoutEffect(() => {
      const svg = svgRef.current
      if (!svg) return
      const slug = name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([a-z])(\d)/g, '$1-$2').toLowerCase()
      svg.setAttribute('class', ('lucide lucide-' + slug + ' lucide-animated ' + className).trim())
      svg.setAttribute('data-lucide-animated', name)
      svg.setAttribute('fill', fill)
      svg.setAttribute('stroke-width', absoluteStrokeWidth ? Number(strokeWidth) * 24 / Number(size) : strokeWidth)
      const label = props['aria-label']
      if (label) svg.setAttribute('aria-label', label)
      else svg.removeAttribute('aria-label')
      svg.setAttribute('aria-hidden', label || props['aria-labelledby'] ? 'false' : 'true')
      for (const property of Object.keys(previousStyle.current)) {
        if (!(property in (style || {}))) svg.style[property] = ''
      }
      Object.assign(svg.style, style || {})
      previousStyle.current = style || {}
    }, [size, strokeWidth, absoluteStrokeWidth, fill, className, style, props])

    return <NativeIcon
      {...props}
      id={id}
      ref={nativeRef}
      size={size}
      color={color}
      duration={duration}
      isAnimated={false}
      className="animate-icon"
      style={{ display: 'contents' }}
    />
  })
  Icon.displayName = name + 'Icon'
  return Icon
}
