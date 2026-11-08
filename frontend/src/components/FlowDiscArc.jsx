import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { shallow } from 'zustand/shallow'
import { usePlayerStore } from '../store/playerStore'
import { isDislikedTrack, queueStep } from '../utils/playerQueue'
import { discNavigationDirection } from '../utils/discTransition'
import { DISC_MOTION, animateDiscStack, clearDiscStack, cloneDiscRecord, readDiscSlots } from '../utils/discMotion'
import { useScreen } from '../hooks/useScreen'
import HeroDisc from './HeroDisc'
import './FlowDiscArc.css'

const DESKTOP_OFFSETS = [0, 1, -1]
const MOBILE_OFFSETS = [0, 1, 2]
const MOBILE_QUERY = '(max-width: 768px)'
const DESKTOP_X = [0, 36]
const DESKTOP_SCALE = [1, 0.68]
const MOBILE_Y = [0, 0.4, 0.78]
const MOBILE_SCALE = [1, 0.84, 0.7]
const EMPTY_TRACKS = []

function trackKey(track) {
  return track?.id != null ? `${track.source || 'local'}:${track.id}` : track?.cover_url
}

// Stable track keys let each record travel to its new place on a track change.
// Queue previews share the player's shuffle and dislike rules.
export default function FlowDiscArc({ tracks = EMPTY_TRACKS, playing }) {
  const arcRef = useRef(null)
  const previousRef = useRef(null)
  const transitionRef = useRef(null)
  const stackMotionsRef = useRef(new Map())
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches)
  const { active, scrollerRef } = useScreen()
  const offsets = mobile ? MOBILE_OFFSETS : DESKTOP_OFFSETS

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
    const currentSlots = readDiscSlots(arc)
    previousRef.current = {
      state,
      record: arc?.querySelector('.flow-disc-slot.is-current .flow-disc-position'),
      slots: currentSlots,
    }
    const animate = active && !document.hidden && mobile &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches &&
      typeof arc.animate === 'function'
    if (!animate) {
      transitionRef.current?.cleanup()
      clearDiscStack(stackMotionsRef.current)
      return
    }
    const direction = discNavigationDirection(previous?.state, state)
    const returning = direction < 0
    const key = direction ? trackKey(returning ? state.currentTrack : previous.state.currentTrack) : null
    if (previous?.slots && previous.state.currentTrack) {
      animateDiscStack(arc, previous.slots, currentSlots, stackMotionsRef.current, key)
    }
    if (!direction || !previous?.record) return

    // Forward sends the old record right; returning brings the selected record
    // back from that same side. An interrupted move continues from its position.
    const liveRecord = returning ? previousRef.current.record : previous.record
    if (!liveRecord) return
    const interrupted = transitionRef.current
    const continuing = interrupted?.key === key
    const source = continuing ? interrupted.ghost.querySelector('.flow-disc-position') : liveRecord
    const from = continuing ? getComputedStyle(interrupted.ghost).transform : null
    const record = cloneDiscRecord(source)
    interrupted?.cleanup()
    const ghost = document.createElement('div')
    ghost.className = 'flow-disc-transition'
    ghost.setAttribute('aria-hidden', 'true')
    ghost.inert = true
    ghost.append(record)
    arc.append(ghost)

    // Hide the live copy until the moving copy reaches its final position.
    const sourceSlot = liveRecord.closest('.flow-disc-slot')
    const visibility = sourceSlot?.style.visibility
    if (sourceSlot) sourceSlot.style.visibility = 'hidden'
    const distance = (arc.clientWidth + record.offsetWidth) / 2 + 16
    const outside = `translateX(${distance}px)`
    const animation = ghost.animate([
      { transform: from || (returning ? outside : 'translateX(0)') },
      { transform: returning ? 'translateX(0)' : outside },
    ], DISC_MOTION)
    let cleaned = false
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      ghost.remove()
      animation.cancel()
      if (sourceSlot) sourceSlot.style.visibility = visibility
      if (transitionRef.current?.cleanup === cleanup) transitionRef.current = null
    }
    transitionRef.current = { cleanup, ghost, key }
    animation.finished.then(cleanup, cleanup)
  }, [state, active, mobile])

  useEffect(() => () => {
    transitionRef.current?.cleanup()
    clearDiscStack(stackMotionsRef.current)
  }, [])
  const candidates = [...(state.flowPreload?.tracks || EMPTY_TRACKS), ...tracks, ...state.queue]
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

  // Keep the stack populated before playback and at the ends of a short queue.
  for (const offset of offsets) {
    if (slots.get(offset)) continue
    const track = candidates.find((candidate) => {
      const key = trackKey(candidate)
      return key && !used.has(key)
    })
    if (track) used.add(trackKey(track))
    slots.set(offset, track || { id: `placeholder:${offset}` })
  }

  return (
    <div ref={arcRef} className={`flow-disc-arc${playing ? ' is-playing' : ''}`}>
      {offsets.map((offset, depth) => {
        const distance = offset === 0 ? 0 : 1
        const track = slots.get(offset)
        return (
          <div
            key={trackKey(track)}
            data-disc-key={trackKey(track)}
            className={`flow-disc-slot${offset === 0 ? ' is-current' : ''}`}
            style={{
              '--slot-x': `${Math.sign(offset) * DESKTOP_X[distance]}%`,
              '--slot-y': offset === 0 ? '0%' : '47%',
              '--slot-scale': DESKTOP_SCALE[distance],
              '--slot-distance': distance,
              '--slot-depth': depth,
              '--slot-mobile-y': MOBILE_Y[depth],
              '--slot-mobile-scale': MOBILE_SCALE[depth],
            }}
          >
            <div className="flow-disc-position">
              <HeroDisc track={track} preview={offset !== 0 || !state.currentTrack} />
            </div>
          </div>
        )
      })}
    </div>
  )
}
