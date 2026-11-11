import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { transform } from 'esbuild'
import { isDislikedTrack, queueStep } from '../src/utils/playerQueue.js'
import { uuid } from './helpers/identifiers.mjs'

const source = await readFile(new URL('../src/components/FlowDiscArc.jsx', import.meta.url), 'utf8')
const { code } = await transform(source, { format: 'cjs', loader: 'jsx', jsx: 'automatic', target: 'es2020' })
const script = new vm.Script(code, { filename: 'FlowDiscArc.jsx' })

function mount({ mobile = true, ready = [], failed = [], active = true, count = 3, reduced = false,
  currentIndex = null, isShuffle = false, shuffledOrder = [], currentShuffleIndex = 0, dislikedTrackIds = [],
  holdEntrance = false, loaded = true,
} = {}) {
  const hooks = [], observers = [], pinned = [], ribbons = []
  let hookIndex = 0, effects = [], tree, visibleDiscs = []
  const screen = { active }
  const tracks = Array.from({ length: count }, (_, id) => ({ id: uuid(id), cover_url: `/cover-${id}.jpg` }))
  const state = {
    currentTrack: currentIndex === null ? null : tracks[currentIndex],
    queue: currentIndex === null ? [] : tracks,
    currentIndex, isShuffle, shuffledOrder, currentShuffleIndex, dislikedTrackIds,
    flowPreload: loaded ? { tracks } : null, flowPreview: null,
  }
  const animations = tracks.map(() => {
    let finish
    const finished = new Promise((resolve) => { finish = resolve })
    return { animationName: 'flow-disc-enter', startTime: null, finished, finish }
  })
  const discs = tracks.map((_, index) => ({
    attributes: new Set([
      ...(ready.includes(index) ? ['data-cover-ready', 'data-cover-settled'] : []),
      ...(failed.includes(index) ? ['data-cover-settled'] : []),
    ]),
    style: { setProperty() {}, removeProperty() {} },
    hasAttribute(name) { return this.attributes.has(name) },
    setAttribute(name) { this.attributes.add(name) },
    removeAttribute(name) { this.attributes.delete(name) },
    getAnimations() { return holdEntrance && this.hasAttribute('data-disc-enter') ? [animations[index]] : [] },
  }))
  const arc = {
    attributes: new Set(), parentElement: null,
    hasAttribute(name) { return this.attributes.has(name) },
    setAttribute(name) { this.attributes.add(name) },
    removeAttribute(name) { this.attributes.delete(name) },
    querySelectorAll: () => visibleDiscs,
    querySelector: () => null,
    animate() {},
  }
  const effect = (callback, deps) => {
    const index = hookIndex++, previous = hooks[index]
    if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return
    const next = { deps, cleanup: previous?.cleanup }
    hooks[index] = next
    effects.push(() => { next.cleanup?.(); next.cleanup = callback() })
  }
  const store = (selector) => selector(state)
  store.getState = () => ({
    ...state,
    pinFlowPreview(preview) { pinned.push(preview); state.flowPreview ||= preview },
  })
  store.setState = (next) => Object.assign(state, next)
  const jsx = (type, props, key) => ({ type, props, key })
  const modules = {
    react: {
      useEffect: effect, useLayoutEffect: effect,
      useRef(initial) { return hooks[hookIndex++] ??= { current: initial } },
      useState(initial) {
        const index = hookIndex++
        const hook = hooks[index] ??= { value: typeof initial === 'function' ? initial() : initial }
        return [hook.value, (next) => { hook.value = typeof next === 'function' ? next(hook.value) : next }]
      },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'zustand/shallow': { shallow() {} },
    '../store/playerStore': { usePlayerStore: store },
    '../utils/playerQueue': { isDislikedTrack, queueStep },
    '../utils/discTransition': { discNavigationDirection: () => 0 },
    '../utils/discMotion': {
      readDiscSlots: () => new Map(), clearDiscStack() {}, animateDiscStack() {},
      animateDiscNavigation() {}, animateDiscDrum() {},
      animateDiscDialEntrance() { ribbons.push(true); return { cleanup() {} } },
    },
    '../hooks/useScreen': { useScreen: () => screen },
    '../hooks/useWarmNextDiscCover': { useWarmNextDiscCover() {} },
    '../utils/media': { resolveCoverUrl: (url) => url },
    './HeroDisc': { default: 'HeroDisc' },
    './FlowDiscArc.css': {},
  }
  const module = { exports: {} }
  script.runInContext(vm.createContext({
    module, exports: module.exports, require: (name) => {
      assert.ok(name in modules, `Unexpected import: ${name}`)
      return modules[name]
    },
    document: { hidden: false, timeline: { currentTime: 500 } },
    window: {
      matchMedia: (query) => ({
        matches: query.includes('max-width') ? mobile : reduced,
        addEventListener() {}, removeEventListener() {},
      }),
    },
    getComputedStyle: () => ({ getPropertyValue: () => '0' }),
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this) }
      observe() {}
      disconnect() { this.disconnected = true }
    },
  }))
  function render() {
    hookIndex = 0
    tree = module.exports.default({ playing: false })
    tree.props.ref.current = arc
    visibleDiscs = tree.props.children.filter(Boolean).map((slot) =>
      discs[tracks.findIndex(track => track.id === slot.props.children.props.children.props.track.id)])
    for (const run of effects.splice(0)) run()
  }
  render()
  return {
    arc, discs, observers, pinned, ribbons, animations,
    get tree() { return tree },
    ready(index) {
      discs[index].setAttribute('data-cover-ready')
      discs[index].setAttribute('data-cover-settled')
      for (const observer of observers) if (!observer.disconnected) observer.callback()
    },
    loadPreview() {
      state.flowPreload = { tracks }
      render()
      for (const observer of observers) if (!observer.disconnected) observer.callback()
    },
    activate(active) { screen.active = active; render() },
    async settle() { for (let i = 0; i < 5; i++) await Promise.resolve(); render() },
    unmount() { for (const hook of hooks) hook.cleanup?.() },
  }
}

