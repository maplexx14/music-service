import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { shallow } from 'zustand/shallow'
import { usePlayerStore } from '../store/playerStore'
import { isDislikedTrack, queueStep } from '../utils/playerQueue'
import { discNavigationDirection } from '../utils/discTransition'
import { animateDiscDrum, animateDiscRibbonEntrance, animateDiscNavigation, animateDiscStack, clearDiscStack, readDiscSlots } from '../utils/discMotion'
import { useScreen } from '../hooks/useScreen'
import { useWarmNextDiscCover } from '../hooks/useWarmNextDiscCover'
import { resolveCoverUrl } from '../utils/media'
import HeroDisc from './HeroDisc'
import './FlowDiscArc.css'

const DESKTOP_OFFSETS = [0, 1, -1]
const MOBILE_OFFSETS = [0, 1, 2]
const MOBILE_QUERY = '(max-width: 768px)'
const DESKTOP_X = [0, 32]
const MOBILE_Y = [0, 0.34, 0.66]
const MOBILE_SCALE = [1, 0.9, 0.8]
const EMPTY_TRACKS = []

function trackKey(track) {
  if (track?.source && track.external_id) return `${track.source}:${track.external_id}`
  if (track?.source && typeof track.id === 'string' && track.id.startsWith(`${track.source}:`)) return track.id
  return track?.id != null ? `${track.source || 'local'}:${track.id}` : track?.cover_url
}

