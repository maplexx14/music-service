export const DISC_MOTION = {
  duration: 420,
  easing: 'cubic-bezier(0.32, 0, 0.16, 1)',
  fill: 'forwards',
}

export function cloneDiscRecord(source) {
  const record = source.cloneNode(true)
  const scale = source.closest('.flow-disc-slot')?.style.getPropertyValue('--slot-mobile-scale') || 1
  record.style.transform = getComputedStyle(source).transform || `translate(-50%, -50%) scale(${scale})`
  record.style.transition = 'none'
  const platter = source.querySelector('.hero-disc-spin')
  if (platter) {
    record.querySelector('.hero-disc-spin').style.transform =
      getComputedStyle(platter).transform || platter.style.transform
  }
  record.querySelectorAll('[tabindex]').forEach((node) => node.removeAttribute('tabindex'))
  return record
}

// A returning record can be newly mounted: wait for decoded artwork before
// taking its snapshot, and keep the live copy hidden until the flight ends.
export function animateDiscNavigation(arc, liveRecord, { returning, key, interrupted, onFinish }) {
  const continuing = interrupted?.key === key && interrupted.ghost
  const from = continuing ? getComputedStyle(interrupted.ghost).transform : null
  const snapshot = continuing ? cloneDiscRecord(interrupted.ghost.querySelector('.flow-disc-position')) : null
  interrupted?.cleanup()

  const slot = liveRecord.closest('.flow-disc-slot')
  const visibility = slot?.style.visibility
  if (slot) slot.style.visibility = 'hidden'
  let animation = null
  let observer = null
  let cleaned = false
  const motion = { key, ghost: null, cleanup }

  function cleanup() {
    if (cleaned) return
    cleaned = true
    observer?.disconnect()
    motion.ghost?.remove()
    animation?.cancel()
    if (slot) slot.style.visibility = visibility
    onFinish?.(motion)
  }

  const start = () => {
    if (cleaned) return
    observer?.disconnect()
    const record = snapshot || cloneDiscRecord(liveRecord)
    // The returned record arrives at the full-size current position, even
    // when the live slot is still scaling up from a queue preview.
    if (returning) record.style.transform = 'translate(-50%, -50%) scale(1)'
    const ghost = document.createElement('div')
    ghost.className = 'flow-disc-transition'
    ghost.setAttribute('aria-hidden', 'true')
    ghost.inert = true
    ghost.append(record)
    arc.append(ghost)
    motion.ghost = ghost
    const distance = (arc.clientWidth + record.offsetWidth) / 2 + 16
    const outside = `translateX(${distance}px)`
    animation = ghost.animate([
      { transform: from || (returning ? outside : 'translateX(0)') },
      { transform: returning ? 'translateX(0)' : outside },
    ], DISC_MOTION)
    animation.finished.then(cleanup, cleanup)
  }

  const artwork = liveRecord.querySelector('.hero-disc')
  if (snapshot || artwork?.hasAttribute('data-cover-ready')) {
    start()
  } else if (returning && artwork && !artwork.hasAttribute('data-cover-settled')) {
    observer = new MutationObserver(() => {
      if (artwork.hasAttribute('data-cover-ready')) start()
      else if (artwork.hasAttribute('data-cover-settled')) cleanup()
    })
    observer.observe(artwork, { attributes: true, attributeFilter: ['data-cover-ready', 'data-cover-settled'] })
  } else {
    cleanup()
    return null
  }
  return motion
}

export function readDiscSlots(arc, desktop = false) {
  return new Map([...arc.querySelectorAll('.flow-disc-slot')].map((node) => [
    node.dataset.discKey,
    {
      node,
      y: Number(node.style.getPropertyValue('--slot-mobile-y')),
      depth: Number(node.style.getPropertyValue('--slot-depth')),
      ...(desktop ? {
        x: parseFloat(node.style.getPropertyValue('--slot-x')),
        desktopY: parseFloat(node.style.getPropertyValue('--slot-y')),
        // Removed React nodes lose their computed styles; snapshot the platter
        // while it is still connected, including its playback rotation.
        record: cloneDiscRecord(node.querySelector('.flow-disc-position')),
      } : {}),
    },
  ]))
}