test('mobile discs enter while every cover download is still pending', async () => {
  const app = mount()
  assert.equal(app.arc.hasAttribute('data-discs-ready'), true)
  assert.equal(app.discs[0].hasAttribute('data-disc-enter'), true)
  assert.equal(app.discs[1].hasAttribute('data-cover-settled'), false)
  assert.equal(app.pinned.length, 1)
  await app.settle()
  app.ready(1)
  assert.equal(app.arc.hasAttribute('data-discs-ready'), true)
  assert.equal(app.discs[1].hasAttribute('data-cover-ready'), true)
})

test('mobile discs enter even when the main cover fails and previews stall', () => {
  const app = mount({ failed: [0] })
  assert.equal(app.arc.hasAttribute('data-discs-ready'), true)
  app.ready(2)
  assert.equal(app.arc.hasAttribute('data-discs-ready'), true)
  assert.equal(app.discs[0].hasAttribute('data-cover-ready'), false)
  assert.equal(app.discs[2].hasAttribute('data-disc-enter'), true)
})

test('loading mobile records share one entrance timeline that late decoding cannot restart', async () => {
  const app = mount({ holdEntrance: true })
  assert.ok(app.discs.every((disc) => disc.hasAttribute('data-disc-enter')))
  assert.ok(app.animations.every((animation) => animation.startTime === 500))
  assert.equal(app.arc.hasAttribute('data-entrance-running'), true)
  app.ready(1)
  await app.settle()
  assert.ok(app.animations.every((animation) => animation.startTime === 500), 'decoding must not restart an entrance')
  assert.ok(app.discs.every((disc) => disc.hasAttribute('data-disc-enter')))
  for (const animation of app.animations) animation.finish()
  await app.settle()
  assert.equal(app.arc.hasAttribute('data-entrance-running'), false)
  assert.ok(app.discs.every((disc) => !disc.hasAttribute('data-disc-enter')))
})

test('mobile records finish together without a depth-based entrance delay', async () => {
  const app = mount({ ready: [0, 1, 2], holdEntrance: true })
  app.animations[0].finish()
  await app.settle()
  assert.equal(app.arc.hasAttribute('data-entrance-running'), true)
  assert.ok(app.discs.every((disc) => disc.hasAttribute('data-disc-enter')))
  app.animations[1].finish()
  app.animations[2].finish()
  await app.settle()
  assert.equal(app.arc.hasAttribute('data-entrance-running'), false)
})

test('returning to Home keeps the mobile stack revealed without replaying its entrance', async () => {
  const app = mount({ ready: [0] })
  await app.settle()
  app.activate(false)
  assert.equal(app.arc.hasAttribute('data-discs-ready'), true)
  app.activate(true)
  assert.equal(app.arc.hasAttribute('data-discs-ready'), true)
  assert.equal(app.arc.hasAttribute('data-entrance-running'), false)
  assert.ok(app.discs.every((disc) => !disc.hasAttribute('data-disc-enter')))
  assert.equal(app.pinned.length, 1)
})

test('the mobile main preview has high fetch priority before playback starts', () => {
  const app = mount()
  const records = app.tree.props.children.map((slot) => slot.props.children.props.children)
  assert.equal(records[0].props.preview, true)
  assert.equal(records[0].props.coverPriority, 'high')
  assert.equal(records[1].props.coverPriority, undefined)
})

