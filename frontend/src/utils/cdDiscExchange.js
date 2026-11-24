import { returnCdQueueRecord } from './cdQueueHandoff.js'
import { cdDiscSwipeRelease } from './cdDiscSwipeMotion.js'

// Slower than the old 440 ms → 520 ms, with a soft overshoot at the end.
export const CD_DISC_EXCHANGE_DURATION = 520
const EASING = 'cubic-bezier(0.3, 1.12, 0.5, 1)'

export function counterRotation(element) {
  if (typeof DOMMatrix !== 'function') return ''
  const transform = getComputedStyle(element).transform
  if (!transform || transform === 'none') return ''
  const matrix = new DOMMatrix(transform)
  // Remove scale and translation: only counter the destination plane's
  // orientation while a flat queue record is being reparented into it.
  for (const column of [[ 'm11', 'm12', 'm13' ], [ 'm21', 'm22', 'm23' ], [ 'm31', 'm32', 'm33' ]]) {
    const length = Math.hypot(...column.map(key => matrix[key]))
    if (length < 1e-8) return ''
    for (const key of column) matrix[key] /= length
  }
  matrix.m41 = matrix.m42 = matrix.m43 = matrix.m14 = matrix.m24 = matrix.m34 = 0
  matrix.m44 = 1
  return matrix.inverse().toString()
}

function copyQueueArtwork(source, target, width = target.width, height = target.height) {
  const copy = document.createElement('canvas')
  copy.width = source.width
  copy.height = source.height
  copy.getContext('2d').drawImage(source, 0, 0)
  const padded = !source.classList.contains?.('cd-queue-transferred')
  target.width = width
  target.height = height
  target.getContext('2d').drawImage(copy,
    padded ? copy.width / 6 : 0, padded ? copy.height / 6 : 0,
    padded ? copy.width * 2 / 3 : copy.width, padded ? copy.height * 2 / 3 : copy.height,
    0, 0, width, height)
  if (target.dataset) {
    if (source.dataset?.cdTrackId) target.dataset.cdTrackId = source.dataset.cdTrackId
    target.dataset.cdArtworkReady = 'true'
    target.dataset.cdTextureVersion = String(Number(target.dataset.cdTextureVersion || 0) + 1)
  }
}

