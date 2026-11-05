import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { transform } from 'esbuild'
import { swipeSpring } from '../src/utils/swipeSpring.js'

const source = await readFile(new URL('../src/hooks/useSwipeNavigation.js', import.meta.url), 'utf8')
const { code } = await transform(source, { format: 'cjs', target: 'es2020' })
const script = new vm.Script(code, { filename: 'useSwipeNavigation.js' })
const flushAnimations = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

function mountSwipe({ reduced = false, hasNext = true, hasPrev = false, hasUnder = true } = {}) {
  const listeners = new Map()
  const timers = new Map()
  const routeCommits = new Set()
  const pans = []
  const navigation = []
  const commits = []
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
    '../utils/swipeSpring': { swipeSpring },
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
    onPrev: hasPrev ? () => navigation.push('/previous') : null,
    onPan: (...args) => pans.push(args),
    onCommit: (direction) => commits.push(direction),
    targets: { left: 'tab:/search', right: hasPrev ? 'tab:/search' : null },
  })
  return {
    screen, under, pans, navigation, commits, operations, timers, routeCommits, listeners,
    get holds() { return holds },
    touch(name, x, y = 200, timeStamp = 0, extra = {}) {
      const point = { clientX: x, clientY: y }
      listeners.get(`touch${name}`).callback({
        target: screen, touches: name === 'end' ? [] : [point], changedTouches: [point], timeStamp, ...extra,
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

test('An undelivered final movement selects the destination without jumping the rendered screen', () => {
  const app = mountSwipe()
  app.touch('start', 300, 200, 0)
  app.touch('move', 230, 200, 500)
  app.touch('end', 195, 200, 1000)
  assert.equal(app.screen.animations[0].frames[0].transform, 'translate3d(-70px, 0, 0)')
  assert.equal(app.screen.animations[0].frames.at(-1).transform, 'translate3d(-390px, 0, 0)')
  app.cleanup()
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