test('desktop entrance starts before all covers load and runs once', async () => {
  const app = mount({ mobile: false, currentIndex: 1, ready: [0, 1] })
  assert.equal(app.arc.hasAttribute('data-discs-ready'), true)
  assert.equal(app.ribbons.length, 1)
  app.ready(2)
  assert.equal(app.arc.hasAttribute('data-discs-ready'), true)
  assert.equal(app.ribbons.length, 1)
  app.activate(false)
  app.activate(true)
  assert.equal(app.arc.hasAttribute('data-discs-ready'), true)
  assert.equal(app.ribbons.length, 1)
})

test('desktop preview starts with the current and next records, without a previous track', () => {
  const app = mount({ mobile: false })
  const slots = app.tree.props.children.filter(Boolean)
  assert.equal(slots.length, 2)
  assert.deepEqual(Array.from(slots, (slot) => slot.props.children.props.children.props.track.id), [uuid(0), uuid(1)])
  assert.ok(slots.every((slot) => slot.props.style['--slot-x'] !== '-32%'))
})

test('the first selected queue track has no previous record', () => {
  const app = mount({ mobile: false, currentIndex: 0 })
  const slots = app.tree.props.children.filter(Boolean)
  assert.equal(slots.length, 2)
  assert.ok(slots.every((slot) => slot.props.style['--slot-x'] !== '-32%'))
})

test('a previous record appears only at an eligible position before the current track', () => {
  const app = mount({ mobile: false, currentIndex: 1 })
  const previous = app.tree.props.children.find((slot) => slot?.props.style['--slot-x'] === '-32%')
  assert.equal(previous.props.children.props.children.props.track.id, uuid(0))
})

test('shuffle has no previous record at its first position even when the queue index is nonzero', () => {
  const app = mount({ mobile: false, currentIndex: 2, isShuffle: true, shuffledOrder: [2, 0, 1] })
  const slots = app.tree.props.children.filter(Boolean)
  assert.ok(slots.every((slot) => slot.props.style['--slot-x'] !== '-32%'))
  assert.deepEqual(Array.from(slots, (slot) => slot.props.children.props.children.props.track.id), [uuid(2), uuid(0)])
})

test('a disliked previous track is not replaced by an upcoming recommendation', () => {
  const app = mount({ mobile: false, currentIndex: 1, dislikedTrackIds: [uuid(0)] })
  const slots = app.tree.props.children.filter(Boolean)
  assert.ok(slots.every((slot) => slot.props.style['--slot-x'] !== '-32%'))
})

test('queue previews do not wrap to an earlier track at the end', () => {
  const app = mount({ currentIndex: 2 })
  assert.equal(app.tree.props.children.filter(Boolean).length, 1)
  const desktop = mount({ mobile: false, currentIndex: 2 })
  assert.ok(desktop.tree.props.children.filter(Boolean).every((slot) => slot.props.style['--slot-x'] !== '32%'))
})

test('hidden mobile screens wait for activation and then include discs with failed covers', async () => {
  const app = mount({ active: false, ready: [0], failed: [1] })
  assert.equal(app.arc.hasAttribute('data-discs-ready'), false)
  app.activate(true)
  assert.equal(app.arc.hasAttribute('data-discs-ready'), true)
  assert.equal(app.discs[1].hasAttribute('data-disc-enter'), true, 'the record enters even without artwork')
  assert.equal(app.discs[1].hasAttribute('data-cover-ready'), false)
  await app.settle()
  app.unmount()
  assert.ok(app.observers.every((observer) => observer.disconnected))
})

test('discs enter after preview tracks arrive without waiting for cover readiness', () => {
  const app = mount({ loaded: false })
  assert.equal(app.arc.hasAttribute('data-discs-ready'), false)
  app.loadPreview()
  assert.equal(app.arc.hasAttribute('data-discs-ready'), true)
  assert.ok(app.discs.every((disc) => disc.hasAttribute('data-disc-enter')))
  assert.equal(app.pinned.length, 1)
  app.unmount()
})

test('desktop discs enter when every cover fails', () => {
  const app = mount({ mobile: false, currentIndex: 1, failed: [0, 1, 2] })
  assert.equal(app.arc.hasAttribute('data-discs-ready'), true)
  assert.equal(app.ribbons.length, 1)
  app.unmount()
})

test('reduced motion reveals discs with pending covers in both layouts', async () => {
  for (const mobile of [true, false]) {
    const app = mount({ mobile, reduced: true })
    assert.equal(app.arc.hasAttribute('data-discs-ready'), true)
    assert.equal(app.ribbons.length, 0)
    await app.settle()
    assert.equal(app.arc.hasAttribute('data-entrance-running'), false)
    app.unmount()
  }
})