// Keep the departing print intact until the chassis is neutral and the next
// artwork is ready. Both records then travel on the same native timeline.
export function createCdDiscExchange({ canvas, layer, paint, canAnimate, align, onHold, onSlide, onChange, onCanvas = () => {} }) {
  let exchange = null, disposed = false
  const pendingDepartures = new Set()
  const expedite = current => {
    for (const animation of current.animations) {
      const duration = animation.effect?.getTiming?.()?.duration || CD_DISC_EXCHANGE_DURATION
      const rate = Math.max(animation.playbackRate || 1, (duration - (animation.currentTime || 0)) / 80)
      if (animation.updatePlaybackRate) animation.updatePlaybackRate(rate)
      else animation.playbackRate = rate
    }
  }
  const releasePresentation = current => {
    if (!current.finished || current.presentationReleased ||
        (current.outgoingParked && !current.outgoingSettled)) return
    current.presentationReleased = true
    onHold(false)
    onSlide(false)
    onChange()
  }
  const restorePrevious = current => {
    const previous = current.previous
    if (!previous) return
    current.previous = null
    if (current.transfer?.preservePrevious) { returnCdQueueRecord(previous); return }
    previous.node.style.cssText = previous.style
    previous.parent.insertBefore(previous.node, previous.nextSibling?.parentElement === previous.parent ? previous.nextSibling : null)
  }
  const parkOutgoing = current => {
    if (current.outgoingParked || !current.transfer?.park || !current.sliding || !current.outgoingTo) return false
    current.outgoingParked = true
    restorePrevious(current)
    let settled = false
    const record = {
      canvas: current.departedCanvas,
      place(host) {
        current.departedCanvas.classList.add('cd-queue-transferred')
        host.replaceChildren(current.departedCanvas)
        this.settle()
      },
      settle() {
        if (settled) return
        settled = true
        pendingDepartures.delete(record)
        current.outgoingSettled = true
        current.animations[0].onfinish = null
        current.animations[0].cancel()
        current.departing.remove()
        if (exchange !== current) { current.beltAnimation?.cancel(); current.belt?.remove() }
        releasePresentation(current)
        onChange()
      },
    }
    pendingDepartures.add(record)
    const accepted = current.transfer.park(record) !== false
    if (accepted && current.transfer.outgoing && !current.transfer.preservePrevious) {
      // Place the departing disc on its own completion event. React can
      // relabel this slot after the other disc arrives without moving pixels.
      current.transfer.outgoing.style.visibility = current.transfer.outgoingVisibility || ''
      current.transfer.outgoing.style.opacity = String(current.transfer.outgoingOpacity ?? 1)
      current.transfer.outgoing.style.filter = current.transfer.outgoingFilter || 'none'
      record.place(current.transfer.outgoing)
    }
    return accepted
  }
  const finish = () => {
    if (!exchange) return
    const current = exchange
    exchange = null
    if (current.swipeDriven) {
      const previousCanvas = canvas
      const nextCanvas = current.transfer.incoming.querySelector('canvas')
      // Queue bitmaps have a padded shadow; remove that padding only once
      // the record has arrived, keeping the same printed pixels throughout.
      copyQueueArtwork(nextCanvas, nextCanvas, previousCanvas.width, previousCanvas.height)
      for (const animation of current.animations) { animation.onfinish = null; animation.cancel() }
      current.transfer.prepare?.()
      previousCanvas.remove()
      nextCanvas.classList.remove('cd-queue-transferred')
      nextCanvas.style.cssText = ''
      layer.append(nextCanvas)
      canvas = nextCanvas
      onCanvas(canvas)
      if (current.image !== undefined) paint(current.image)
      previousCanvas.style.transform = current.departedRotation
      current.transfer.park?.({
        canvas: previousCanvas,
        place(host) {
          previousCanvas.classList.add('cd-queue-transferred')
          host.replaceChildren(previousCanvas)
        },
        settle() {},
      })
      current.transfer.release?.()
      onHold(false)
      onSlide(false)
      onChange()
      current.onComplete?.()
      return
    }
    if (!current.sliding) current.transfer?.prepare?.()
    if (current.ready && !current.sliding) {
      if (current.image === undefined && current.transfer) copyQueueArtwork(current.transfer.incoming.querySelector('canvas'), canvas)
      else paint(current.image)
    }
    if (current.transfer && current.sliding) {
      const nextCanvas = current.transfer.incoming.querySelector('canvas')
      canvas = nextCanvas
      canvas.classList.remove('cd-queue-transferred')
      if (canvas.width !== current.departedCanvas.width) canvas.width = current.departedCanvas.width
      if (canvas.height !== current.departedCanvas.height) canvas.height = current.departedCanvas.height
      canvas.style.cssText = ''
      layer.append(canvas)
      onCanvas(canvas)
      if (current.image !== undefined) paint(current.image)
    }
    const parked = current.outgoingParked || parkOutgoing(current)
    restorePrevious(current)
    for (const record of current.extras || []) returnCdQueueRecord(record)
    current.extras = []
    for (const animation of current.animations) {
      animation.onfinish = null
      const keepDeparture = parked && !current.outgoingSettled &&
        (animation === current.animations[0] || animation === current.beltAnimation)
      if (!keepDeparture) animation.cancel()
    }
    if (!parked) current.departing?.remove()
    if (current.transfer) {
      const { incoming, parent, nextSibling, style, outgoing, outgoingVisibility } = current.transfer
      if (current.sliding) {
        incoming.style.cssText = style
        parent.insertBefore(incoming, nextSibling?.parentElement === parent ? nextSibling : null)
        if (outgoing) outgoing.style.visibility = outgoingVisibility
        layer.style.visibility = current.layerVisibility
      }
      current.transfer.release?.()
    }
    if (!parked || current.outgoingSettled) current.belt?.remove()
    // The completed departing record still belongs to the chassis until its
    // queue slot adopts it. Resuming the chassis before that commit moves the
    // retained belt for one frame, then snaps the record back into the queue.
    current.finished = true
    releasePresentation(current)
    current.onComplete?.()
  }
  const start = current => {
    if (disposed || exchange !== current || current.sliding || !current.ready || !current.aligned) return
    if (typeof current.transfer?.swipe === 'function') {
      current.transfer.swipe = current.transfer.swipe()
      const queueReady = current.transfer.incoming.querySelector('canvas')?.dataset?.cdArtworkReady === 'true'
      if (!current.transfer.swipe && current.image === undefined && !queueReady) { current.ready = false; return }
    }
    if (!canAnimate()) {
      if (current.transfer?.swipe) {
        current.swipeDriven = true
        current.departedRotation = getComputedStyle(canvas).transform
      }
      finish()
      return
    }
    current.sliding = true
    onSlide(true)
    if (current.transfer?.swipe) {
      // Keep the exact plane and records that were under the finger. Changing
      // parents or waiting for the hero cover at release breaks continuity.
      current.swipeDriven = true
      current.departedRotation = getComputedStyle(canvas).transform
      const { element, from, to, velocity, incomingFrom, incomingTo } = current.transfer.swipe
      const options = cdDiscSwipeRelease(from, to, velocity)
      const belt = element.animate([
        { translate: `${from}px 0px 2px` }, { translate: `${to}px 0px 2px` },
      ], options)
      belt.id = 'cd-disc-belt'
      const arriving = current.transfer.incoming.animate([
        { opacity: current.transfer.incomingOpacity ?? 0.72, filter: 'brightness(0.88)', ...(incomingFrom ? { transform: incomingFrom } : {}) },
        { opacity: 1, filter: 'brightness(1)', ...(incomingTo ? { transform: incomingTo } : {}) },
      ], options)
      arriving.id = 'cd-disc-enter'
      belt.startTime = arriving.startTime = document.timeline.currentTime
      current.animations = [belt, arriving]
      belt.onfinish = () => { if (exchange === current) finish() }
      if (current.urgent) expedite(current)
      return
    }
    const swipeOffset = current.transfer?.prepare?.() || 0
    const departingCanvas = canvas
    const rotation = getComputedStyle(departingCanvas).transform
    const departing = layer.cloneNode(false)
    departing.removeAttribute?.('data-cd-disc-slot')
    departingCanvas.style.transform = rotation
    departing.append(departingCanvas)
    layer.parentElement.append(departing)
    current.departing = departing
    current.departedCanvas = departingCanvas
    const target = layer.parentElement.getBoundingClientRect?.()
    const transfer = current.transfer
    const queueOrientation = transfer?.horizontal ? counterRotation(layer.parentElement) : ''
    if (target?.width) transfer?.alignQueue?.(target)
    const localPose = rect => {
      const size = layer.parentElement.offsetWidth
      const scale = rect.width / target.width
      const x = (rect.left + rect.width / 2 - target.left - target.width / 2) / target.width * size
      const y = (rect.top + rect.height / 2 - target.top - target.height / 2) / target.height * size
      if (transfer?.horizontal) return `translateX(${x}px)`
      return `translate(${x}px, ${y}px) scale(${scale})`
    }
    let incomingElement = layer, incomingFrom, outgoingTo
    if (transfer && target?.width) {
      const sourceRect = transfer.incoming.getBoundingClientRect()
      const outgoingRect = transfer.outgoing?.getBoundingClientRect() || {
        ...sourceRect, left: target.left * 2 + target.width - sourceRect.left - sourceRect.width,
      }
      incomingFrom = localPose(sourceRect)
      outgoingTo = outgoingRect ? localPose(outgoingRect) : null
      incomingElement = transfer.incoming
      if (transfer.horizontal) {
        // One transform moves both discs. Independent transforms can flatten
        // different 3D layers and leave the outgoing print visually at rest.
        const pitch = (sourceRect.left + sourceRect.width / 2 - target.left - target.width / 2) / target.width * layer.parentElement.offsetWidth
        current.belt = layer.cloneNode(false)
        current.belt.removeAttribute?.('data-cd-disc-slot')
        current.belt.classList.add('cd-deck-disc-belt')
        current.belt.append(departing)
        layer.parentElement.append(current.belt)
        current.beltDistance = -pitch
        outgoingTo = `translateX(${-pitch}px)`
        if (transfer.outgoing?.parentElement) {
          const previous = transfer.outgoing
          const previousStyle = getComputedStyle(previous)
          current.previous = { node: previous, parent: previous.parentElement, nextSibling: previous.nextSibling,
            style: previous.style.cssText, targetSlot: -current.direction * 2 }
          Object.assign(previous.style, {
            position: 'absolute', inset: '0', width: '100%', height: '100%', margin: '0',
            opacity: previousStyle.opacity, filter: previousStyle.filter, boxShadow: 'none',
            overflow: 'visible', transform: `translateX(${-pitch}px) ${queueOrientation}`.trim(), transition: 'none',
          })
          current.belt.append(previous)
        }
        current.extras = []
        const movingNodes = new Set([incomingElement, transfer.outgoing])
        for (const { node, slot } of transfer.extras || []) {
          if (!node?.parentElement || movingNodes.has(node)) continue
          movingNodes.add(node)
          const rect = node.getBoundingClientRect()
          const style = getComputedStyle(node)
          current.extras.push({ node, parent: node.parentElement, nextSibling: node.nextSibling,
            style: node.style.cssText, targetSlot: slot - current.direction })
          Object.assign(node.style, {
            position: 'absolute', inset: '0', width: '100%', height: '100%', margin: '0',
            opacity: style.opacity, filter: style.filter, boxShadow: 'none', overflow: 'visible',
            transform: `${localPose(rect)} ${queueOrientation}`.trim(), transition: 'none',
          })
          current.belt.append(node)
        }
      }
      current.layerVisibility = layer.style.visibility
      layer.style.visibility = 'hidden'
      if (transfer.outgoing && !current.previous) transfer.outgoing.style.visibility = 'hidden'
      Object.assign(incomingElement.style, {
        position: 'absolute', inset: '0', width: '100%', height: '100%', margin: '0',
        opacity: '1', filter: 'none', boxShadow: 'none', overflow: 'visible', transform: 'none', transition: 'none',
      })
      // Queue previews include padding around the record. Use the final
      // artwork and footprint throughout the slide, so handing the canvas
      // to the active layer cannot change its geometry on the last frame.
      const arrivingCanvas = incomingElement.querySelector('canvas')
      if (current.image === undefined) copyQueueArtwork(arrivingCanvas, arrivingCanvas, departingCanvas.width, departingCanvas.height)
      else {
        arrivingCanvas.width = departingCanvas.width
        arrivingCanvas.height = departingCanvas.height
        paint(current.image, arrivingCanvas)
      }
      arrivingCanvas.classList.add('cd-queue-transferred')
      arrivingCanvas.style.cssText = ''
      layer.parentElement.append(incomingElement)
      if (current.belt) {
        incomingElement.style.transform = incomingFrom
        current.belt.append(incomingElement)
      }
    } else {
      canvas = document.createElement('canvas')
      canvas.width = departingCanvas.width
      canvas.height = departingCanvas.height
      layer.append(canvas)
      onCanvas(canvas)
      paint(current.image)
    }
    current.outgoingTo = outgoingTo
    const distance = current.direction * 120
    const options = { duration: CD_DISC_EXCHANGE_DURATION, easing: EASING, fill: 'both' }
    let outgoingFrames = [
      { transform: 'translateX(0%)', opacity: 1, filter: 'brightness(1) blur(0px)' },
      { transform: outgoingTo || `translateX(${-distance}%)`, opacity: outgoingTo ? transfer.outgoingOpacity ?? 1 : 0, filter: outgoingTo ? transfer.outgoingFilter || 'brightness(1)' : 'brightness(1)' },
    ]
    let incomingFrames = [
      { transform: incomingFrom || `translateX(${distance}%)`, opacity: incomingFrom ? transfer.incomingOpacity ?? 1 : 0, filter: incomingFrom ? transfer.incomingFilter || 'brightness(1)' : 'brightness(1)' },
      { transform: 'translateX(0%)', opacity: 1, filter: 'brightness(1) blur(0px)' },
    ]
    if (current.belt) {
      outgoingFrames = outgoingFrames.map(({ transform, ...frame }) => frame)
      incomingFrames = incomingFrames.map(({ transform, ...frame }) => frame)
      if (queueOrientation) {
        // The belt owns translation; each record gradually joins or leaves
        // the chassis plane without an orientation jump at reparenting.
        outgoingFrames[0].transform = 'none'
        outgoingFrames[1].transform = queueOrientation
        incomingFrames[0].transform = `${incomingFrom} ${queueOrientation}`
        incomingFrames[1].transform = incomingFrom
      }
    }
    const outgoing = departing.animate(outgoingFrames, options)
    const incoming = incomingElement.animate(incomingFrames, options)
    outgoing.id = 'cd-disc-exit'
    incoming.id = 'cd-disc-enter'
    outgoing.startTime = incoming.startTime = document.timeline.currentTime
    current.animations = [outgoing, incoming]
    if (current.belt) {
      const beltAnimation = current.belt.animate([
        { transform: `translateX(${swipeOffset}px)` }, { transform: `translateX(${current.beltDistance}px)` },
      ], options)
      beltAnimation.id = 'cd-disc-belt'
      beltAnimation.startTime = outgoing.startTime
      current.beltAnimation = beltAnimation
      current.animations.push(beltAnimation)
      beltAnimation.onfinish = () => { if (exchange === current) { parkOutgoing(current); finish() } }
    }
    outgoing.onfinish = () => {
      if (exchange === current && (!current.beltAnimation || current.beltAnimation.playState === 'finished')) parkOutgoing(current)
    }
    incoming.onfinish = () => { if (!current.beltAnimation && exchange === current) finish() }
    if (current.urgent) expedite(current)
  }
  return {
    begin(direction = 1, transfer = null, onComplete, targetKey) {
      if (disposed) return
      finish()
      // A new shift reads the committed queue. Any old, unclaimed transfer
      // is obsolete now and must not remain as a second visible disc.
      for (const record of [...pendingDepartures]) record.settle()
      const queueReady = transfer?.incoming?.querySelector('canvas')?.dataset?.cdArtworkReady === 'true'
      const current = { direction: direction < 0 ? -1 : 1, transfer, onComplete, targetKey, ready: Boolean(transfer?.swipe || queueReady), aligned: false, sliding: false, animations: [] }
      exchange = current
      onHold(true)
      Promise.resolve(align(transfer)).then(() => {
        if (exchange !== current || disposed) return
        current.aligned = true
        start(current)
      })
    },
    expedite() {
      if (!exchange || disposed) return
      exchange.urgent = true
      expedite(exchange)
    },
    settleQueueHandoffs() {
      for (const record of [...pendingDepartures]) record.settle()
    },
    setArtwork(image, key) {
      if (disposed) return
      if (exchange?.targetKey !== undefined && key !== exchange.targetKey) return
      if (!exchange) { paint(image); onChange(); return }
      exchange.image = image
      exchange.ready = true
      if (exchange.sliding) { if (!exchange.transfer) { paint(image); onChange() } }
      else start(exchange)
    },
    failArtwork(key) {
      if (!exchange || exchange.ready || disposed) return
      if (exchange.targetKey !== undefined && key !== exchange.targetKey) return
      exchange.image = null
      exchange.ready = true
      start(exchange)
    },
    sync() { if (exchange && !canAnimate()) finish() },
    dispose() { disposed = true; finish(); for (const record of [...pendingDepartures]) record.settle() },
  }
}