const DRUM_MOTION = { ...DISC_MOTION, duration: 650 }
const translate = ({ x, y }) => `translate(${x}px, ${y}px)`

const slotAngle = (x) => x === 0 ? -Math.PI / 2 : x > 0 ? Math.PI / 6 : Math.PI * 5 / 6
const BOTTOM_ANGLE = Math.PI / 2

// Complete the orbit below the clipped hero. A queued cover replaces the old
// one only at the bottom, where the entire record is outside the viewport.
function drumPoint(angle, width, height, size) {
  const radiusX = width * 0.32 / Math.sin(Math.PI / 3)
  const radiusY = height * 0.43 / 1.5
  const bottom = Math.max(radiusY * 2, height * 0.47 + size / 2 + 16)
  const normalized = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
  const lowerArc = normalized >= Math.PI / 6 && normalized <= Math.PI * 5 / 6
  const dip = lowerArc ? Math.sin((normalized - Math.PI / 6) * 1.5) ** 2 : 0
  return {
    x: Math.cos(angle) * radiusX,
    y: radiusY + Math.sin(angle) * radiusY + (bottom - radiusY * 2) * dip,
  }
}

function drumRoute(fromAngle, targetAngle, direction, range = [0, 1]) {
  let delta = (targetAngle - fromAngle) % (Math.PI * 2)
  if (Math.abs(delta) < 0.000001 || Math.PI * 2 - Math.abs(delta) < 0.000001) delta = 0
  if (direction > 0 && delta > 0) delta -= Math.PI * 2
  if (direction < 0 && delta < 0) delta += Math.PI * 2
  return (progress) => fromAngle + delta * Math.max(0, Math.min(1,
    (progress - range[0]) / (range[1] - range[0]),
  ))
}

function drumFrames(from, to, width, height, size, angleAt) {
  const start = drumPoint(angleAt(0), width, height, size)
  const driftX = from.x - start.x
  const driftY = from.y - start.y
  const points = Array.from({ length: 25 }, (_, index) => {
    const progress = index / 24
    const orbit = drumPoint(angleAt(progress), width, height, size)
    const point = index === 0 ? from : index === 24 ? to :
      { x: orbit.x + driftX * (1 - progress), y: orbit.y + driftY * (1 - progress) }
    return point
  })
  return {
    frames: points.map((point, index) => ({ transform: translate(point), offset: index / 24 })),
    pointAt(progress) {
      const position = Math.max(0, Math.min(24, progress * 24))
      const first = points[Math.floor(position)]
      const last = points[Math.ceil(position)]
      const fraction = position % 1
      return { x: first.x + (last.x - first.x) * fraction, y: first.y + (last.y - first.y) * fraction }
    },
  }
}

