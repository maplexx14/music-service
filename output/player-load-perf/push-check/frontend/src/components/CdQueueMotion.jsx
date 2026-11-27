import { Children, Component, createRef } from 'react'

const RECORDS = '[data-queue-record]'
const EASING = 'cubic-bezier(0.22, 1, 0.36, 1)'
const ROTATE_DURATION = 440
const SOFTWARE_ROTATE_DURATION = 280
const ROTATE_EASING = 'cubic-bezier(0.4, 0, 0.2, 1)'
const center = (rect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
const unwrap = (angle, near) => angle + Math.round((near - angle) / (Math.PI * 2)) * Math.PI * 2

function cloneRecord(source) {
  const record = source.cloneNode(true)
  const canvases = [...record.querySelectorAll('canvas')]
  source.querySelectorAll('canvas').forEach((canvas, index) => {
    canvases[index]?.getContext('2d')?.drawImage(canvas, 0, 0)
  })
  return record
}

const sameRecords = (before, after) => {
  const previous = Children.toArray(before)
  const next = Children.toArray(after)
  return previous.length === next.length && previous.every((child, index) =>
    child.props?.['data-queue-record'] === next[index].props?.['data-queue-record'] &&
    child.props?.['data-queue-slot'] === next[index].props?.['data-queue-slot'])
}

// Read the visible positions before React moves keyed records. An interrupted
// transition then continues from the current frame, including its scale.
export default class CdQueueMotion extends Component {
  root = createRef()
  animations = new Set()
  ghosts = new Set()
  entered = false
  inViewport = false

  componentDidMount() {
    const root = this.root.current
    this.liteMode = document.documentElement.classList.contains('lite-mode')
    const rect = root.getBoundingClientRect()
    this.dimensions = { width: root.clientWidth, height: root.clientHeight }
    this.inViewport = rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    this.reduced.addEventListener('change', this.onPreferenceChange)
    document.addEventListener('visibilitychange', this.onVisibility)
    this.resizeObserver = new ResizeObserver(() => {
      const dimensions = { width: root.clientWidth, height: root.clientHeight }
      if (dimensions.width !== this.dimensions.width || dimensions.height !== this.dimensions.height) this.clear()
      this.dimensions = dimensions
      this.enter()
    })
    this.resizeObserver.observe(root)
    this.intersectionObserver = new IntersectionObserver(([entry]) => {
      this.inViewport = entry.isIntersecting
      if (this.inViewport) this.enter()
      else this.clear()
    })
    this.intersectionObserver.observe(root)
    this.enter()
  }

  getSnapshotBeforeUpdate(previousProps) {
    if (this.props.navigationMotion === false) return null
    // A disc transfer holds the queue in its old layout. Its release already
    // placed the records, so resuming must not create another departing copy.
    if (!previousProps.active || previousProps.powerSave) return null
    // Artwork and metadata can update while the keyed records keep moving.
    // Their animation belongs to navigation, not to each React commit.
    if (previousProps.position === this.props.position && previousProps.layout === this.props.layout &&
      sameRecords(previousProps.children, this.props.children)) return null
    if (!this.entered || !this.canAnimate()) return null
    const root = this.root.current.getBoundingClientRect()
    const nextKeys = new Set(Children.toArray(this.props.children).map(child => child.props?.['data-queue-record']))
    const records = new Map([...this.root.current.querySelectorAll(RECORDS)].map(node => {
      const nodeStyle = getComputedStyle(node)
      const leaving = !nextKeys.has(node.dataset.queueRecord)
      const disc = leaving && node.querySelector('.hero-disc')
      const discStyle = disc && getComputedStyle(disc)
      return [node.dataset.queueRecord, {
        rect: node.getBoundingClientRect(),
        geometry: this.geometry(node, root, nodeStyle),
        slot: Number(node.dataset.queueSlot),
        opacity: parseFloat(nodeStyle.opacity),
        discOpacity: discStyle?.opacity,
        discTransform: discStyle?.transform,
        ghost: leaving ? cloneRecord(node) : null,
      }]
    }))
    return { records, root, movement: Math.sign(previousProps.position - this.props.position) }
  }

  componentDidUpdate(previousProps, previousState, snapshot) {
    if (previousProps.active !== this.props.active || previousProps.powerSave !== this.props.powerSave ||
      previousProps.layout !== this.props.layout || previousProps.navigationMotion !== this.props.navigationMotion) this.clear()
    if (!this.entered) { this.enter(); return }
    if (!snapshot) return
    this.clear()
    if (!this.canAnimate()) return
    // Read all destination bounds before animate() invalidates styles. All
    // records then start together without read/write layout cycles per disc.
    this.plans = []
    try { this.animateRecords(snapshot) }
    finally {
      const plans = this.plans
      this.plans = null
      for (const args of plans) this.play(...args)
    }
  }

  animateRecords(snapshot) {
    const root = this.root.current.getBoundingClientRect()
    if (Math.abs(root.width - snapshot.root.width) > 1 || Math.abs(root.height - snapshot.root.height) > 1) return
    const live = [...this.root.current.querySelectorAll(RECORDS)]
    const liveKeys = new Set(live.map(node => node.dataset.queueRecord))
    if (this.props.layout === 'linear') {
      this.motionStartedAt = document.timeline.currentTime
      const step = parseFloat(getComputedStyle(this.root.current).getPropertyValue('--queue-step')) || 80
      for (const node of live) {
        const previous = snapshot.records.get(node.dataset.queueRecord)
        const rect = node.getBoundingClientRect()
        const from = previous ? center(previous.rect).x - center(rect).x : -snapshot.movement * step
        this.play(node, [
          { opacity: previous?.opacity ?? 0, transform: `translateX(${from}px) scale(${previous ? previous.rect.width / rect.width : 0.82})` },
          { opacity: 1, transform: 'none' },
        ], this.liteMode ? 120 : 240)
      }
      for (const [key, previous] of snapshot.records) {
        if (liveKeys.has(key) || !previous.ghost) continue
        const node = previous.ghost
        node.removeAttribute('data-queue-record')
        node.setAttribute('aria-hidden', 'true')
        node.tabIndex = -1
        node.disabled = true
        node.inert = true
        node.classList.add('cd-deck-queue-exit')
        Object.assign(node.style, {
          left: `${previous.rect.left - root.left}px`, top: `${previous.rect.top - root.top}px`,
          width: `${previous.rect.width}px`, height: `${previous.rect.height}px`, pointerEvents: 'none',
        })
        node.style.setProperty('--queue-slot-size', `${previous.rect.width}px`)
        this.ghosts.add(node)
        this.root.current.append(node)
        this.play(node, [
          { opacity: previous.opacity, transform: 'none' },
          { opacity: 0, transform: `translateX(${snapshot.movement * step}px) scale(0.82)` },
        ], this.liteMode ? 120 : 240, 0, true)
      }
      return
    }
    let phase = -snapshot.movement * Math.PI / 2
    const retained = live.find(node => snapshot.records.has(node.dataset.queueRecord))
    if (retained) {
      const previous = snapshot.records.get(retained.dataset.queueRecord)
      const start = center(previous.rect)
      const { origin } = previous.geometry
      const endAngle = Number(retained.dataset.queueSlot) * Math.PI / 2
      phase = unwrap(Math.atan2(start.y - origin.y, start.x - origin.x) - endAngle, phase)
    }
    this.motionStartedAt = document.timeline.currentTime
    for (const node of live) {
      const previous = snapshot.records.get(node.dataset.queueRecord)
      if (previous) this.move(node, previous, root, phase)
      else if (Math.abs(phase) > 0.001) {
        const source = [...snapshot.records.values()].find(record => record.slot === Number(node.dataset.queueSlot) - snapshot.movement)
        this.arrive(node, root, phase, source)
      }
      else this.appear(node)
    }
    for (const [key, previous] of snapshot.records) {
      if (!liveKeys.has(key) && previous.ghost) this.depart(previous, root, snapshot.movement, phase)
    }
  }

  componentWillUnmount() {
    this.clear()
    this.resizeObserver?.disconnect()
    this.intersectionObserver?.disconnect()
    this.reduced?.removeEventListener('change', this.onPreferenceChange)
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.entered = false
  }

  onPreferenceChange = () => {
    if (this.reduced.matches) this.clear()
    else this.enter()
  }

  onVisibility = () => {
    if (document.hidden) this.clear()
    else this.enter()
  }

  canAnimate() {
    return this.props.active && !this.props.powerSave && !this.reduced?.matches &&
      !document.hidden && this.inViewport && this.root.current?.clientHeight > 0 &&
      typeof this.root.current.animate === 'function'
  }

  enter() {
    if (this.entered || !this.props.active || document.hidden || !this.inViewport || !this.root.current?.clientHeight) return
    const records = [...this.root.current.querySelectorAll(RECORDS)]
    if (!records.length) return
    this.entered = true
    this.motionStartedAt = document.timeline.currentTime
    if (this.canAnimate()) records.forEach(node => this.appear(node))
  }

  play(node, keyframes, duration, delay = 0, ghost = false, easing = EASING) {
    if (this.plans) { this.plans.push([node, keyframes, duration, delay, ghost, easing]); return }
    const animation = node.animate(keyframes, { duration, delay, easing, fill: 'both' })
    animation.startTime = this.motionStartedAt
    animation.id = 'cd-queue-motion'
    this.animations.add(animation)
    animation.onfinish = () => {
      this.animations.delete(animation)
      animation.cancel()
      if (ghost) { this.ghosts.delete(node); node.remove() }
    }
  }

  appear(node, delay = 0) {
    const slot = Number(node.dataset.queueSlot)
    this.play(node, [
      { opacity: 0, transform: this.props.layout === 'linear' ? 'translateY(6px) scale(0.94)' : `translate(-18px, ${slot * 18 + 6}px) scale(0.94)` },
      { opacity: 1, transform: 'none' },
    ], this.liteMode ? 120 : 260, delay)
  }

  geometry(node, root, style = getComputedStyle(node)) {
    const diameter = parseFloat(style.width) / parseFloat(style.getPropertyValue('--queue-slot-scale'))
    const edgeInset = parseFloat(style.getPropertyValue('--queue-edge-inset')) || 0
    const origin = { x: root.left + diameter * 0.16 - edgeInset, y: root.top + root.height / 2 }
    const x = root.left + parseFloat(style.left) + parseFloat(style.width) / 2
    const y = root.top + parseFloat(style.top) + parseFloat(style.height) / 2
    return { diameter, origin, radius: Math.hypot(x - origin.x, y - origin.y) }
  }

  arc(node, previous, root, endSlot, endWidth, endOpacity = 1, ghost = false, rect = node.getBoundingClientRect()) {
    const start = center(previous.rect)
    const base = center(rect)
    const { origin, radius } = previous.geometry || this.geometry(node, root)
    const startAngle = previous.angle ?? Math.atan2(start.y - origin.y, start.x - origin.x)
    const endAngle = endSlot * Math.PI / 2
    const startRadius = Math.hypot(start.x - origin.x, start.y - origin.y)
    const segments = this.liteMode ? 6 : 32
    const keyframes = Array.from({ length: segments + 1 }, (_, index) => {
      const t = index / segments
      const angle = startAngle + (endAngle - startAngle) * t
      const currentRadius = startRadius + (radius - startRadius) * t
      const x = origin.x + Math.cos(angle) * currentRadius - base.x
      const y = origin.y + Math.sin(angle) * currentRadius - base.y
      const scale = (previous.rect.width + (endWidth - previous.rect.width) * t) / rect.width
      return { offset: t, opacity: previous.opacity + (endOpacity - previous.opacity) * t, transform: `translate(${x}px, ${y}px) scale(${scale})` }
    })
    this.play(node, keyframes, this.liteMode ? SOFTWARE_ROTATE_DURATION : ROTATE_DURATION, 0, ghost, ROTATE_EASING)
  }

  move(node, previous, root, phase) {
    const rect = node.getBoundingClientRect()
    if (!rect.width || !previous.rect.width) return
    const start = center(previous.rect)
    const end = center(rect)
    if (Math.hypot(start.x - end.x, start.y - end.y) < 0.5 && Math.abs(previous.rect.width - rect.width) < 0.5 && previous.opacity > 0.99) return
    const slot = Number(node.dataset.queueSlot)
    const { origin } = previous.geometry
    const angle = unwrap(Math.atan2(start.y - origin.y, start.x - origin.x), slot * Math.PI / 2 + phase)
    this.arc(node, { ...previous, angle }, root, slot, rect.width, 1, false, rect)
  }

  arrive(node, root, phase, source) {
    const rect = node.getBoundingClientRect()
    const geometry = this.geometry(node, root)
    const slot = Number(node.dataset.queueSlot)
    const angle = slot * Math.PI / 2 + phase
    const size = source?.rect.width ?? geometry.diameter * (Math.abs(angle) < 0.001 ? 1 : 0.78)
    const previous = {
      opacity: 0, geometry, angle,
      rect: { left: geometry.origin.x + Math.cos(angle) * geometry.radius - size / 2, top: geometry.origin.y + Math.sin(angle) * geometry.radius - size / 2, width: size, height: size },
    }
    this.arc(node, previous, root, slot, rect.width, 1, false, rect)
  }

  depart(previous, root, movement, phase) {
    const node = previous.ghost
    node.removeAttribute('data-queue-record')
    node.setAttribute('aria-hidden', 'true')
    node.tabIndex = -1
    node.disabled = true
    node.inert = true
    node.classList.add('cd-deck-queue-exit')
    Object.assign(node.style, {
      left: `${previous.rect.left - root.left}px`, top: `${previous.rect.top - root.top}px`,
      width: `${previous.rect.width}px`, height: `${previous.rect.height}px`,
      pointerEvents: 'none',
    })
    node.style.setProperty('--queue-slot-size', `${previous.rect.width}px`)
    const disc = node.querySelector('.hero-disc')
    if (disc) Object.assign(disc.style, { opacity: previous.discOpacity, transform: previous.discTransform, transition: 'none' })
    this.ghosts.add(node)
    this.root.current.append(node)
    if (movement) {
      const slot = previous.slot + movement
      const start = center(previous.rect)
      const { origin } = previous.geometry
      const angle = unwrap(Math.atan2(start.y - origin.y, start.x - origin.x), slot * Math.PI / 2 + phase)
      this.arc(node, { ...previous, angle }, root, slot, previous.geometry.diameter * (slot === 0 ? 1 : 0.78), 0, true)
    } else this.play(node, [{ opacity: previous.opacity }, { opacity: 0 }], this.liteMode ? 140 : 300, 0, true)
  }

  clear() {
    for (const animation of this.animations) { animation.onfinish = null; animation.cancel() }
    this.animations.clear()
    for (const node of this.ghosts) node.remove()
    this.ghosts.clear()
  }

  render() {
    return <div ref={this.root} className="cd-deck-queue" data-cd-queue-position={this.props.position}>{this.props.children}</div>
  }
}
