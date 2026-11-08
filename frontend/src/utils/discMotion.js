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

export function readDiscSlots(arc) {
  return new Map([...arc.querySelectorAll('.flow-disc-slot')].map((node) => [
    node.dataset.discKey,
    { node, y: Number(node.style.getPropertyValue('--slot-mobile-y')), depth: Number(node.style.getPropertyValue('--slot-depth')) },
  ]))
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
  const step = size * 0.4
  for (const [key, slot] of current) {
    const interrupted = motions.get(key)
    if (key === slidingKey) {
      interrupted?.cleanup()
      continue
    }
    if (previous.has(key) && !interrupted) continue
    const to = { transform: `translateY(${slot.y * size}px)`, opacity: 1 }
    const from = interrupted ? {
      transform: getComputedStyle(interrupted.node).transform,
      opacity: getComputedStyle(interrupted.node).opacity,
    } : { transform: `translateY(${slot.y * size + step}px)`, opacity: 0 }
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
      { transform: `translateY(${fromY}px)`, opacity: 1 },
      { transform: `translateY(${fromY + step}px)`, opacity: 0 }, true)
  }
}

export function clearDiscStack(motions) {
  for (const motion of [...motions.values()]) motion.cleanup()
}