export function animateDiscDialEntrance(arc, slots, onFinish) {
  const width = arc.clientWidth
  const height = arc.clientHeight
  const size = arc.querySelector('.flow-disc-position')?.offsetWidth || 0
  const ready = [...slots.values()].filter((slot) =>
    slot.node.querySelector('.hero-disc')?.hasAttribute('data-cover-ready'))
  // Rotate the whole arrangement around one pivot, like a telephone dial.
  // Keep the pivot below the clipped edge, so even a tall desktop viewport
  // has enough room to conceal the records before their first entrance.
  const hiddenY = height * 0.47 + size / 2 + 2
  const sideX = width * 0.32, sideY = height * 0.43
  const pivotY = Math.max((sideX ** 2 + sideY ** 2) / (2 * sideY), hiddenY)
  const records = ready.map((slot) => {
    const x = slot.x * width / 100, y = slot.desktopY * height / 100 - pivotY
    return { slot, x, y, angle: Math.atan2(y, x), radius: Math.hypot(x, y) }
  })
  const head = records.reduce((first, record) => !first || record.angle < first.angle ? record : first, null)
  // The first existing record starts just below the edge. With no previous
  // track, the current record leads the entrance instead of an invented slot.
  const rotation = head ? (Math.asin((hiddenY - pivotY) / head.radius) - head.angle) * 180 / Math.PI : 0
  const transform = (record, angle) =>
    `translate(0px, ${pivotY}px) rotate(${angle}deg) translate(${record.x}px, ${record.y}px) rotate(${-angle}deg)`
  const startTime = document.timeline.currentTime
  // Identical angular motion preserves the distance between every pair of
  // records. Counter-rotation keeps their artwork upright during the orbit.
  const animations = records.map((record) => {
    const animation = record.slot.node.animate([
      { transform: transform(record, rotation) },
      { transform: transform(record, 0) },
    ], { ...DRUM_MOTION, duration: 750, fill: 'both' })
    animation.startTime = startTime
    return animation
  })
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    for (const animation of animations) animation.cancel()
  }
  Promise.all(animations.map((animation) => animation.finished.catch(() => {}))).then(() => {
    if (cleaned) return
    cleanup()
    onFinish?.()
  })
  return { animations, cleanup }
}

export function animateDiscDrum(arc, previous, current, { direction, interrupted }) {
  const width = arc.clientWidth
  const height = arc.clientHeight
  const size = arc.querySelector('.flow-disc-position')?.offsetWidth || 0
  const bottom = { ...drumPoint(BOTTOM_ANGLE, width, height, size), x: 0 }
  const sources = new Map()
  // Sample all moving copies before cancelling any of them. Rapid next/prev
  // clicks keep the visible position, including an outgoing record that returns.
  for (const [key, entry] of interrupted?.entries || []) {
    const progress = entry.animation.effect?.getComputedTiming().progress ?? 0
    // React may have removed a moving slot in this commit. Detached elements
    // lose computed styles; their animation still gives us the rendered frame.
    const matrix = entry.node.isConnected === false ? null :
      new DOMMatrixReadOnly(getComputedStyle(entry.node).transform)
    const point = matrix ? { x: matrix.m41, y: matrix.m42 } : entry.pointAt(progress)
    const record = cloneDiscRecord(entry.record)
    record.style.transform = 'translate(-50%, -50%) scale(1)'
    sources.set(key, {
      ...point, angle: entry.angleAt(progress), record,
    })
  }
  interrupted?.cleanup()

  const entries = new Map()
  let observer = null
  let cleaned = false
  let started = false
  const motion = { entries, cleanup }
  function cleanup() {
    if (cleaned) return
    cleaned = true
    observer?.disconnect()
    for (const entry of entries.values()) {
      entry.animation.cancel()
      if (entry.live) entry.node.style.visibility = entry.visibility
      else entry.node.remove()
    }
    entries.clear()
  }
  const add = (key, node, record, from, to, live, angleAt) => {
    const visibility = node.style.visibility
    const { frames, pointAt } = drumFrames(from, to, width, height, size, angleAt)
    const animation = node.animate(frames, DRUM_MOTION)
    animation.pause()
    animation.currentTime = 0
    if (live && !record.querySelector('.hero-disc')?.hasAttribute('data-cover-ready')) {
      node.style.visibility = 'hidden'
    }
    entries.set(key, { node, record, animation, live, visibility, angleAt, pointAt })
  }
  for (const [key, slot] of current) {
    const old = previous.get(key)
    const source = sources.get(key)
    const to = { x: slot.x * width / 100, y: slot.desktopY * height / 100 }
    const from = source || (old ? {
      x: old.x * width / 100, y: old.desktopY * height / 100,
    } : bottom)
    const fromAngle = source?.angle ?? (old ? slotAngle(old.x) : BOTTOM_ANGLE)
    const entering = !old && !source && slot.x !== 0
    add(key, slot.node, slot.node.querySelector('.flow-disc-position'), from, to, true,
      drumRoute(fromAngle, slotAngle(slot.x), direction, entering ? [0.5, 1] : [0, 1]))
  }
  const removed = new Map([...previous, ...sources])
  for (const [key, slot] of removed) {
    if (current.has(key)) continue
    const source = sources.get(key)
    const from = source || { x: slot.x * width / 100, y: slot.desktopY * height / 100 }
    const record = (source || slot).record
    if (!record.querySelector('.hero-disc')?.hasAttribute('data-cover-ready')) continue
    const ghost = document.createElement('div')
    ghost.className = 'flow-disc-drum-transition'
    ghost.setAttribute('data-disc-key', key)
    ghost.style.zIndex = 3
    ghost.setAttribute('aria-hidden', 'true')
    ghost.inert = true
    ghost.append(record)
    arc.append(ghost)
    add(key, ghost, record, from, bottom, false,
      drumRoute(source?.angle ?? slotAngle(slot.x), BOTTOM_ANGLE, direction,
        source ? [0, 1] : [0, 0.5]))
  }
  // Hold every record at its starting position until new light artwork is
  // decoded. The entire drum then moves on the same frame, without empty discs
  // or one preview arriving after the rest of the group.
  const start = () => {
    if (cleaned || started) return
    const live = [...entries.values()].filter((entry) => entry.live)
    if (live.some((entry) => !entry.record.querySelector('.hero-disc')?.hasAttribute('data-cover-settled'))) return
    started = true
    observer?.disconnect()
    const startTime = document.timeline.currentTime
    for (const entry of entries.values()) {
      if (entry.live && entry.record.querySelector('.hero-disc')?.hasAttribute('data-cover-ready')) {
        entry.node.style.visibility = entry.visibility
      }
      entry.animation.play()
      entry.animation.startTime = startTime
    }
    Promise.all([...entries.values()].map((entry) => entry.animation.finished.catch(() => {}))).then(cleanup)
  }
  observer = new MutationObserver(start)
  observer.observe(arc, { subtree: true, attributes: true, attributeFilter: ['data-cover-settled'] })
  start()
  return motion
}