// Stable track keys let each record travel to its new place on a track change.
// Queue previews share the player's shuffle and dislike rules.
export default function FlowDiscArc({ tracks = EMPTY_TRACKS, playing }) {
  const arcRef = useRef(null)
  const previousRef = useRef(null)
  const transitionRef = useRef(null)
  const stackMotionsRef = useRef(new Map())
  const flowPreviewRef = useRef(null)
  const finishEntranceRef = useRef(null)
  const desktopEntranceStartedRef = useRef(false)
  const [upgradeCovers, setUpgradeCovers] = useState(false)
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches)
  const { active, scrollerRef } = useScreen()
  const offsets = mobile ? MOBILE_OFFSETS : DESKTOP_OFFSETS

  useLayoutEffect(() => {
    const arc = arcRef.current
    if (!window.matchMedia(MOBILE_QUERY).matches && desktopEntranceStartedRef.current) {
      arc.setAttribute('data-covers-ready', '')
      setUpgradeCovers(true)
      return undefined
    }
    setUpgradeCovers(false)
    arc.removeAttribute('data-covers-ready')
    if (!active) return undefined

    let disposed = false
    let entranceNodes = []
    let entranceMotion = null
    const finishEntrance = () => {
      entranceMotion?.cleanup()
      entranceMotion = null
      arc.removeAttribute('data-entrance-running')
      for (const disc of entranceNodes) {
        disc.removeAttribute('data-disc-enter')
        disc.style.removeProperty('--disc-enter-x')
        disc.style.removeProperty('--disc-enter-rotation')
        disc.style.removeProperty('--slot-depth')
      }
      if (!disposed) setUpgradeCovers(true)
    }
    finishEntranceRef.current = finishEntrance

    // Pin the decoded previews: background flow preloads must not replace a
    // record halfway through the first entrance or when playback starts.
    const reveal = () => {
      const discs = [...arc.querySelectorAll('.flow-disc-slot .hero-disc')]
      if (!discs.length || discs.some((disc) => !disc.hasAttribute('data-cover-settled'))) return
      if (flowPreviewRef.current) usePlayerStore.getState().pinFlowPreview(flowPreviewRef.current)
      entranceNodes = discs.filter((disc) => disc.hasAttribute('data-cover-ready'))
      const desktop = !window.matchMedia(MOBILE_QUERY).matches
      if (desktop) desktopEntranceStartedRef.current = true
      if (!desktop) {
        for (const disc of entranceNodes) {
          const style = getComputedStyle(disc)
          for (const property of ['--disc-enter-x', '--disc-enter-rotation', '--slot-depth']) {
            disc.style.setProperty(property, style.getPropertyValue(property))
          }
          disc.setAttribute('data-disc-enter', '')
        }
      }
      arc.setAttribute('data-entrance-running', '')
      if (desktop && !document.hidden && typeof arc.animate === 'function' &&
          !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        entranceMotion = animateDiscRibbonEntrance(arc, readDiscSlots(arc, true), () => {
          if (!disposed) finishEntrance()
        })
      }
      arc.setAttribute('data-covers-ready', '')
      observer.disconnect()
      if (desktop) {
        if (!entranceMotion) finishEntrance()
        return
      }
      const animations = entranceNodes.flatMap((disc) => disc.getAnimations()
        .filter((animation) => animation.animationName === 'flow-disc-enter'))
      Promise.all(animations.map((animation) => animation.finished.catch(() => {})))
        .then(() => { if (!disposed) finishEntrance() })
    }
    const observer = new MutationObserver(reveal)
    observer.observe(arc, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-cover-settled'],
    })
    reveal()
    return () => {
      disposed = true
      observer.disconnect()
      finishEntrance()
      finishEntranceRef.current = null
    }
  }, [active])

  useEffect(() => {
    const query = window.matchMedia(MOBILE_QUERY)
    const update = () => setMobile(query.matches)
    query.addEventListener('change', update)
    update()
    return () => query.removeEventListener('change', update)
  }, [])
  const state = usePlayerStore((s) => ({
    currentTrack: s.currentTrack,
    queue: s.queue,
    currentIndex: s.currentIndex,
    isShuffle: s.isShuffle,
    shuffledOrder: s.shuffledOrder,
    currentShuffleIndex: s.currentShuffleIndex,
    dislikedTrackIds: s.dislikedTrackIds,
    dislikedTrackKeys: s.dislikedTrackKeys,
    flowPreload: s.flowPreload,
    flowPreview: s.flowPreview,
  }), shallow)

  useLayoutEffect(() => {
    const hero = arcRef.current?.parentElement
    if (!hero || !mobile || !active) return undefined
    const viewport = window.visualViewport
    const center = () => {
      const scrollTop = scrollerRef?.current?.scrollTop ?? window.scrollY
      const origin = hero.getBoundingClientRect().top + scrollTop
      const middle = (viewport?.offsetTop || 0) + (viewport?.height || window.innerHeight) / 2
      hero.style.setProperty('--flow-center-y', `${middle - origin}px`)
    }
    center()
    const observer = new ResizeObserver(center)
    observer.observe(hero)
    window.addEventListener('resize', center)
    viewport?.addEventListener('resize', center)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', center)
      viewport?.removeEventListener('resize', center)
      hero.style.removeProperty('--flow-center-y')
    }
  }, [mobile, active, scrollerRef])

  useLayoutEffect(() => {
    const arc = arcRef.current
    const previous = previousRef.current
    const currentSlots = readDiscSlots(arc, !mobile)
    previousRef.current = {
      state,
      mobile,
      record: arc?.querySelector('.flow-disc-slot.is-current .flow-disc-position'),
      slots: currentSlots,
    }
    const direction = discNavigationDirection(previous?.state, state)
    if ((direction || (previous && previous.mobile !== mobile)) && arc.hasAttribute('data-entrance-running')) {
      finishEntranceRef.current?.()
    }
    const animate = active && !document.hidden && !arc.hasAttribute('data-entrance-running') &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches &&
      typeof arc.animate === 'function'
    if (!animate) {
      transitionRef.current?.cleanup()
      clearDiscStack(stackMotionsRef.current)
      return
    }
    if (previous?.mobile !== mobile) {
      transitionRef.current?.cleanup()
      transitionRef.current = null
      clearDiscStack(stackMotionsRef.current)
      return
    }
    if (!mobile) {
      if (!direction) return
      transitionRef.current = animateDiscDrum(arc, previous.slots, currentSlots, {
        direction,
        interrupted: transitionRef.current,
      })
      return
    }
    const returning = direction < 0
    const key = direction ? trackKey(returning ? state.currentTrack : previous.state.currentTrack) : null
    if (mobile && previous?.slots && previous.state.currentTrack) {
      animateDiscStack(arc, previous.slots, currentSlots, stackMotionsRef.current, key)
    }
    if (!direction || !previous?.record) return

    // Forward sends the old record right; returning brings the selected record
    // back from that same side. An interrupted move continues from its position.
    const liveRecord = returning ? previousRef.current.record : previous.record
    if (!liveRecord) return
    transitionRef.current = animateDiscNavigation(arc, liveRecord, {
      returning,
      key,
      interrupted: transitionRef.current,
      onFinish: (motion) => {
        if (transitionRef.current === motion) transitionRef.current = null
      },
    })
  }, [state, active, mobile])

  useEffect(() => () => {
    transitionRef.current?.cleanup()
    clearDiscStack(stackMotionsRef.current)
    if (flowPreviewRef.current && usePlayerStore.getState().flowPreview === flowPreviewRef.current) {
      usePlayerStore.setState({ flowPreview: null })
    }
  }, [])
  const preview = state.flowPreview || state.flowPreload
  const candidates = (state.currentTrack
    ? [...state.queue, ...tracks]
    : preview?.tracks || EMPTY_TRACKS)
    .filter((track) => !isDislikedTrack(state, track))
  const center = state.currentTrack || candidates[0]
  const used = new Set([trackKey(center)])
  const slots = new Map([[0, center]])

  for (const offset of offsets) {
    if (offset === 0 || !state.currentTrack) continue
    const step = queueStep(state, Math.sign(offset), Math.abs(offset))
    const track = step ? state.queue[step.index] : null
    const key = trackKey(track)
    if (!key || used.has(key)) continue
    slots.set(offset, track)
    used.add(key)
  }

  // Fill available previews without inventing records before tracks arrive.
  for (const offset of offsets) {
    if (slots.get(offset)) continue
    const track = candidates.find((candidate) => {
      const key = trackKey(candidate)
      return key && !used.has(key)
    })
    if (track) used.add(trackKey(track))
    slots.set(offset, track)
  }

  flowPreviewRef.current = state.currentTrack ? null : preview

  const nextStep = state.currentTrack ? queueStep(state, 1) : null
  const nextTrack = state.currentTrack ? (nextStep ? state.queue[nextStep.index] : null) : slots.get(1)
  useWarmNextDiscCover(arcRef,
    resolveCoverUrl(center?.cover_url, 'full'),
    resolveCoverUrl(nextTrack?.cover_url, 'full'),
    active && upgradeCovers,
  )

  return (
    <div ref={arcRef} className={`flow-disc-arc${playing ? ' is-playing' : ''}`} data-active={active || undefined}>
      {offsets.map((offset, depth) => {
        const distance = offset === 0 ? 0 : 1
        const track = slots.get(offset)
        if (!track) return null
        return (
          <div
            key={trackKey(track)}
            data-disc-key={trackKey(track)}
            className={`flow-disc-slot${offset === 0 ? ' is-current' : ''}`}
            style={{
              '--slot-x': `${Math.sign(offset) * DESKTOP_X[distance]}%`,
              '--slot-y': offset === 0 ? '0%' : '43%',
              '--slot-scale': 1,
              '--slot-distance': distance,
              '--slot-depth': depth,
              '--disc-enter-x': depth % 2 === 0 ? '100vw' : '-100vw',
              '--disc-enter-rotation': depth % 2 === 0 ? '18deg' : '-18deg',
              '--slot-mobile-y': MOBILE_Y[depth],
              '--slot-mobile-scale': MOBILE_SCALE[depth],
            }}
          >
            <div className="flow-disc-position">
              <HeroDisc track={track} preview={offset !== 0 || !state.currentTrack} upgrade={offset === 0 && active && upgradeCovers} coverPriority={!mobile && active && !upgradeCovers ? 'high' : undefined} />
            </div>
          </div>
        )
      })}
    </div>
  )
}
