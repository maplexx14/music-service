import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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
  const textRef = useRef(null)
  const lastDeckRef = useRef(false)
  const lastRectRef = useRef(null)
  const moveAnimationRef = useRef(null)
  // Текст, который сейчас виден. Новое название сначала уходит вверх и только
  // потом подменяет старое, поэтому показанный текст может отставать от label.
  const [shownLabel, setShownLabel] = useState(label)
  const enteringRef = useRef(false)
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
      lastRectRef.current = heading.getBoundingClientRect()
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
  }, [shownLabel, active])

  // Смена названия: старое уезжает вверх, новое приходит снизу. Движение идёт
  // через свойство translate, а не transform: transform уже держит scale из CSS.
  useLayoutEffect(() => {
    const text = textRef.current
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    const canMove = Boolean(text) && active && !powerSave && !document.hidden &&
      !reduced.matches && typeof text.animate === 'function'
    if (label !== shownLabel) {
      if (!canMove) {
        setShownLabel(label)
        return undefined
      }
      const leave = text.animate([
        { opacity: 1, translate: '0 0' },
        { opacity: 0, translate: '0 -40px' },
      ], { duration: 300, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' })
      leave.finished.then(() => {
        enteringRef.current = true
        setShownLabel(label)
      }, () => {})
      // Если название сменилось ещё раз, уходящее движение отменяется здесь.
      return () => leave.cancel()
    }
    if (!enteringRef.current) return undefined
    enteringRef.current = false
    if (!canMove) return undefined
    const enter = text.animate([
      { opacity: 0, translate: '0 30px' },
      { opacity: 1, translate: '0 0' },
    ], { duration: 420, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' })
    return () => enter.cancel()
  }, [label, shownLabel, active, powerSave])

  // После появления проигрывателя подпись уезжает наверх и уменьшается.
  // Раньше класс плеера менял layout скачком; FLIP-анимация переносит
  // элемент из старого визуального положения в новое.
  useLayoutEffect(() => {
    const heading = headingRef.current
    const hero = heading?.closest('.hero-section')
    if (!heading || !hero) return
    const deck = hero.classList.contains('has-desktop-deck') || hero.classList.contains('has-mobile-deck')
    const wasDeck = lastDeckRef.current
    lastDeckRef.current = deck
    const from = lastRectRef.current
    const to = heading.getBoundingClientRect()
    lastRectRef.current = to
    if (!deck || wasDeck || !from?.width || !from?.height || !to.width || !to.height) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (!active || powerSave || document.hidden || reduced.matches || typeof heading.animate !== 'function') return
    const dx = from.left + from.width / 2 - (to.left + to.width / 2)
    const dy = from.top + from.height / 2 - (to.top + to.height / 2)
    const sx = from.width / to.width
    const sy = from.height / to.height
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return
    const animation = heading.animate([
      { translate: `${dx}px ${dy}px`, scale: `${sx} ${sy}` },
      { translate: '0 0', scale: '1 1' },
    ], { duration: 680, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' })
    moveAnimationRef.current = animation
    animation.finished.then(() => {
      if (moveAnimationRef.current === animation) moveAnimationRef.current = null
    }, () => {})
  })

  return (
    <div ref={headingRef} className="wave-heading">
      <span ref={textRef} className="wave-heading-text">{shownLabel}</span>
    </div>
  )
}
