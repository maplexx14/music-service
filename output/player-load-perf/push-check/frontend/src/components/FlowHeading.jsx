import { useEffect, useLayoutEffect, useRef } from 'react'
import { usePlayerStore } from '../store/playerStore'
import { playbackLabel } from '../utils/playbackLabel'
import { useScreen } from '../hooks/useScreen'
import { usePowerSave } from '../hooks/usePowerSave'
import api from '../services/api'
import { peekCache } from '../services/pageCache'

export default function FlowHeading() {
  const label = usePlayerStore(playbackLabel)
  const context = usePlayerStore((state) => state.currentTrack ? state.playContext : null)
  const headingRef = useRef(null)
  const previousLabelRef = useRef(label)
  const { active } = useScreen()
  const powerSave = usePowerSave()

  useEffect(() => {
    if (!active || !context || context.title || context.kind === 'flow') return undefined
    // У очередей из старых версий было сохранено только местоположение
    // плейлиста. Восстанавливаем имя, не требуя запускать музыку заново.
    const local = /^\/playlists\/([0-9a-f-]{36})\/?$/.exec(context.path || '')
    const external = /^\/external\/soundcloud\/playlists\/([^/]+)\/?$/.exec(context.path || '')
    if (!local && !external) return undefined
    let cancelled = false
    const setTitle = (title) => {
      if (cancelled || !title || usePlayerStore.getState().playContext !== context) return
      usePlayerStore.setState({ playContext: { ...context, title } })
    }
    const key = local ? `playlist:${local[1]}` : `external-playlist:${external[1]}`
    const cached = peekCache(key)?.playlist
    if (cached?.name || cached?.title) {
      setTitle(cached.name || cached.title)
      return undefined
    }
    api.get(local ? `/playlists/${local[1]}` : `/soundcloud/playlists/${external[1]}`, {
      params: local ? { limit: 1 } : undefined,
      skipErrorToast: true,
    }).then(({ data }) => setTitle(local ? data.name : data.playlist?.title)).catch(() => {})
    return () => { cancelled = true }
  }, [context, active])

  useLayoutEffect(() => {
    if (!active) return undefined
    const heading = headingRef.current
    const hero = heading?.closest('.hero-section')
    if (!hero) return undefined
    let cancelled = false
    const fit = () => {
      if (cancelled || hero.clientWidth === 0) return
      heading.style.fontSize = ''
      heading.style.maxWidth = 'none'
      const baseSize = parseFloat(getComputedStyle(heading).fontSize)
      const deck = hero.classList.contains('has-desktop-deck') || hero.classList.contains('has-mobile-deck')
      const scale = 1.3
      const width = Math.max(heading.getBoundingClientRect().width, heading.scrollWidth * scale)
      const available = Math.max(0, deck ? heading.closest('.wave-widget')?.clientWidth || hero.clientWidth - 64 : hero.clientWidth - 32)
      if (width > available) {
        heading.style.fontSize = `${Math.max(20, baseSize * available / width)}px`
      }
      // Keep the horizontally stretched heading inside its available area.
      heading.style.maxWidth = `${available / scale}px`
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(hero)
    document.fonts?.ready.then(fit)
    document.fonts?.addEventListener('loadingdone', fit)
    return () => {
      cancelled = true
      observer.disconnect()
      document.fonts?.removeEventListener('loadingdone', fit)
    }
  }, [label, active])

  useLayoutEffect(() => {
    const previous = previousLabelRef.current
    previousLabelRef.current = label
    const heading = headingRef.current
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (previous === label || !active || powerSave || document.hidden || !heading?.closest('.has-desktop-deck') ||
        reduced.matches || typeof heading.animate !== 'function') return undefined
    const animation = heading.animate([
      { opacity: 0, transform: 'translateY(6px) scale(1.3, 0.85)' },
      { opacity: 1, transform: 'scale(1.3, 0.85)' },
    ], { duration: 180, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' })
    const cancel = () => animation.cancel()
    const onVisibility = () => { if (document.hidden) cancel() }
    reduced.addEventListener('change', cancel)
    document.addEventListener('visibilitychange', onVisibility)
    return () => { animation.cancel(); reduced.removeEventListener('change', cancel); document.removeEventListener('visibilitychange', onVisibility) }
  }, [label, active, powerSave])

  return <div ref={headingRef} className="wave-heading">{label}</div>
}
