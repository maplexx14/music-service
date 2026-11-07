import { useEffect, useLayoutEffect, useRef } from 'react'
import { usePlayerStore } from '../store/playerStore'
import { playbackLabel } from '../utils/playbackLabel'
import { useScreen } from '../hooks/useScreen'
import api from '../services/api'
import { peekCache } from '../services/pageCache'

export default function FlowHeading() {
  const label = usePlayerStore(playbackLabel)
  const context = usePlayerStore((state) => state.currentTrack ? state.playContext : null)
  const headingRef = useRef(null)
  const { active } = useScreen()

  useEffect(() => {
    if (!active || !context || context.title || context.kind === 'flow') return undefined
    // У очередей из старых версий было сохранено только местоположение
    // плейлиста. Восстанавливаем имя, не требуя запускать музыку заново.
    const local = /^\/playlists\/(\d+)\/?$/.exec(context.path || '')
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
      heading.style.maxWidth = ''
      const baseSize = parseFloat(getComputedStyle(heading).fontSize)
      const width = heading.getBoundingClientRect().width
      const available = Math.max(0, hero.clientWidth - 32)
      if (width > available) {
        heading.style.fontSize = `${Math.max(20, baseSize * available / width)}px`
      }
      // Учитываем горизонтальное растяжение фирменной надписи (scaleX 1.3).
      heading.style.maxWidth = `${available / 1.3}px`
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

  return <div ref={headingRef} className="wave-heading">{label}</div>
}
