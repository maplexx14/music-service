import { counterRotation } from './cdDiscExchange.js'

// Borrow the queue's real records while the finger moves the disc plane.
// The exchange takes over at the same offset after the release.
export function createCdDiscSwipe(overlay, root) {
  let records = [], offset = 0, velocity = 0, scaleX = 1
  const clear = () => {
    for (const { node, parent, nextSibling, style } of records) {
      node.style.cssText = style
      parent.insertBefore(node, nextSibling?.parentElement === parent ? nextSibling : null)
    }
    records = []
    offset = 0
  }
  return {
    offset: () => offset,
    visibleOffset: () => (parseFloat(getComputedStyle(overlay).translate) || 0) * scaleX,
    setReleaseVelocity(value) { velocity = value },
    release(direction) {
      const incoming = records.find(entry => entry.slot === direction)
      if (!incoming) return null
      // The chassis has smoothly aligned since the finger was released.
      // Measure its final projection without changing the visible disc pose.
      const target = overlay.getBoundingClientRect()
      const from = parseFloat(overlay.style.translate) || 0
      const translate = overlay.style.translate
      overlay.style.translate = `${from + 1}px 0px 2px`
      const shifted = overlay.getBoundingClientRect()
      scaleX = Math.abs(shifted.left + shifted.width / 2 - target.left - target.width / 2) || 1
      overlay.style.translate = translate
      const pitch = incoming.localPitch * target.width / overlay.offsetWidth
      return { element: overlay, from, to: -pitch / scaleX, velocity: velocity / scaleX,
        incomingFrom: incoming.node.style.transform, incomingTo: `translateX(${incoming.localPitch}px)` }
    },
    incomingFor: key => records.find(entry => entry.key === key)?.node,
    placementFor: key => records.find(entry => entry.key === key),
    update(distance) {
      if (!records.length) {
        const target = overlay.getBoundingClientRect()
        // CSS perspective magnifies a plane's translate. Calibrate once so
        // finger pixels and the final installed position use the same space.
        const restingTranslate = overlay.style.translate || ''
        const restingX = parseFloat(restingTranslate) || 0
        overlay.style.translate = `${restingX + 1}px 0px 2px`
        const shifted = overlay.getBoundingClientRect()
        scaleX = Math.abs(shifted.left + shifted.width / 2 - target.left - target.width / 2) || 1
        overlay.style.translate = restingTranslate
        const orientation = counterRotation(overlay)
        for (const record of root.querySelectorAll('[data-queue-record]')) {
          if (Math.abs(Number(record.dataset.queueSlot)) !== 1) continue
          const node = record.querySelector('.hero-disc')
          if (!node?.querySelector('canvas') || !target.width) continue
          const rect = node.getBoundingClientRect()
          const pitch = (rect.left + rect.width / 2 - target.left - target.width / 2) / target.width * overlay.offsetWidth
          records.push({ key: record.dataset.queueRecord, slot: Number(record.dataset.queueSlot),
            pitch: rect.left + rect.width / 2 - target.left - target.width / 2, localPitch: pitch,
            node, parent: node.parentElement,
            nextSibling: node.nextSibling, style: node.style.cssText })
          Object.assign(node.style, {
            position: 'absolute', inset: '0', width: '100%', height: '100%', margin: '0',
            opacity: '1', filter: 'none', boxShadow: 'none',
            overflow: 'visible', transform: `translateX(${pitch}px) ${orientation}`.trim(), transition: 'none',
          })
          overlay.append(node)
        }
      }
      offset = distance
      overlay.style.translate = `${distance / scaleX}px 0px 2px`
    },
    prepare() {
      const width = overlay.getBoundingClientRect().width
      const localOffset = width ? offset / width * overlay.offsetWidth : 0
      clear()
      overlay.style.translate = ''
      return localOffset
    },
    clear,
  }
}