function animateSlot(motions, key, node, from, to, remove = false) {
  motions.get(key)?.cleanup()
  const animation = node.animate([from, to], DISC_MOTION)
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    animation.cancel()
    if (remove) node.remove()
    if (motions.get(key)?.cleanup === cleanup) motions.delete(key)
  }
  motions.set(key, { node, animation, cleanup })
  animation.finished.then(cleanup, cleanup)
}

// Newly queued records enter from below. Removed previews leave through the
// same edge, while records already in the stack keep their CSS transitions.
export function animateDiscStack(arc, previous, current, motions, slidingKey) {
  const size = arc.querySelector('.flow-disc-position')?.offsetWidth || 0
  if (!size) return
  const step = size * 0.34
  for (const [key, slot] of current) {
    const interrupted = motions.get(key)
    if (key === slidingKey) {
      interrupted?.cleanup()
      continue
    }
    if (previous.has(key) && !interrupted) continue
    const to = { transform: `translateY(${slot.y * size}px)` }
    const from = interrupted ? {
      transform: getComputedStyle(interrupted.node).transform,
    } : { transform: `translateY(${slot.y * size + step}px)` }
    animateSlot(motions, key, slot.node, from, to)
  }
  for (const [key, slot] of previous) {
    if (current.has(key) || key === slidingKey || slot.depth === 0) continue
    const source = slot.node.querySelector('.flow-disc-position')
    if (!source) continue
    const record = cloneDiscRecord(source)
    const ghost = document.createElement('div')
    ghost.className = 'flow-disc-stack-transition'
    ghost.style.zIndex = 3 - slot.depth
    ghost.setAttribute('aria-hidden', 'true')
    ghost.inert = true
    ghost.append(record)
    arc.append(ghost)
    const fromY = slot.y * size
    animateSlot(motions, key, ghost,
      { transform: `translateY(${fromY}px)` },
      { transform: `translateY(${fromY + step}px)` }, true)
  }
}

export function clearDiscStack(motions) {
  for (const motion of [...motions.values()]) motion.cleanup()
}
