import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { transform } from 'esbuild'

const source = await readFile(new URL('../src/hooks/useSwipeNavigation.js', import.meta.url), 'utf8')
const { code } = await transform(source, { format: 'cjs', target: 'es2020' })
const script = new vm.Script(code, { filename: 'useSwipeNavigation.js' })
const flushAnimations = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

function mountSwipe({ reduced = false, hasNext = true, hasUnder = true } = {}) {
  const listeners = new Map()
  const timers = new Map()
  const routeCommits = new Set()
  const pans = []
  const navigation = []
  const operations = []
  let holds = 0
  let timerId = 0
  let cleanup

  class Element {
    constructor(id) {
      this.id = id
      this.scrollWidth = 390
      this.clientWidth = 390
      this.animations = []
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
    querySelector() { return this.scroller }
    animate(frames, options) {
      let resolve
      let reject
      const finished = new Promise((yes, no) => { resolve = yes; reject = no })
      const animation = {
        frames, options, finished, cancelled: false,
        finish() { resolve() },
        cancel() { this.cancelled = true; reject(new Error('Animation cancelled')) },
      }
      this.animations.push(animation)
      return animation
    }
  }
  const screen = new Element('home')
  const under = new Element('search')
  const container = {
    get clientWidth() { operations.push('layout:width'); return 390 },
    querySelector(selector) {
      if (selector.includes('data-active')) return screen
      return hasUnder && selector.includes('tab:/search') ? under : null
    },
    addEventListener(name, callback, options) { listeners.set(name, { callback, options }) },
    removeEventListener(name) { listeners.delete(name) },
  }
  screen.parentElement = container
  const modules = {
    react: { useRef: (current) => ({ current }), useEffect: (effect) => { cleanup = effect() } },
    '../services/navigation': {
      isIOS: false,
      afterNextRouteCommit(callback) { routeCommits.add(callback); return () => routeCommits.delete(callback) },
      holdHeavyAnimations() { holds += 1; return () => { holds -= 1 } },
      skipNextTransitionAnimation() {},
      swipeNextTransition: () => null,
      finishActiveTransition() {},
    },
    '../utils/haptics': { haptic() {}, HAPTIC: { selection: 1 } },
  }
  const hook = { exports: {} }
  script.runInContext(vm.createContext({
    module: hook, exports: hook.exports,
    require(name) { assert.ok(modules[name], `Unexpected import: ${name}`); return modules[name] },
    Element,
    DOMMatrixReadOnly: class { constructor() { this.m41 = screen.presentationOffset ?? 0 } },
    getComputedStyle: (element) => ({ transform: element.style.transform ?? 'none' }),
    window: { innerWidth: 390, matchMedia: () => ({ matches: reduced }) },
    document: { documentElement: { classList: { contains: () => false }, style: { setProperty() {} } } },
    setTimeout(callback, ms) { const id = ++timerId; timers.set(id, { callback, ms }); return id },
    clearTimeout: (id) => timers.delete(id),
    // The input path should not run a frame-measuring loop.
    requestAnimationFrame() { assert.fail('Unexpected animation-frame work during swipe') },
  }))
  hook.exports.useSwipeNavigation({ current: container }, {
    enabled: true,
    onNext: hasNext ? () => navigation.push('/search') : null,
    onPan: (...args) => pans.push(args),
    targets: { left: 'tab:/search' },
  })
  return {
    screen, under, pans, navigation, operations, timers, routeCommits, listeners,
    get holds() { return holds },
    touch(name, x, y = 200, timeStamp = 0) {
      const point = { clientX: x, clientY: y }
      listeners.get(`touch${name}`).callback({
        target: screen, touches: name === 'end' ? [] : [point], changedTouches: [point], timeStamp,
      })
    },
    commit() { const callbacks = [...routeCommits]; routeCommits.clear(); callbacks.forEach((callback) => callback()) },
    cleanup: () => cleanup(),
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
  const firstWrite = app.operations.findIndex((operation) => operation.startsWith('style:'))
  assert.ok(firstWrite > 0)
  assert.equal(app.operations.slice(firstWrite).includes('layout:width'), false)
  for (const { options } of app.listeners.values()) assert.equal(options.passive, true)
  app.cleanup()
})

test('A fast swipe starts from its release position and navigates when both screens finish, without a settle timer', async () => {
  const app = mountSwipe()
  app.touch('start', 300)
  app.touch('move', 200, 200, 40)
  app.touch('end', 200, 200, 41)
  const exit = app.screen.animations[0]
  const enter = app.under.animations[0]
  assert.equal(exit.frames[0].transform, 'translate3d(-100px, 0, 0)')
  assert.equal(exit.frames[1].transform, 'translate3d(-438px, 0, 0)')
  assert.equal(enter.frames[0].transform, 'translate3d(72.5px, 0, 0)')
  assert.equal(enter.frames[1].transform, 'translate3d(0px, 0, 0)')
  assert.deepEqual(exit.options, enter.options)
  const y1 = Number(exit.options.easing.split(',')[1])
  const initialVelocity = (y1 / 0.23) * 338 / exit.options.duration
  assert.ok(Math.abs(initialVelocity - 2.5) < 0.001, `Unexpected release velocity: ${initialVelocity}`)
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

test('Reduced motion commits immediately without waiting for an invisible animation', () => {
  const app = mountSwipe({ reduced: true })
  app.touch('start', 300)
  app.touch('move', 170, 200, 50)
  app.touch('end', 170, 200, 51)
  assert.deepEqual(app.navigation, ['/search'])
  assert.equal(app.screen.animations.length, 0)
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
