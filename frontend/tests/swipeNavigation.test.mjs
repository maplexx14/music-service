import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { transform } from 'esbuild'
import { swipeSpring } from '../src/utils/swipeSpring.js'
import { getSwipePhase, setSwipePhase } from '../src/utils/swipeActivity.js'

const source = await readFile(new URL('../src/hooks/useSwipeNavigation.js', import.meta.url), 'utf8')
const { code } = await transform(source, { format: 'cjs', target: 'es2020' })
const script = new vm.Script(code, { filename: 'useSwipeNavigation.js' })
const flushAnimations = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

function mountSwipe({ reduced = false, hasNext = true, hasPrev = false, hasUnder = true, hasPill = false, pointer = false } = {}) {
  const listeners = new Map()
  const timers = new Map()
  const routeCommits = new Set()
  const pans = []
  const navigation = []
  const commits = []
  const operations = []
  const frames = new Map()
  const rootStyles = {}
  const timeline = { currentTime: 0 }
  let now = 0
  let frameId = 0
  let holds = 0
  let timerId = 0
  let capturedPointer = null
  let pillAnimation = null
  const hookRefs = []
  let refIndex = 0
  const effects = {}
  const pendingEffects = { layout: [], passive: [] }
  const runEffect = (phase) => (effect, deps) => {
    const previous = effects[phase]
    if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return
    const next = { deps, cleanup: previous?.cleanup }
    effects[phase] = next
    pendingEffects[phase].push(() => {
      next.cleanup?.()
      next.cleanup = effect()
    })
  }
  const flushEffects = (phase) => pendingEffects[phase].splice(0).forEach((effect) => effect())

  class Element {
    constructor(id) {
      this.id = id
      this.scrollWidth = 390
      this.clientWidth = 390
      this.animations = []
      this.attributes = new Map()
      this.scroller = { style: {}, scrollTop: 240 }
      this.style = new Proxy({}, {
        set: (style, key, value) => {
          operations.push(`style:${id}:${key}`)
          style[key] = value
          return true
        },
      })
    }
    closest() { return null }
    setAttribute(name, value) { this.attributes.set(name, value) }
    removeAttribute(name) { this.attributes.delete(name) }
    hasAttribute(name) { return this.attributes.has(name) }
    querySelector() { return this.scroller }
    animate(frames, options) {
      let resolve
      let reject
      let resolveReady
      let rejectReady
      let startTime = null
      let heldTime = 0
      const finished = new Promise((yes, no) => { resolve = yes; reject = no })
      const ready = new Promise((yes, no) => { resolveReady = yes; rejectReady = no })
      const animation = {
        frames, options, finished, ready, pending: true, cancelled: false, playState: 'running',
        effect: {
          setKeyframes(next) { animation.frames = next },
          updateTiming(next) { animation.options = { ...animation.options, ...next } },
        },
        get startTime() { return startTime },
        set startTime(value) { startTime = value; this.playState = 'running'; this.pending = false; resolveReady() },
        get currentTime() { return this.playState === 'running' && startTime !== null ? timeline.currentTime - startTime : heldTime },
        set currentTime(value) {
          heldTime = value
          // Seeking completes a pending pause synchronously in WAAPI.
          if (this.playState === 'paused' && this.pending) {
            this.pending = false
            resolveReady()
          }
        },
        pause() {
          if (this.playState === 'paused') return
          heldTime = this.currentTime
          startTime = null
          this.playState = 'paused'
          this.pending = true
        },
        play() { this.playState = 'running'; this.pending = true },
        prepare(browserStartTime) {
          if (!this.pending) return
          if (this.playState === 'running') startTime = browserStartTime
          this.pending = false
          resolveReady()
        },
        finish() { if (startTime === null) startTime = timeline.currentTime - this.options.duration; this.pending = false; this.playState = 'finished'; resolveReady(); resolve() },
        cancel() { this.cancelled = true; this.pending = false; this.playState = 'idle'; rejectReady(new Error('Animation cancelled')); reject(new Error('Animation cancelled')) },
      }
      this.animations.push(animation)
      return animation
    }
  }
  const screen = new Element('home')
  const under = new Element('search')
  const next = new Element('liked')
  const pill = new Element('pill')
  let active = screen
  const container = Object.defineProperties(new Element('container'), Object.getOwnPropertyDescriptors({
    get clientWidth() { operations.push('layout:width'); return 390 },
    querySelector(selector) {
      if (selector.includes('data-active')) return active
      if (!hasUnder) return null
      if (selector.includes('tab:/search')) return under
      if (selector.includes('tab:/liked')) return next
      return selector.includes('tab:/"') ? screen : null
    },
    addEventListener(name, callback, options) { listeners.set(name, { callback, options }) },
    removeEventListener(name) { listeners.delete(name) },
    setPointerCapture(id) { capturedPointer = id },
    hasPointerCapture(id) { return capturedPointer === id },
    releasePointerCapture() { capturedPointer = null },
  }))
  screen.parentElement = container
  under.parentElement = container
  next.parentElement = container
  const modules = {
    react: {
      useRef: (current) => hookRefs[refIndex++] ??= { current },
      useEffect: runEffect('passive'), useLayoutEffect: runEffect('layout'),
    },
    '../services/navigation': {
      isIOS: false,
      afterNextRouteCommit(callback) { routeCommits.add(callback); return () => routeCommits.delete(callback) },
      holdHeavyAnimations() { holds += 1; return () => { holds -= 1 } },
      skipNextTransitionAnimation() {},
      swipeNextTransition: () => null,
      finishActiveTransition() {},
    },
    '../utils/haptics': { haptic() {}, HAPTIC: { selection: 1 } },
    '../utils/swipeSpring': { swipeSpring },
    '../utils/swipeActivity': { setSwipePhase },
  }
  const window = new EventTarget()
  Object.assign(window, { innerWidth: 390, matchMedia: () => ({ matches: reduced }), PointerEvent: pointer ? class {} : undefined })
  const document = new EventTarget()
  Object.assign(document, { hidden: false, timeline, documentElement: { classList: { contains: () => false }, style: { setProperty(name, value) { rootStyles[name] = value } } } })
  const hook = { exports: {} }
  script.runInContext(vm.createContext({
    module: hook, exports: hook.exports,
    require(name) { assert.ok(modules[name], `Unexpected import: ${name}`); return modules[name] },
    Element,
    DOMMatrixReadOnly: class { constructor(transform) { this.m41 = Number(/translate3d\(([-\d.]+)px/.exec(transform)?.[1] ?? 0) } },
    getComputedStyle: (element) => ({ transform: element.presentationOffset === undefined ? element.style.transform ?? 'none' : `translate3d(${element.presentationOffset}px, 0, 0)` }),
    window, document, performance: { now: () => now },
    setTimeout(callback, ms) { const id = ++timerId; timers.set(id, { callback, ms }); return id },
    clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame(callback) { const id = ++frameId; frames.set(id, callback); return id },
    cancelAnimationFrame(id) { frames.delete(id) },
  }))
  const containerRef = { current: container }
  const options = {
    enabled: true,
    screenKey: 'home',
    onNext: hasNext ? () => navigation.push('/search') : null,
    onPrev: hasPrev ? () => navigation.push('/previous') : null,
    onPan: (...args) => {
      pans.push(args)
      if (!hasPill) return
      const [x, width, , motion] = args
      const transform = value => `translateX(${value * 100}%)`
      if (!motion?.drag && !motion?.duration) {
        pillAnimation?.cancel()
        pillAnimation = null
      }
      pill.style.transform = x === null ? '' : transform(-x / width)
      if (motion?.drag) {
        pillAnimation = motion.drag(pill, -x / width, 4, transform)
      } else if (motion?.duration) {
        pillAnimation = motion.animate(pill, motion.samples.map(({ value, offset }) => ({ transform: transform(-value / width), offset })))
      }
    },
    onCommit: (direction) => commits.push(direction),
    targets: { left: 'tab:/search', right: hasPrev ? 'tab:/search' : null },
  }
  let cancelRef
  const rerender = (changes = {}, beforeEffects) => {
    Object.assign(options, changes)
    refIndex = 0
    cancelRef = hook.exports.useSwipeNavigation(containerRef, options)
    flushEffects('layout')
    beforeEffects?.()
    flushEffects('passive')
  }
  rerender()
  const paint = (time = timeline.currentTime + 16, { startTime = time, skip = [] } = {}) => {
    now = time
    timeline.currentTime = time
    for (const animation of [screen, under, next, pill].flatMap((element) => element.animations)) {
      if (!skip.includes(animation)) animation.prepare(startTime)
    }
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach((callback) => callback(time))
  }
  return {
    window, document,
    cancel: () => cancelRef.current?.(),
    screen, under, next, pill, container, pans, navigation, commits, operations, timers, routeCommits, listeners, paint, rootStyles, rerender,
    activate(element) { active = element },
    get pendingFrames() { return frames.size },
    get phase() { return getSwipePhase() },
    get holds() { return holds },
    get capturedPointer() { return capturedPointer },
    advanceClock(time) { now = time },
    pointer(name, x, timeStamp, extra = {}) {
      now = timeStamp
      listeners.get(name).callback({ target: screen, pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: x, clientY: 200, timeStamp, ...extra })
      if (extra.paint !== false) paint(timeStamp)
    },
    touch(name, x, y = 200, timeStamp = 0, extra = {}) {
      now = timeStamp
      const point = { clientX: x, clientY: y }
      listeners.get(`touch${name}`).callback({
        target: screen, touches: name === 'end' ? [] : [point], changedTouches: [point], timeStamp, ...extra,
      })
      if (extra.paint !== false) paint(timeStamp)
    },
    commit() { const callbacks = [...routeCommits]; routeCommits.clear(); callbacks.forEach((callback) => callback()) },
    cleanup: () => Object.values(effects).forEach((effect) => effect.cleanup?.()),
  }
}

test('First swipe frame tracks the finger without rebuilding the scroll container or reading layout after writes', () => {
  const app = mountSwipe()
  app.touch('start', 300)
  app.touch('move', 250, 200, 30)
  assert.equal(app.screen.style.transform, 'translate3d(-50px, 0, 0)')
  assert.equal(app.under.style.visibility, 'visible')
  assert.deepEqual(app.screen.scroller.style, {})
  assert.equal(app.screen.scroller.scrollTop, 240)
  assert.equal(app.container.hasAttribute('data-swiping'), true)
  const firstWrite = app.operations.findIndex((operation) => operation.startsWith('style:'))
  assert.ok(firstWrite > 0)
  assert.equal(app.operations.slice(firstWrite).includes('layout:width'), false)
  for (const { options } of app.listeners.values()) assert.equal(options.passive, true)
  app.cleanup()
})

test('Pointer release starts the settle without waiting for a compatible touchend event', async () => {
  const app = mountSwipe({ pointer: true, hasPill: true })
  assert.equal(app.listeners.has('touchend'), false)
  app.pointer('pointerdown', 300, 0)
  app.pointer('pointermove', 250, 25)
  app.pointer('pointermove', 180, 50)
  assert.equal(app.capturedPointer, 1)
  assert.equal(app.phase, 'drag')
  app.pointer('pointerup', 170, 55, { paint: false })
  assert.equal(app.capturedPointer, null)
  assert.equal(app.screen.animations.length, 1)
  assert.equal(app.screen.animations[0].pending, false, 'The prepared effect became pending again on release')
  assert.equal(app.pendingFrames, 0)
  assert.equal(app.phase, 'prepare')
  app.paint(64)
  await flushAnimations()
  assert.equal(app.phase, 'settle')
  app.screen.animations[0].finish()
  app.under.animations[0].finish()
  app.pill.animations[0].finish()
  await flushAnimations()
  assert.deepEqual(app.navigation, ['/search'])
  assert.equal(app.phase, 'commit')
  assert.equal(app.container.hasAttribute('data-swiping'), true, 'Decoration resumed before the screen commit')
  app.commit()
  assert.equal(app.phase, null)
  assert.equal(app.container.hasAttribute('data-swiping'), false)
  app.cleanup()
})

test('Vertical and mouse pointer movement do not capture a horizontal swipe', () => {
  const app = mountSwipe({ pointer: true })
  app.pointer('pointerdown', 300, 0, { pointerType: 'mouse' })
  app.pointer('pointermove', 100, 30, { pointerType: 'mouse' })
  app.pointer('pointerup', 100, 40, { pointerType: 'mouse' })
  app.pointer('pointerdown', 300, 100)
  app.pointer('pointermove', 295, 130, { clientY: 270 })
  app.pointer('pointercancel', 295, 140)
  assert.equal(app.capturedPointer, null)
  assert.deepEqual(app.pans, [])
  assert.equal(app.holds, 0)
  assert.equal(app.container.hasAttribute('data-swiping'), false)
  app.cleanup()
})

test('A second pointer or lost capture returns the dragged screen and releases the pointer', async () => {
  for (const cancellation of ['pointerdown', 'lostpointercapture']) {
    const app = mountSwipe({ pointer: true })
    app.pointer('pointerdown', 300, 0)
    app.pointer('pointermove', 170, 50)
    app.pointer(cancellation, 180, 55, cancellation === 'pointerdown' ? { pointerId: 2, isPrimary: false } : { target: app.container })
    assert.equal(app.capturedPointer, null)
    assert.equal(app.screen.animations[0].frames.at(-1).transform, 'translate3d(0px, 0, 0)')
    app.screen.animations[0].finish()
    app.under.animations[0].finish()
    await flushAnimations()
    assert.deepEqual(app.navigation, [])
    assert.equal(app.holds, 0)
    app.cleanup()
  }
})

test('Moving implicit pointer capture from a touched child to the swipe container keeps the drag alive', () => {
  const app = mountSwipe({ pointer: true })
  app.pointer('pointerdown', 300, 0)
  app.pointer('pointermove', 285, 25)
  app.pointer('lostpointercapture', 280, 30, { target: app.screen })
  app.pointer('pointermove', 200, 55)
  assert.equal(app.screen.style.transform, 'translate3d(-100px, 0, 0)')
  assert.equal(app.screen.animations.at(-1).playState, 'paused')
  assert.equal(app.capturedPointer, 1)
  app.pointer('pointerup', 200, 56)
  assert.equal(app.screen.animations[0].frames.at(-1).transform, 'translate3d(-390px, 0, 0)')
  app.cleanup()
})

for (const interruption of ['visibility', 'pagehide', 'blur', 'resize', 'selection']) {
  test(`${interruption} cancels a drag or settle without stale movement or navigation`, async () => {
    for (const released of [false, true]) {
      const app = mountSwipe({ pointer: true, hasPill: true })
      app.pointer('pointerdown', 300, 0)
      app.pointer('pointermove', 170, 50)
      if (released) app.pointer('pointerup', 170, 55)
      if (interruption === 'visibility') {
        app.document.hidden = true
        app.document.dispatchEvent(new Event('visibilitychange'))
      } else if (interruption === 'selection') app.cancel()
      else {
        if (interruption === 'resize') app.window.innerWidth = 430
        app.window.dispatchEvent(new Event(interruption))
      }
      await flushAnimations()
      assert.equal(app.capturedPointer, null)
      assert.equal(app.pendingFrames, 0)
      assert.equal(app.screen.style.transform, '')
      assert.equal(app.under.style.visibility, '')
      assert.equal(app.pill.style.transform, '')
      assert.equal(app.holds, 0)
      assert.equal(app.container.hasAttribute('data-swiping'), false)
      assert.equal(app.commits.at(-1), null)
      app.paint(100)
      app.commit()
      await flushAnimations()
      assert.deepEqual(app.navigation, [])
      app.cleanup()
    }
  })
}

test('viewport height changes preserve the gesture and returning from background allows a new swipe', async () => {
  const app = mountSwipe({ pointer: true })
  app.pointer('pointerdown', 300, 0)
  app.pointer('pointermove', 170, 50)
  app.window.dispatchEvent(new Event('resize'))
  assert.equal(app.holds, 1)
  assert.equal(app.screen.style.transform, 'translate3d(-130px, 0, 0)')
  app.document.hidden = true
  app.document.dispatchEvent(new Event('visibilitychange'))
  app.document.hidden = false
  app.document.dispatchEvent(new Event('visibilitychange'))
  app.pointer('pointerdown', 300, 100)
  app.pointer('pointermove', 150, 150)
  app.pointer('pointerup', 150, 160)
  app.screen.animations.at(-1).finish()
  app.under.animations.at(-1).finish()
  await flushAnimations()
  assert.deepEqual(app.navigation, ['/search'])
  app.commit()
  assert.equal(app.holds, 0)
  app.cleanup()
})

test('backgrounding during a pending router commit releases the old gesture without discarding the selected route', async () => {
  const app = mountSwipe({ pointer: true })
  app.pointer('pointerdown', 300, 0)
  app.pointer('pointermove', 170, 50)
  app.pointer('pointerup', 170, 55)
  app.screen.animations.at(-1).finish()
  app.under.animations.at(-1).finish()
  await flushAnimations()
  assert.deepEqual(app.navigation, ['/search'])
  app.document.hidden = true
  app.document.dispatchEvent(new Event('visibilitychange'))
  app.activate(app.under)
  app.rerender({ screenKey: 'search' })
  app.commit()
  assert.equal(app.routeCommits.size, 0)
  assert.equal(app.timers.size, 0)
  assert.equal(app.holds, 0)
  assert.equal(app.screen.style.transform, '')
  assert.equal(app.under.style.transform, '')
  assert.deepEqual(app.navigation, ['/search'])
  app.cleanup()
})

test('Choosing another screen during a swipe cancels its stale navigation and releases the layers', async () => {
  for (const released of [false, true]) {
    const app = mountSwipe({ pointer: true, hasPill: true })
    app.pointer('pointerdown', 300, 0)
    app.pointer('pointermove', 170, 50)
    if (released) app.pointer('pointerup', 170, 55)
    app.rerender({ screenKey: 'playlists' })
    assert.equal(app.capturedPointer, null)
    assert.equal(app.holds, 0)
    assert.equal(app.screen.style.transform, '')
    assert.equal(app.under.style.visibility, '')
    assert.equal(app.pendingFrames, 0)
    for (const element of [app.screen, app.under, app.pill]) {
      assert.ok(element.animations.every((animation) => animation.cancelled))
    }
    await flushAnimations()
    assert.deepEqual(app.navigation, [])
    assert.equal(app.routeCommits.size, 0)
    app.cleanup()
  }
})

test('Updating callbacks on the same screen preserves the in-flight swipe', async () => {
  const app = mountSwipe({ pointer: true, hasPill: true })
  app.pointer('pointerdown', 300, 0)
  app.pointer('pointermove', 170, 50)
  app.pointer('pointerup', 170, 55)
  app.rerender({ onCommit() {} })
  assert.equal(app.holds, 1)
  for (const element of [app.screen, app.under, app.pill]) {
    assert.equal(element.animations[0].cancelled, false)
    element.animations[0].finish()
  }
  await flushAnimations()
  assert.deepEqual(app.navigation, ['/search'])
  app.commit()
  app.cleanup()
})

test('A second swipe survives the first route commit and uses the new destination', async () => {
  for (const startAfterCommit of [false, true]) {
    const app = mountSwipe({ pointer: true, hasPill: true })
    app.pointer('pointerdown', 300, 0)
    app.pointer('pointermove', 170, 50)
    app.pointer('pointerup', 170, 55)
    for (const element of [app.screen, app.under, app.pill]) element.animations[0].finish()
    await flushAnimations()
    assert.deepEqual(app.navigation, ['/search'])
    const startNext = () => {
      app.pointer('pointerdown', 300, 400, { pointerId: 2 })
      app.pointer('pointermove', 260, 416, { pointerId: 2 })
    }
    if (!startAfterCommit) startNext()
    app.rerender({ screenKey: 'search', onNext: () => app.navigation.push('/liked') }, () => {
      app.commit()
      if (startAfterCommit) startNext()
    })
    app.pointer('pointermove', 170, 448, { pointerId: 2 })
    assert.equal(app.screen.style.transform, 'translate3d(-130px, 0, 0)', 'Route commit lost the second contact')
    app.pointer('pointerup', 170, 450, { pointerId: 2 })
    for (const element of [app.screen, app.under, app.pill]) element.animations.at(-1).finish()
    await flushAnimations()
    assert.deepEqual(app.navigation, ['/search', '/liked'])
    app.commit()
    app.cleanup()
  }
})

test('A short second flick released before the route commit is replayed from the new screen', async () => {
  const app = mountSwipe({ pointer: true, hasPill: true })
  app.pointer('pointerdown', 300, 0)
  app.pointer('pointermove', 170, 50)
  app.pointer('pointerup', 170, 55)
  for (const element of [app.screen, app.under, app.pill]) element.animations[0].finish()
  await flushAnimations()
  app.pointer('pointerdown', 300, 400, { pointerId: 2 })
  app.pointer('pointermove', 240, 425, { pointerId: 2 })
  app.pointer('pointerup', 220, 435, { pointerId: 2 })
  app.rerender({ screenKey: 'search', onNext: () => app.navigation.push('/liked') })
  app.commit()
  assert.equal(app.screen.animations.length, 2, 'A completed flick was discarded while waiting for the router')
  assert.equal(app.screen.animations[1].frames[0].transform, 'translate3d(0px, 0, 0)')
  for (const element of [app.screen, app.under, app.pill]) element.animations[1].finish()
  await flushAnimations()
  assert.deepEqual(app.navigation, ['/search', '/liked'])
  app.commit()
  app.cleanup()
})

test('Cancelling the next contact during a route commit does not replay its movement', async () => {
  const app = mountSwipe({ pointer: true })
  app.pointer('pointerdown', 300, 0)
  app.pointer('pointermove', 170, 50)
  app.pointer('pointerup', 170, 55)
  app.screen.animations[0].finish()
  app.under.animations[0].finish()
  await flushAnimations()
  app.pointer('pointerdown', 300, 400, { pointerId: 2 })
  app.pointer('pointermove', 240, 425, { pointerId: 2 })
  app.pointer('pointercancel', 240, 435, { pointerId: 2 })
  app.rerender({ screenKey: 'search' })
  app.commit()
  assert.equal(app.screen.animations.length, 1)
  assert.equal(app.holds, 0)
  assert.deepEqual(app.navigation, ['/search'])
  app.cleanup()
})

test('A matching flick on the revealed destination advances another tab without snapping either screen', async () => {
  const app = mountSwipe({ pointer: true, hasPill: true })
  app.pointer('pointerdown', 300, 0)
  app.pointer('pointermove', 170, 50)
  app.pointer('pointerup', 170, 55)
  app.screen.presentationOffset = -330
  app.pointer('pointerdown', 300, 150, { pointerId: 2, target: app.container })
  app.pointer('pointermove', 280, 166, { pointerId: 2, target: app.container })
  assert.deepEqual(app.navigation, ['/search'])
  assert.equal(app.screen.style.transform, 'translate3d(-330px, 0, 0)')
  assert.equal(app.under.style.transform, 'translate3d(60px, 0, 0)', 'Starting the next swipe snapped the entering screen to its target')
  assert.equal(app.holds, 1)
  app.activate(app.under)
  app.rerender({
    screenKey: 'search', onPrev: () => app.navigation.push('/'), onNext: () => app.navigation.push('/liked'),
    targets: { right: 'tab:/', left: 'tab:/liked' },
  })
  app.commit()
  app.paint(180)
  assert.equal(app.under.style.transform, 'translate3d(40px, 0, 0)')
  assert.equal(app.screen.style.transform, 'translate3d(-350px, 0, 0)')
  assert.equal(app.holds, 1)
  app.pointer('pointermove', 160, 198, { pointerId: 2, target: app.container })
  assert.equal(app.under.style.transform, 'translate3d(-80px, 0, 0)')
  assert.equal(app.next.style.transform, 'translate3d(310px, 0, 0)')
  app.pointer('pointerup', 160, 200, { pointerId: 2, target: app.container })
  for (const element of [app.under, app.next, app.pill]) element.animations.at(-1).finish()
  await flushAnimations()
  assert.deepEqual(app.navigation, ['/search', '/liked'])
  app.commit()
  app.cleanup()
})

test('A followup released during handoff keeps all three screens aligned across the origin', async () => {
  for (const offset of [-330, -180]) {
    const app = mountSwipe({ pointer: true, hasPill: true })
    app.pointer('pointerdown', 300, 0)
    app.pointer('pointermove', 170, 50)
    app.pointer('pointerup', 170, 55)
    app.screen.presentationOffset = offset
    app.pointer('pointerdown', 300, 150, { pointerId: 2, target: app.container })
    app.pointer('pointermove', 280, 166, { pointerId: 2, target: app.container })
    app.pointer('pointermove', 150, 198, { pointerId: 2, target: app.container })
    app.pointer('pointerup', 150, 200, { pointerId: 2, target: app.container })
    app.activate(app.under)
    app.rerender({
      screenKey: 'search', onPrev: () => app.navigation.push('/'), onNext: () => app.navigation.push('/liked'),
      targets: { right: 'tab:/', left: 'tab:/liked' },
    })
    app.commit()
    const moving = app.under.animations.at(-1)
    assert.equal(moving.frames[0].transform, `translate3d(${390 + offset}px, 0, 0)`)
    assert.equal(moving.frames.at(-1).transform, 'translate3d(-390px, 0, 0)')
    for (const [element, shift] of [[app.screen, -390], [app.next, 390]]) {
      const frames = element.animations.at(-1).frames
      assert.equal(frames.length, moving.frames.length)
      for (let i = 0; i < frames.length; i++) {
        const value = (frame) => Number(/translate3d\(([-\d.]+)px/.exec(frame.transform)[1])
        assert.ok(Math.abs(value(frames[i]) - value(moving.frames[i]) - shift) < 0.001)
      }
    }
    for (const element of [app.screen, app.under, app.next, app.pill]) element.animations.at(-1).finish()
    await flushAnimations()
    assert.deepEqual(app.navigation, ['/search', '/liked'])
    app.commit()
    assert.equal(app.screen.style.visibility, '')
    assert.equal(app.holds, 0)
    app.cleanup()
  }
})

test('Reversing a later swipe cannot inherit an earlier contact\'s handoff direction or expose an empty tab', async () => {
  for (const dir of [-1, 1]) {
    const app = mountSwipe({ pointer: true, hasPill: true })
    const first = dir < 0 ? app.screen : app.next
    const last = dir < 0 ? app.next : app.screen
    if (dir > 0) {
      app.activate(first)
      app.rerender({
        screenKey: 'liked', onPrev: () => app.navigation.push('/search'), onNext: null,
        targets: { right: 'tab:/search', left: null },
      })
    }
    const start = dir < 0 ? 300 : 80
    app.pointer('pointerdown', start, 0, { target: first })
    app.pointer('pointermove', start + dir * 130, 50, { target: first })
    app.pointer('pointerup', start + dir * 130, 55, { target: first })
    first.presentationOffset = dir * 330
    app.pointer('pointerdown', start, 150, { pointerId: 2, target: app.container })
    app.pointer('pointermove', start + dir * 20, 166, { pointerId: 2, target: app.container })
    app.activate(app.under)
    app.rerender({
      screenKey: 'search', onPrev: () => app.navigation.push('/'), onNext: () => app.navigation.push('/liked'),
      targets: { right: 'tab:/', left: 'tab:/liked' },
    })
    app.commit()
    app.paint(180)
    app.pointer('pointermove', start + dir * 140, 198, { pointerId: 2, target: app.container })
    app.pointer('pointerup', start + dir * 140, 200, { pointerId: 2, target: app.container })

    // A third contact grabs the incoming tab but moves back toward Search.
    // It has not handed off to another route: the old handoff belongs to finger 2.
    app.under.presentationOffset = dir * 330
    const reverseStart = dir < 0 ? 80 : 300
    app.pointer('pointerdown', reverseStart, 280, { pointerId: 3, target: app.container })
    app.pointer('pointermove', reverseStart - dir * 60, 305, { pointerId: 3, target: app.container })
    app.pointer('pointermove', reverseStart - dir * 130, 330, { pointerId: 3, target: app.container })
    app.pointer('pointerup', reverseStart - dir * 130, 335, { pointerId: 3, target: app.container })

    const returning = app.under.animations.at(-1)
    assert.equal(returning.frames[0].transform, `translate3d(${dir * 200}px, 0, 0)`)
    assert.equal(returning.frames.at(-1).transform, 'translate3d(0px, 0, 0)', 'A reversed contact navigated past Search with the wrong neighbor visible')
    assert.equal(last.animations.at(-1).frames.at(-1).transform, `translate3d(${-dir * 390}px, 0, 0)`)
    for (const element of [app.under, last, app.pill]) element.animations.at(-1).finish()
    await flushAnimations()
    assert.deepEqual(app.navigation, ['/search'])
    assert.equal(app.commits.at(-1), null)
    assert.equal(app.holds, 0)
    app.cleanup()
  }
})

test('Cancelling a contact during handoff settles the incoming tab instead of leaving it frozen', async () => {
  const app = mountSwipe({ pointer: true })
  app.pointer('pointerdown', 300, 0)
  app.pointer('pointermove', 170, 50)
  app.pointer('pointerup', 170, 55)
  app.screen.presentationOffset = -330
  app.pointer('pointerdown', 300, 150, { pointerId: 2, target: app.container })
  app.pointer('pointermove', 280, 166, { pointerId: 2, target: app.container })
  app.pointer('pointercancel', 280, 170, { pointerId: 2 })
  app.activate(app.under)
  app.rerender({ screenKey: 'search' })
  app.commit()
  assert.equal(app.under.animations.at(-1).frames[0].transform, 'translate3d(60px, 0, 0)')
  assert.equal(app.under.animations.at(-1).frames.at(-1).transform, 'translate3d(0px, 0, 0)')
  app.under.animations.at(-1).finish()
  app.screen.animations.at(-1).finish()
  await flushAnimations()
  assert.deepEqual(app.navigation, ['/search'])
  assert.equal(app.holds, 0)
  app.cleanup()
})

test('Touch movements between display frames update the screens and indicator together only once', () => {
  const app = mountSwipe()
  app.touch('start', 300, 200, 0)
  app.touch('move', 280, 200, 16, { paint: false })
  app.touch('move', 260, 200, 20, { paint: false })
  app.touch('move', 240, 200, 24, { paint: false })
  assert.equal(app.pendingFrames, 1)
  assert.equal(app.screen.style.transform, undefined)
  assert.deepEqual(app.pans, [])
  app.paint(32)
  assert.equal(app.screen.style.transform, 'translate3d(-60px, 0, 0)')
  assert.equal(app.under.style.transform, 'translate3d(330px, 0, 0)')
  assert.equal(app.pans.length, 1)
  assert.equal(app.pans[0][0], -60)
  assert.equal(app.pendingFrames, 0, 'Dragging started a continuous animation loop')
  app.cleanup()
})

test('Release discards unpainted movements and hands the last visible velocity to all settle animations', async () => {
  const app = mountSwipe({ hasPill: true })
  app.touch('start', 300, 200, 0)
  app.touch('move', 280, 200, 16)
  app.touch('move', 240, 200, 24, { paint: false })
  app.touch('move', 180, 200, 30, { paint: false })
  app.touch('end', 180, 200, 31, { paint: false })
  assert.equal(app.screen.style.transform, 'translate3d(-20px, 0, 0)')
  const exit = app.screen.animations[0]
  const enter = app.under.animations[0]
  assert.equal(exit.frames[0].transform, 'translate3d(-20px, 0, 0)')
  assert.equal(enter.frames[0].transform, 'translate3d(370px, 0, 0)')
  const motion = app.pans.at(-1)[3]
  const expected = swipeSpring(-20, -390, -20 / 16)
  assert.equal(motion.samples[1].value, expected.samples[1].value,
    'Unpainted input accelerated the screen at release')
  assert.equal(app.pendingFrames, 0, 'The queued drag frame survived release')
  app.paint(100)
  assert.equal(app.screen.style.transform, 'translate3d(-20px, 0, 0)')
  exit.finish()
  enter.finish()
  app.pill.animations[0].finish()
  await flushAnimations()
  assert.deepEqual(app.navigation, ['/search'])
  app.commit()
  assert.equal(app.holds, 0)
  app.cleanup()
})

test('A tab commit or return reuses the prepared screen and indicator effects from their last displayed positions', async () => {
  for (const [distance, releasedAt, committed] of [[100, 42, true], [30, 200, false]]) {
    const app = mountSwipe({ hasPill: true })
    app.touch('start', 300, 200, 0)
    app.touch('move', 300 - distance, 200, 40)
    app.paint(41)
    const exit = app.screen.animations[0]
    const enter = app.under.animations[0]
    const pill = app.pill.animations[0]
    assert.equal(exit.playState, 'paused')
    assert.equal(enter.playState, 'paused')
    assert.equal(pill.playState, 'paused')
    const outgoing = app.screen.style.transform
    const incoming = app.under.style.transform
    const indicator = app.pill.style.transform
    app.touch('end', 300 - distance, 200, releasedAt, { paint: false })
    assert.equal(app.screen.animations.length, 1, 'Release allocated another outgoing screen animation')
    assert.equal(app.under.animations.length, 1, 'Release allocated another incoming screen animation')
    assert.equal(app.pill.animations.length, 1, 'Release allocated another indicator animation')
    assert.equal(exit.cancelled, false)
    assert.equal(enter.cancelled, false)
    assert.equal(pill.cancelled, false)
    assert.equal(exit.currentTime, 0)
    assert.equal(enter.currentTime, 0)
    assert.equal(pill.currentTime, 0)
    assert.equal(exit.frames[0].transform, outgoing)
    assert.equal(enter.frames[0].transform, incoming)
    assert.equal(pill.frames[0].transform, indicator)
    assert.ok(exit.options.duration < 450)
    await flushAnimations()
    assert.equal(exit.playState, 'running')
    assert.equal(pill.playState, 'running', 'The prepared indicator delayed playback until another display frame')
    assert.deepEqual(app.navigation, [])
    exit.finish()
    enter.finish()
    await flushAnimations()
    assert.deepEqual(app.navigation, [], 'Route changed before the indicator finished')
    pill.finish()
    await flushAnimations()
    assert.deepEqual(app.navigation, committed ? ['/search'] : [])
    if (committed) app.commit()
    assert.equal(app.holds, 0)
    assert.ok([exit, enter, pill].every(animation => animation.cancelled), 'A prepared effect survived gesture cleanup')
    app.cleanup()
  }
})

test('A flick completed before its first display frame reveals the cached destination and animates from rest', async () => {
  const app = mountSwipe()
  app.touch('start', 300, 200, 0)
  app.touch('move', 250, 200, 20, { paint: false })
  app.touch('end', 200, 200, 30, { paint: false })
  assert.deepEqual(app.navigation, [], 'A queued swipe fell back to immediate route replacement')
  assert.equal(app.screen.animations[0].frames[0].transform, 'translate3d(0px, 0, 0)')
  assert.equal(app.under.animations[0].frames[0].transform, 'translate3d(390px, 0, 0)')
  assert.equal(app.under.style.visibility, 'visible')
  app.paint(40)
  app.screen.animations[0].finish()
  app.under.animations[0].finish()
  await flushAnimations()
  assert.deepEqual(app.navigation, ['/search'])
  app.commit()
  app.cleanup()
})

test('Unmount before a queued drag frame removes its writes and releases the animation hold', () => {
  const app = mountSwipe()
  app.touch('start', 300, 200, 0)
  app.touch('move', 200, 200, 20, { paint: false })
  assert.equal(app.pendingFrames, 1)
  app.cleanup()
  assert.equal(app.pendingFrames, 0)
  app.paint(40)
  assert.equal(app.screen.style.transform, '')
  assert.deepEqual(app.navigation, [])
  assert.equal(app.holds, 0)
})

test('A fast swipe starts from its release position and navigates when both screens finish, without a settle timer', async () => {
  const app = mountSwipe()
  app.touch('start', 300)
  app.touch('move', 200, 200, 40)
  app.touch('end', 200, 200, 41)
  const exit = app.screen.animations[0]
  const enter = app.under.animations[0]
  assert.equal(exit.frames[0].transform, 'translate3d(-100px, 0, 0)')
  assert.equal(exit.frames.at(-1).transform, 'translate3d(-390px, 0, 0)')
  assert.equal(enter.frames[0].transform, 'translate3d(290px, 0, 0)')
  assert.equal(enter.frames.at(-1).transform, 'translate3d(0px, 0, 0)')
  assert.deepEqual(exit.options, enter.options)
  assert.equal(exit.options.easing, 'linear')
  const motion = app.pans.at(-1)[3]
  assert.deepEqual(motion.samples.map(({ offset }) => offset), exit.frames.map(({ offset }) => offset))
  for (let index = 0; index < exit.frames.length; index += 1) {
    const outgoing = motion.samples[index].value
    const incoming = Number(enter.frames[index].transform.match(/translate3d\(([-\d.]+)/)[1])
    assert.ok(Math.abs(incoming - outgoing - 390) < 0.0001, 'Tab screens drifted apart')
  }
  assert.equal(app.timers.size, 0)
  assert.equal(app.holds, 1)
  exit.finish()
  await flushAnimations()
  assert.deepEqual(app.navigation, [])
  enter.finish()
  await flushAnimations()
  assert.deepEqual(app.navigation, ['/search'])
  app.commit()
  assert.equal(app.holds, 0)
  assert.equal(app.screen.style.transform, '')
  assert.equal(app.under.style.visibility, '')
  assert.equal(app.timers.size, 0)
  app.cleanup()
})

test('A cancelled short swipe restores the screen and indicator when the return animation finishes', async () => {
  const app = mountSwipe()
  app.touch('start', 300)
  app.touch('move', 270, 200, 200)
  app.touch('end', 270, 200, 300)
  assert.equal(app.screen.animations[0].frames[0].transform, 'translate3d(-30px, 0, 0)')
  assert.equal(app.timers.size, 0)
  app.screen.animations[0].finish()
  app.under.animations[0].finish()
  await flushAnimations()
  assert.deepEqual(app.navigation, [])
  assert.equal(app.screen.style.transform, '')
  assert.deepEqual(app.pans.at(-1), [null])
  assert.equal(app.holds, 0)
  app.cleanup()
})

test('Regrabbing a returning screen starts from its visible position and cancels stale completion', async () => {
  const app = mountSwipe()
  app.touch('start', 300)
  app.touch('move', 270, 200, 200)
  app.touch('end', 270, 200, 300)
  const returning = app.screen.animations[0]
  app.screen.presentationOffset = -18
  app.touch('start', 260, 200, 350)
  app.touch('move', 240, 200, 370)
  await flushAnimations()
  assert.equal(returning.cancelled, true)
  assert.equal(app.screen.style.transform, 'translate3d(-38px, 0, 0)')
  assert.equal(app.holds, 1)
  assert.deepEqual(app.navigation, [])
  app.cleanup()
})

test('Touch-down holds a returning screen and its indicator before the next direction is known', async () => {
  const app = mountSwipe({ hasPill: true })
  app.touch('start', 300)
  app.touch('move', 270, 200, 200)
  app.touch('end', 270, 200, 300)
  const returning = [app.screen, app.under, app.pill].map((element) => element.animations[0])
  app.screen.presentationOffset = -18

  app.touch('start', 260, 200, 350)
  assert.ok(returning.every((animation) => animation.cancelled), 'All moving layers must stop on contact')
  assert.equal(app.screen.style.transform, 'translate3d(-18px, 0, 0)')
  assert.equal(app.under.style.transform, 'translate3d(372px, 0, 0)')
  assert.equal(app.pans.at(-1)[0], -18)
  await flushAnimations()
  app.paint(400)
  assert.equal(app.screen.style.transform, 'translate3d(-18px, 0, 0)')
  assert.equal(app.holds, 1)
  assert.deepEqual(app.navigation, [])
  app.cleanup()
})

test('A tap, vertical gesture or cancellation resumes a grabbed return without changing tabs', async () => {
  for (const end of ['end', 'cancel', 'vertical']) {
    const app = mountSwipe()
    app.touch('start', 300)
    app.touch('move', 270, 200, 200)
    app.touch('end', 270, 200, 300)
    app.screen.presentationOffset = -18
    app.touch('start', 260, 200, 350)
    if (end === 'vertical') {
      app.touch('move', 260, 230, 370)
      app.touch('end', 260, 230, 400)
      assert.equal(app.screen.animations.length, 2, 'Ending a vertical gesture must not restart its resumed return')
    } else app.touch(end, 260, 200, 370)
    assert.equal(app.screen.animations[1]?.frames[0].transform, 'translate3d(-18px, 0, 0)')
    assert.equal(app.screen.animations[1].frames.at(-1).transform, 'translate3d(0px, 0, 0)')
    app.screen.animations[1].finish()
    app.under.animations[1].finish()
    await flushAnimations()
    assert.equal(app.screen.style.transform, '')
    assert.equal(app.holds, 0)
    assert.deepEqual(app.navigation, [])
    app.cleanup()
  }
})

test('Regrabbing a return holds its visible position until the continued drag frame is painted', () => {
  const app = mountSwipe()
  app.touch('start', 300, 200, 0)
  app.touch('move', 270, 200, 200)
  app.touch('end', 270, 200, 300)
  app.screen.presentationOffset = -18
  app.touch('start', 260, 200, 350)
  app.touch('move', 240, 200, 370, { paint: false })
  assert.equal(app.screen.style.transform, 'translate3d(-18px, 0, 0)',
    'Cancelling the return exposed its old inline position')
  app.paint(370)
  assert.equal(app.screen.style.transform, 'translate3d(-38px, 0, 0)')
  app.touch('end', 240, 200, 371)
  const expected = swipeSpring(-38, -390, -20 / 20)
  assert.equal(app.pans.at(-1)[3].samples[1].value, expected.samples[1].value,
    'Continued motion was measured from the old return target')
  app.cleanup()
})

test('Reduced motion commits immediately without waiting for an invisible animation', () => {
  const app = mountSwipe({ reduced: true, hasPill: true })
  app.touch('start', 300)
  app.touch('move', 170, 200, 50)
  app.touch('end', 170, 200, 51)
  assert.deepEqual(app.navigation, ['/search'])
  assert.equal(app.screen.animations.length, 0)
  assert.equal(app.under.animations.length, 0)
  assert.equal(app.pill.animations.length, 0)
  app.commit()
  assert.equal(app.timers.size, 0)
  assert.equal(app.holds, 0)
  app.cleanup()
})

test('Vertical scrolling does not start a screen transition', () => {
  const app = mountSwipe()
  app.touch('start', 300)
  app.touch('move', 290, 260, 30)
  app.touch('end', 290, 260, 31)
  assert.deepEqual(app.screen.scroller.style, {})
  assert.equal(app.screen.animations.length, 0)
  assert.equal(app.holds, 0)
  assert.deepEqual(app.pans, [])
  app.cleanup()
})

test('Swiping past the last tab resists and returns without navigation', async () => {
  const app = mountSwipe({ hasNext: false })
  app.touch('start', 300)
  app.touch('move', 150, 200, 30)
  assert.equal(app.screen.style.transform, 'translate3d(-30px, 0, 0)')
  app.touch('end', 150, 200, 31)
  app.screen.animations[0].finish()
  await flushAnimations()
  assert.deepEqual(app.navigation, [])
  assert.equal(app.holds, 0)
  app.cleanup()
})

test('Regrabbing at a tab boundary preserves the visible offset and its resistance', async () => {
  const app = mountSwipe({ hasNext: false })
  app.touch('start', 300)
  app.touch('move', 150, 200, 30)
  app.touch('end', 150, 200, 31)
  app.screen.presentationOffset = -18
  app.touch('start', 260, 200, 100)
  app.touch('move', 240, 200, 120)
  await flushAnimations()
  assert.equal(app.screen.style.transform, 'translate3d(-22px, 0, 0)')
  app.cleanup()
})

test('System touch cancellation returns the screen without committing a tab', async () => {
  const app = mountSwipe()
  app.touch('start', 300)
  app.touch('move', 160, 200, 30)
  app.touch('cancel', 160, 200, 31)
  app.screen.animations[0].finish()
  app.under.animations[0].finish()
  await flushAnimations()
  assert.deepEqual(app.navigation, [])
  assert.equal(app.holds, 0)
  app.cleanup()
})

test('Unmount cancels animations and prevents delayed navigation', async () => {
  const app = mountSwipe()
  app.touch('start', 300)
  app.touch('move', 200, 200, 40)
  app.touch('end', 200, 200, 41)
  app.cleanup()
  await flushAnimations()
  assert.ok(app.screen.animations.every((animation) => animation.cancelled))
  assert.ok(app.under.animations.every((animation) => animation.cancelled))
  assert.deepEqual(app.navigation, [])
  assert.equal(app.holds, 0)
  assert.equal(app.timers.size, 0)
  assert.equal(app.listeners.size, 0)
})

test('Unmount during router commit removes the route callback and its fallback', async () => {
  const app = mountSwipe()
  app.touch('start', 300)
  app.touch('move', 200, 200, 40)
  app.touch('end', 200, 200, 41)
  app.screen.animations[0].finish()
  app.under.animations[0].finish()
  await flushAnimations()
  assert.equal(app.routeCommits.size, 1)
  app.cleanup()
  assert.equal(app.routeCommits.size, 0)
  assert.equal(app.timers.size, 0)
  assert.equal(app.holds, 0)
})

test('A cold destination fallback is cleaned up when the swipe hook unmounts', async () => {
  const app = mountSwipe({ hasUnder: false })
  app.touch('start', 300)
  app.touch('move', 200, 200, 40)
  app.touch('end', 200, 200, 41)
  assert.deepEqual(app.navigation, ['/search'])
  assert.equal(app.routeCommits.size, 1)
  app.cleanup()
  await flushAnimations()
  assert.equal(app.routeCommits.size, 0)
  assert.equal(app.timers.size, 0)
  assert.equal(app.holds, 0)
})

test('An undelivered final movement selects the destination without jumping the rendered screen', () => {
  const app = mountSwipe()
  app.touch('start', 300, 200, 0)
  app.touch('move', 230, 200, 500)
  app.touch('end', 195, 200, 1000)
  assert.equal(app.screen.animations[0].frames[0].transform, 'translate3d(-70px, 0, 0)')
  assert.equal(app.screen.animations[0].frames.at(-1).transform, 'translate3d(-390px, 0, 0)')
  app.cleanup()
})

test('A cold destination snapshot continues from the last displayed position instead of queued input', () => {
  const app = mountSwipe({ hasUnder: false })
  app.touch('start', 300, 200, 0)
  app.touch('move', 280, 200, 16)
  app.touch('move', 240, 200, 24, { paint: false })
  app.touch('end', 180, 200, 31, { paint: false })
  assert.equal(app.rootStyles['--swipe-from'], '-20px')
  assert.equal(app.pendingFrames, 0)
  app.cleanup()
  assert.equal(app.pendingFrames, 0)
})

test('A fast release with missing touchmove events continues from the last rendered position', () => {
  const app = mountSwipe()
  app.touch('start', 375, 200, 0)
  app.touch('move', 328, 200, 33)
  app.touch('move', 261, 200, 66)
  app.touch('move', 209, 200, 99)
  app.touch('end', 114, 200, 130)
  const frames = app.screen.animations[0].frames
  assert.equal(app.screen.style.transform, 'translate3d(-166px, 0, 0)')
  assert.equal(frames[0].transform, 'translate3d(-166px, 0, 0)')
  assert.equal(app.under.animations[0].frames[0].transform, 'translate3d(224px, 0, 0)')
  assert.equal(frames.at(-1).transform, 'translate3d(-390px, 0, 0)')
  app.cleanup()
})

test('An undelivered release cannot accelerate the animation beyond the last displayed movement', () => {
  for (const direction of [-1, 1]) {
    const app = mountSwipe({ hasPrev: true })
    const start = direction < 0 ? 375 : 15
    app.touch('start', start, 200, 0)
    app.touch('move', start + direction * 47, 200, 33)
    app.touch('move', start + direction * 114, 200, 66)
    app.touch('move', start + direction * 166, 200, 99)
    app.touch('end', start + direction * 261, 200, 130)
    const motion = app.pans.at(-1)[3]
    const expected = swipeSpring(direction * 166, direction * 390, direction * 52 / 33)
    assert.equal(motion.samples[1].value, expected.samples[1].value,
      'The release endpoint introduced a velocity jump in the first animation frame')
    assert.equal(motion.samples.at(-1).value, direction * 390)
    app.cleanup()
  }
})

test('An undelivered short flick still commits using release intent without adding its unseen speed', () => {
  const app = mountSwipe()
  app.touch('start', 300, 200, 0)
  app.touch('move', 275, 200, 500)
  app.touch('end', 245, 200, 510)
  const motion = app.pans.at(-1)[3]
  const expected = swipeSpring(-25, -390, -25 / 500)
  assert.equal(motion.samples.at(-1).value, -390, 'The release-only flick was lost')
  assert.equal(motion.samples[1].value, expected.samples[1].value)
  app.cleanup()
})

test('An undelivered movement after a pause commits without reusing stale screen velocity', () => {
  const app = mountSwipe()
  app.touch('start', 300, 200, 0)
  app.touch('move', 230, 200, 30)
  app.touch('end', 195, 200, 130)
  const motion = app.pans.at(-1)[3]
  const expected = swipeSpring(-70, -390, 0)
  assert.equal(motion.samples.at(-1).value, -390)
  assert.equal(motion.samples[1].value, expected.samples[1].value)
  app.cleanup()
})

test('An undelivered release crossing the origin returns instead of replacing the revealed destination', () => {
  const app = mountSwipe({ hasPrev: true })
  app.touch('start', 200, 200, 0)
  app.touch('move', 130, 200, 500)
  app.touch('end', 310, 200, 1500)
  assert.equal(app.screen.animations[0].frames[0].transform, 'translate3d(-70px, 0, 0)')
  assert.equal(app.screen.animations[0].frames.at(-1).transform, 'translate3d(0px, 0, 0)')
  assert.deepEqual(app.commits, [null])
  app.cleanup()
})

test('Starting a settle keeps the live styles at the release position while compositor animations are pending', async () => {
  const app = mountSwipe()
  app.touch('start', 300, 200, 0)
  app.touch('move', 200, 200, 40)
  app.touch('end', 200, 200, 41)
  assert.equal(app.screen.style.transform, 'translate3d(-100px, 0, 0)')
  assert.equal(app.under.style.transform, 'translate3d(290px, 0, 0)')
  assert.equal(app.screen.animations[0].options.fill, 'both')
  app.screen.animations[0].finish()
  app.under.animations[0].finish()
  await flushAnimations()
  assert.equal(app.screen.style.transform, 'translate3d(-390px, 0, 0)')
  app.commit()
  app.cleanup()
})

test('A fast release between display frames starts at the handoff time instead of skipping unseen motion', async () => {
  for (const releaseDelay of [4, 16, 32]) {
    const app = mountSwipe({ hasPill: true, pointer: true })
    app.pointer('pointerdown', 310, 0)
    app.pointer('pointermove', 270, 16)
    app.pointer('pointermove', 190, 32)
    app.pointer('pointerup', 190, 32 + releaseDelay, { paint: false })
    await flushAnimations()
    const animations = [app.screen, app.under, app.pill].map(element => element.animations[0])
    assert.ok(animations.every(animation => animation.startTime === 32 + releaseDelay),
      'The settle was backdated to the drag frame before the finger was released')
    app.paint(32 + releaseDelay + 8)
    assert.ok(animations.every(animation => animation.currentTime === 8),
      'The first visible settle frame skipped the time between the last drag frame and release')
    app.cleanup()
  }
})

test('A delayed ready callback cannot backdate playback to a stale document timeline', async () => {
  const app = mountSwipe({ hasPill: true })
  app.touch('start', 310, 200, 0)
  app.touch('move', 190, 200, 32)
  app.touch('end', 190, 200, 40, { paint: false })
  // The prepared effects are ready, but other work delays the microtask.
  // No display frame has advanced the document timeline during that work.
  app.advanceClock(80)
  await flushAnimations()
  const animations = [app.screen, app.under, app.pill].map(element => element.animations[0])
  assert.ok(animations.every(animation => animation.startTime === 80))
  app.paint(88)
  assert.ok(animations.every(animation => animation.currentTime === 8))
  app.cleanup()
})

test('Screens and indicator start at time zero even when WebKit supplies an old playback start time', async () => {
  const app = mountSwipe({ hasPill: true })
  app.touch('start', 300, 200, 0)
  // A flick released before its first frame has no prepared drag effects.
  app.touch('move', 200, 200, 40, { paint: false })
  app.touch('end', 200, 200, 41, { paint: false })
  const animations = [app.screen.animations[0], app.under.animations[0], app.pill.animations[0]]
  for (const animation of animations) {
    assert.equal(animation.pending, true)
    assert.equal(animation.currentTime, 0)
  }
  assert.equal(app.pendingFrames, 0)
  // WebKit can deliver ready at 140 ms with a start time from release at 41 ms.
  // That preparation delay must not become 99 ms of unseen spring movement.
  app.paint(140, { startTime: 41 })
  await flushAnimations()
  for (const animation of animations) {
    assert.equal(animation.playState, 'running')
    assert.equal(animation.startTime, 140)
    assert.equal(animation.currentTime, 0)
  }
  assert.equal(app.pendingFrames, 0, 'Starting a swipe introduced a continuous frame loop')
  app.paint(156)
  assert.ok(animations.every((animation) => animation.currentTime === 16))
  app.cleanup()
})

test('A late compositor layer holds both screens and the indicator at release until all can start together', async () => {
  const app = mountSwipe({ hasPill: true })
  app.touch('start', 300, 200, 0)
  app.touch('move', 200, 200, 40, { paint: false })
  app.touch('end', 200, 200, 41, { paint: false })
  const exit = app.screen.animations[0]
  const enter = app.under.animations[0]
  const pill = app.pill.animations[0]
  app.paint(50, { skip: [enter] })
  await flushAnimations()
  assert.equal(app.phase, 'prepare')
  assert.equal(enter.startTime, null)
  app.paint(75, { skip: [enter] })
  assert.equal(exit.currentTime, 0, 'The outgoing screen moved before the incoming screen was ready')
  assert.equal(pill.currentTime, 0, 'The indicator moved before both screens were ready')
  app.paint(90, { startTime: 41 })
  await flushAnimations()
  assert.equal(exit.startTime, 90)
  assert.equal(pill.startTime, 90)
  assert.equal(enter.startTime, 90)
  assert.equal(exit.currentTime, 0)
  assert.equal(enter.currentTime, 0)
  assert.equal(pill.currentTime, 0)
  app.cleanup()
})

test('A slow release accelerates gently across the first two display frames', () => {
  for (const direction of [-1, 1]) {
    const from = direction * 100
    const to = direction * 390
    const motion = swipeSpring(from, to, direction * 0.1)
    const atTwoFrames = motion.samples.find(({ offset }) => offset * motion.duration >= 1000 / 30 - 0.001)
    assert.ok(Math.abs(atTwoFrames.value - from) < Math.abs(to - from) * 0.25,
      'A nearly stationary finger launched the page across a quarter of the remaining distance in two frames')
    assert.ok(motion.duration < 450)
  }
})

test('Unmount before playback cancels preparation even when its ready callback is already queued', async () => {
  for (const readyQueued of [false, true]) {
    const app = mountSwipe({ hasPill: true })
    app.touch('start', 300, 200, 0)
    app.touch('move', 200, 200, 40, { paint: false })
    app.touch('end', 200, 200, 41, { paint: false })
    assert.equal(app.screen.animations[0].pending, true)
    if (readyQueued) app.paint(48)
    app.cleanup()
    await flushAnimations()
    assert.equal(app.phase, null)
    assert.equal(app.pendingFrames, 0)
    app.paint(140)
    for (const element of [app.screen, app.under, app.pill]) {
      assert.ok(element.animations.every((animation) => animation.cancelled && animation.playState === 'idle'))
    }
    assert.deepEqual(app.navigation, [])
    assert.equal(app.holds, 0)
  }
})

test('Regrabbing during preparation cancels the stale start even when its ready callback is already queued', async () => {
  for (const readyQueued of [false, true]) {
    const app = mountSwipe({ hasPill: true })
    app.touch('start', 300, 200, 0)
    app.touch('move', 200, 200, 40)
    app.touch('end', 200, 200, 41, { paint: false })
    const original = [app.screen, app.under, app.pill].map((element) => element.animations[0])
    if (readyQueued) app.paint(48)
    app.screen.presentationOffset = -100
    app.touch('start', 250, 200, 50, { paint: false })
    await flushAnimations()
    assert.equal(app.phase, 'hold')
    assert.equal(app.pendingFrames, 0)
    assert.equal(app.screen.style.transform, 'translate3d(-100px, 0, 0)')
    assert.ok(original.every((animation) => animation.cancelled && animation.playState === 'idle'))
    app.touch('move', 230, 200, 70)
    app.touch('end', 230, 200, 71)
    await flushAnimations()
    for (const element of [app.screen, app.under, app.pill]) element.animations.at(-1).finish()
    await flushAnimations()
    assert.deepEqual(app.navigation, ['/search'])
    app.commit()
    app.cleanup()
  }
})

test('An unchanged touchend coordinate preserves the velocity of the last moving frames', () => {
  const app = mountSwipe()
  app.touch('start', 300, 200, 0)
  app.touch('move', 200, 200, 40)
  app.touch('move', 180, 200, 56)
  app.touch('move', 160, 200, 72)
  app.touch('end', 160, 200, 88)
  const expected = swipeSpring(-140, -390, -1.25)
  assert.equal(app.pans.at(-1)[3].samples[1].value, expected.samples[1].value)
  app.cleanup()
})

test('A small lifting correction near the destination cannot send a committed tab backwards', () => {
  const app = mountSwipe()
  app.touch('start', 370, 200, 0)
  app.touch('move', 25, 200, 40)
  app.touch('move', 25, 200, 100)
  app.touch('move', 26, 200, 101)
  app.touch('end', 28, 200, 103)
  const samples = app.pans.at(-1)[3].samples
  assert.equal(samples[0].value, -344, 'Lifting correction moved the tab away from its release position')
  assert.equal(samples.at(-1).value, -390)
  for (let index = 1; index < samples.length; index += 1) {
    assert.ok(samples[index].value <= samples[index - 1].value, 'The tab reversed after finger release')
  }
  app.cleanup()
})

test('A deliberate reversal in touchend still cancels a tab change', () => {
  const app = mountSwipe()
  app.touch('start', 300, 200, 0)
  app.touch('move', 150, 200, 40)
  app.touch('move', 150, 200, 100)
  app.touch('end', 185, 200, 120)
  assert.equal(app.screen.animations[0].frames[0].transform, 'translate3d(-150px, 0, 0)')
  assert.equal(app.screen.animations[0].frames.at(-1).transform, 'translate3d(0px, 0, 0)')
  app.cleanup()
})

test('Pausing before release does not reuse the earlier flick velocity', () => {
  const app = mountSwipe()
  app.touch('start', 300)
  app.touch('move', 200, 200, 40)
  app.touch('end', 200, 200, 110)
  const samples = app.pans.at(-1)[3].samples
  // A spring released at rest builds speed gently; the old flick would
  // travel around 20 px in its first 8 ms.
  assert.ok(Math.abs(samples[1].value - samples[0].value) < 12)
  app.cleanup()
})

test('Reversing a far drag before release cancels the tab change', async () => {
  const app = mountSwipe()
  app.touch('start', 300)
  app.touch('move', 80, 200, 80)
  app.touch('move', 120, 200, 100)
  app.touch('move', 160, 200, 120)
  app.touch('end', 160, 200, 121)
  assert.equal(app.screen.animations[0].frames.at(-1).transform, 'translate3d(0px, 0, 0)')
  app.screen.animations[0].finish()
  app.under.animations[0].finish()
  await flushAnimations()
  assert.deepEqual(app.navigation, [])
  app.cleanup()
})

test('Touching an in-flight tab transition grabs its visible position without committing or jumping', async () => {
  const app = mountSwipe()
  app.touch('start', 300)
  app.touch('move', 200, 200, 40)
  app.touch('end', 200, 200, 41)
  const original = app.screen.animations[0]
  app.screen.presentationOffset = -180
  app.touch('start', 250, 200, 100)
  assert.equal(app.screen.style.transform, 'translate3d(-180px, 0, 0)')
  assert.equal(original.cancelled, true)
  assert.deepEqual(app.navigation, [])
  app.touch('move', 230, 200, 120)
  assert.equal(app.screen.style.transform, 'translate3d(-200px, 0, 0)')
  await flushAnimations()
  assert.deepEqual(app.navigation, [])
  app.cleanup()
})

test('Cancelling a grabbed tab transition also clears its pending navigation highlight', async () => {
  const app = mountSwipe()
  app.touch('start', 300)
  app.touch('move', 200, 200, 40)
  app.touch('end', 200, 200, 41)
  assert.deepEqual(app.commits, [-1])
  app.screen.presentationOffset = -180
  app.touch('start', 200, 200, 100)
  app.touch('move', 240, 200, 120)
  app.touch('end', 240, 200, 121)
  assert.deepEqual(app.commits, [-1, null])
  app.screen.animations.at(-1).finish()
  app.under.animations.at(-1).finish()
  await flushAnimations()
  assert.deepEqual(app.navigation, [])
  assert.equal(app.holds, 0)
  app.cleanup()
})

test('A tap or cancelled touch on an in-flight transition resumes instead of leaving screens frozen', async () => {
  for (const end of ['end', 'cancel']) {
    const app = mountSwipe()
    app.touch('start', 300)
    app.touch('move', 200, 200, 40)
    app.touch('end', 200, 200, 41)
    app.screen.presentationOffset = -180
    app.touch('start', 250, 200, 100)
    app.touch(end, 250, 200, 120)
    assert.equal(app.screen.animations[1].frames[0].transform, 'translate3d(-180px, 0, 0)')
    app.screen.animations[1].finish()
    app.under.animations[1].finish()
    await flushAnimations()
    assert.deepEqual(app.navigation, ['/search'])
    app.commit()
    assert.equal(app.holds, 0)
    app.cleanup()
  }
})

test('A fast flick close to the destination settles promptly with no overshoot or long tail', () => {
  const motion = swipeSpring(-380, -390, -2.5)
  assert.ok(motion.duration < 100, `Near-complete flick took ${motion.duration} ms`)
  assert.equal(motion.samples[0].value, -380)
  assert.equal(motion.samples.at(-1).value, -390)
  for (let index = 1; index < motion.samples.length; index += 1) {
    assert.ok(motion.samples[index].value <= motion.samples[index - 1].value)
    assert.ok(motion.samples[index].value >= -390)
  }
})

test('Release motion keeps a consistent response across swipe speeds at 60 and 120 Hz', () => {
  const valueAt = (motion, time) => {
    if (time >= motion.duration) return motion.samples.at(-1).value
    const index = motion.samples.findIndex(point => point.offset * motion.duration >= time)
    if (index === 0) return motion.samples[0].value
    const before = motion.samples[index - 1]
    const after = motion.samples[index]
    const progress = (time / motion.duration - before.offset) / (after.offset - before.offset)
    return before.value + (after.value - before.value) * progress
  }
  for (const distance of [100, 200, 300, 390]) {
    const atRest = swipeSpring(0, distance)
    for (const velocity of [0.1, 0.5, 1, 2, 4, 8, 16, 40, 100]) {
      for (const direction of [-1, 1]) {
        const motion = swipeSpring(0, direction * distance, direction * velocity)
        assert.ok(motion.duration >= atRest.duration * 0.75,
          `${distance}px at ${velocity}px/ms collapsed from ${atRest.duration}ms to ${motion.duration}ms`)
        assert.ok(motion.duration <= 450)
        for (const hz of [60, 120]) {
          let previous = 0
          for (let time = 1000 / hz; time < motion.duration + 1000 / hz; time += 1000 / hz) {
            const value = valueAt(motion, time) * direction
            assert.ok(value >= previous && value <= distance, 'A committed tab overshot or reversed')
            assert.ok(value - previous <= distance * (hz === 60 ? 0.23 : 0.12),
              `${distance}px at ${velocity}px/ms crossed ${value - previous}px in one ${hz}Hz frame`)
            previous = value
          }
        }
      }
    }
  }
})

test('The final spring frame removes less than a fraction of a pixel at rest', () => {
  for (const [from, to, velocity] of [[-100, -390, -2.5], [-30, 0, 0], [-120, 0, 1], [-300, -390, 0]]) {
    const motion = swipeSpring(from, to, velocity)
    const last = motion.samples.at(-1)
    const previous = motion.samples.at(-2)
    assert.ok(Math.abs(last.value - previous.value) < 0.3)
    assert.equal(last.offset, 1)
    assert.ok(motion.duration < 400)
  }
})

test('A short flick still commits when touchend arrives after its last movement', () => {
  const app = mountSwipe()
  app.touch('start', 300, 200, 0)
  app.touch('move', 245, 200, 25)
  app.touch('end', 245, 200, 90)
  assert.equal(app.screen.animations.at(-1).frames.at(-1).transform, 'translate3d(-390px, 0, 0)')
  app.cleanup()
})

test('A tiny coordinate correction while lifting does not cancel a completed drag', () => {
  const app = mountSwipe()
  app.touch('start', 300, 200, 0)
  app.touch('move', 150, 200, 40)
  app.touch('move', 150, 200, 100)
  app.touch('move', 151, 200, 101)
  app.touch('end', 153, 200, 103)
  assert.equal(app.screen.animations.at(-1).frames.at(-1).transform, 'translate3d(-390px, 0, 0)')
  app.cleanup()
})

test('Continuing a grabbed transition cannot drag its destination past the viewport', () => {
  const app = mountSwipe()
  app.touch('start', 300, 200, 0)
  app.touch('move', 200, 200, 40)
  app.touch('end', 200, 200, 41)
  app.screen.presentationOffset = -330
  app.touch('start', 250, 200, 100)
  app.touch('move', 150, 200, 120)
  assert.equal(app.screen.style.transform, 'translate3d(-390px, 0, 0)')
  assert.equal(app.under.style.transform, 'translate3d(0px, 0, 0)')
  app.cleanup()
})

test('Regrabbing a transition retains its compositor layers and heavy-animation hold', () => {
  const app = mountSwipe()
  app.touch('start', 300, 200, 0)
  app.touch('move', 200, 200, 40)
  app.touch('end', 200, 200, 41)
  app.screen.presentationOffset = -180
  app.touch('start', 250, 200, 100)
  app.operations.length = 0
  app.touch('move', 230, 200, 120)
  assert.equal(app.operations.some((operation) => operation.endsWith(':willChange')), false)
  assert.equal(app.pans.some(([x]) => x === null), false)
  app.cleanup()
})

test('An unexpected compositor cancellation still completes a committed transition', async () => {
  const app = mountSwipe()
  app.touch('start', 300, 200, 0)
  app.touch('move', 200, 200, 40)
  app.touch('end', 200, 200, 41)
  app.screen.animations.at(-1).cancel()
  await flushAnimations()
  assert.deepEqual(app.navigation, ['/search'])
  app.commit()
  assert.equal(app.holds, 0)
  app.cleanup()
})

test('Adding a second finger cannot leave the dragged screen frozen between tabs', async () => {
  const app = mountSwipe()
  app.touch('start', 300, 200, 0)
  app.touch('move', 160, 200, 40)
  app.touch('start', 160, 200, 50, { touches: [{ clientX: 160, clientY: 200 }, { clientX: 180, clientY: 230 }] })
  app.touch('end', 160, 200, 80)
  assert.ok(app.screen.animations.length > 0, 'The partial drag had no completion animation')
  assert.equal(app.screen.animations.at(-1).frames.at(-1).transform, 'translate3d(0px, 0, 0)')
  app.screen.animations.at(-1).finish()
  app.under.animations.at(-1).finish()
  await flushAnimations()
  assert.equal(app.holds, 0)
  assert.equal(app.screen.style.transform, '')
  app.cleanup()
})
