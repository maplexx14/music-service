import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { transform } from 'esbuild'
import { createCdTrackSwipe, updateCdTrackSwipe, cdTrackSwipeDirection, cdTrackSwipeVelocity } from '../src/utils/cdTrackSwipe.js'
import { queueStep } from '../src/utils/playerQueue.js'
import { createCdDiscSwipe } from '../src/utils/cdDiscSwipe.js'

const point = (x, y = 50, time = 0, type = 'pointermove') => ({ clientX: x, clientY: y, timeStamp: time, type })

test('horizontal drags and quick flicks select the adjacent track in either direction', () => {
  for (const [x, time, expected] of [[60, 200, 1], [240, 200, -1], [110, 25, 1], [190, 25, -1], [130, 25, 0], [110, 200, 0]]) {
    const swipe = createCdTrackSwipe(point(150))
    updateCdTrackSwipe(swipe, point(x, 50, time))
    assert.equal(cdTrackSwipeDirection(swipe, point(x, 50, time + 1, 'pointerup')), expected)
  }
})

test('vertical intent, cancelled contacts, taps and stale flick velocity cannot change tracks', () => {
  const swipe = createCdTrackSwipe(point(150))
  updateCdTrackSwipe(swipe, point(152, 100, 20))
  updateCdTrackSwipe(swipe, point(40, 105, 40))
  assert.equal(cdTrackSwipeDirection(swipe, point(40, 105, 50, 'pointerup')), 0)
  const flick = createCdTrackSwipe(point(150))
  updateCdTrackSwipe(flick, point(110, 50, 20))
  assert.equal(cdTrackSwipeDirection(flick, point(110, 50, 200, 'pointerup')), 0)
  assert.equal(cdTrackSwipeDirection(flick, point(30, 50, 30, 'pointercancel')), 0)
  assert.equal(cdTrackSwipeDirection(createCdTrackSwipe(point(150)), point(150, 50, 30, 'pointerup')), 0)
})

test('the final release coordinate supports missing move events and a reversed drag', () => {
  const swipe = createCdTrackSwipe(point(150))
  assert.equal(cdTrackSwipeDirection(swipe, point(60, 50, 100, 'pointerup')), 1)
  updateCdTrackSwipe(swipe, point(50, 50, 100))
  assert.equal(cdTrackSwipeDirection(swipe, point(145, 50, 120, 'pointerup')), 0)
})

const source = await readFile(new URL('../src/components/DesktopCdPlayer.jsx', import.meta.url), 'utf8')
const compiled = await transform(source, { loader: 'jsx', jsx: 'automatic', format: 'cjs' })

function player({ mobile = true, action = 'seek', canNext = true, canPrev = true, queuePager = null } = {}) {
  const refNames = [...source.slice(source.indexOf('function DesktopCdPlayer(')).matchAll(/const (\w+Ref) = useRef\(/g)].map(match => match[1])
  const refs = {}, timers = new Map(), captures = new Set(), calls = [], animations = [], rotations = []
  let cursor = 0, sequence = 0
  const queue = [canPrev && 'prev', 'current', canNext && 'next'].filter(Boolean).map(id => ({ id, title: id, duration: 200 }))
  const currentIndex = canPrev ? 1 : 0
  const state = {
    currentTrack: queue[currentIndex], currentIndex, queue, volume: 0.5, duration: 200, isPlaying: true,
    queuePager,
    previousTrack: () => calls.push('previous'), nextTrack: via => calls.push(`next:${via}`),
    seekTo: () => calls.push('seek'), setVolume: () => calls.push('volume'),
  }
  const store = Object.assign(selector => selector(state), { getState: () => state })
  const react = {
    memo: component => component, useCallback: callback => callback,
    useEffect() {}, useLayoutEffect() {},
    useRef(current) { return refs[refNames[cursor++]] = { current } },
    useState(initial) { return [initial === 'loading' ? 'ready' : typeof initial === 'function' ? initial() : initial, () => {}] },
  }
  const jsx = (type, props) => ({ type, props })
  const api = new Proxy({
    hitTest: () => action, discAngleAt: (x, y) => Math.atan2(y - 50, x - 150), progress: () => 0.5,
    rotateBy: (...args) => rotations.push(args),
    setDiscSwipeActive: active => { disc.swiping = active },
  }, { get: (target, key) => target[key] || (() => {}) })
  const body = { style: {} }
  const disc = { style: {}, offsetWidth: 512, getBoundingClientRect: () => ({ left: 50, top: 0, width: 200, height: 200 }) }
  const root = { querySelectorAll: () => [] }
  const element = { style: {}, setPointerCapture: id => captures.add(id),
    closest: () => root,
    hasPointerCapture: id => captures.has(id), releasePointerCapture: id => captures.delete(id) }
  const modules = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    '../store/playerStore': { usePlayerStore: store },
    '../store/uiSettingsStore': { useUiSettingsStore: selector => selector({ liteMode: false, cdPlayerAppearance: { lid: 'clear' } }) },
    '../utils/playerQueue': { queueStep },
    '../utils/cdTrackSwipe': { createCdTrackSwipe, updateCdTrackSwipe, cdTrackSwipeDirection, cdTrackSwipeVelocity },
    '../utils/cdDiscSwipe': { createCdDiscSwipe },
    '../services/playerTransport': { skipForward: (fallback, via) => { calls.push(`transport:${via}`); fallback(via) } },
    '../utils/gpu': { isSoftwareRendering: () => false },
    '../utils/media': { resolveCoverUrl: () => '' },
    '../utils/streamQuality': { isLowQuality: () => false },
    '../hooks/useDiscCover': { useDiscCover: () => ({ src: '', settled: true }) },
    '../hooks/useScreen': { useScreen: () => ({ active: true }) },
    '../hooks/usePowerSave': { usePowerSave: () => false },
    '../hooks/useDeviceTilt': { useDeviceTilt: () => ({ permission: 'unavailable' }) },
    'motion/mini': { animate: (element, values) => {
      const animation = { element, values, stop() {}, then(callback) { this.complete = callback } }
      animations.push(animation)
      return animation
    } },
  }
  const fallback = new Proxy({}, { get: (_target, key) => key === '__esModule' ? true : () => {} })
  const context = vm.createContext({
    module: { exports: {} }, require: name => modules[name] || fallback,
    getComputedStyle: () => ({ translate: '0px 0px' }),
    window: { matchMedia: () => ({ matches: false }) }, document: { hidden: false },
    performance: { now: () => 1000 },
    setTimeout: callback => { timers.set(++sequence, callback); return sequence }, clearTimeout: id => timers.delete(id),
  })
  new vm.Script(compiled.code).runInContext(context)
  const tree = context.module.exports.default({ presentation: mobile ? 'mobile' : 'default', onPlay: () => calls.push('play') })
  const findScene = node => {
    if (!node || typeof node !== 'object') return null
    if (node.props?.className?.split(' ').includes('cd-deck-scene')) return node
    return [node.props?.children].flat(Infinity).map(findScene).find(Boolean)
  }
  const scene = findScene(tree).props
  refs.sceneApiRef.current = api
  refs.sceneRef.current = element
  refs.bodyRef.current = body
  refs.discSwipeRef.current = disc
  const event = (x, y = 50, time = 0, type = 'pointermove', pointerId = 1) => ({
    ...point(x, y, time, type), currentTarget: element, target: { closest: () => false },
    button: 0, isPrimary: pointerId === 1, pointerType: 'touch', pointerId, cancelable: true,
    preventDefault() {}, stopPropagation() {},
  })
  return { calls, body, disc, scene, captures, animations, rotations,
    start: (id = 1) => scene.onPointerDownCapture(event(150, 50, 0, 'pointerdown', id)),
    move: (x, y = 50, time = 100) => scene.onPointerMove(event(x, y, time)),
    end: (x, type = 'pointerup') => scene.onPointerUp(event(x, 50, 110, type)),
    hold() { [...timers.values()].forEach(callback => callback()) },
  }
}

test('swiping the 3D disc switches once through playback transport and never toggles play', () => {
  const env = player()
  env.start()
  env.move(50)
  assert.equal(env.disc.style.translate, '-100px 0px 2px')
  assert.equal(env.body.style.translate, undefined, 'Swiping must leave the chassis in place')
  assert.equal(env.disc.swiping, true, 'Present the moving disc overlay during GPU playback')
  env.end(50)
  env.end(50)
  assert.deepEqual(env.calls, ['transport:cd_swipe', 'next:cd_swipe'])
  assert.equal(env.captures.size, 0)
  assert.equal(env.animations.length, 0, 'A committed swipe continues into the disc belt without a return animation')
  assert.equal(env.disc.style.translate, '-100px 0px 2px', 'Keep the released position until the exchange can take over')
  assert.equal(env.scene['data-swipe-ignore'], '', 'The swipe belongs to the player, not page navigation')
})

test('swiping the chassis works, while a chassis background tap does not start playback', () => {
  const env = player({ action: null })
  env.start(); env.move(250); env.end(250)
  assert.deepEqual(env.calls, ['previous'])
  const tap = player({ action: null })
  tap.start(); tap.end(150)
  assert.deepEqual(tap.calls, [])
})

test('an uncommitted swipe returns the disc belt to its resting position', () => {
  const env = player()
  env.start(); env.move(125); env.end(125)
  assert.deepEqual(env.calls, [])
  const settle = env.animations.at(-1)
  assert.equal(settle.element, env.disc)
  assert.equal(settle.values.translate, '0px 0px 2px')
  settle.complete()
  assert.equal(env.disc.style.translate, '')
  assert.equal(env.disc.swiping, false)
})

test('a quick disc tap plays, while holding the disc preserves circular seeking', () => {
  const tap = player()
  tap.start(); tap.end(150)
  assert.deepEqual(tap.calls, ['play'])
  const seek = player()
  seek.start(); seek.hold(); seek.move(150, 100); seek.end(150)
  assert.ok(seek.calls.includes('seek'))
  assert.equal(seek.calls.some(call => call.startsWith('next') || call === 'previous' || call === 'play'), false)
})

test('a missing neighbour resists, a paginated queue can advance, and cancellation never switches', () => {
  const edge = player({ canNext: false })
  edge.start(); edge.move(50); edge.end(50)
  assert.equal(edge.disc.style.translate, '-20px 0px 2px')
  assert.equal(edge.body.style.translate, undefined)
  assert.deepEqual(edge.calls, [])
  const paged = player({ canNext: false, queuePager: {} })
  paged.start(); paged.move(50); paged.end(50)
  assert.deepEqual(paged.calls, ['transport:cd_swipe', 'next:cd_swipe'])
  for (const kind of ['cancel', 'multitouch']) {
    const env = player()
    env.start(); env.move(50)
    if (kind === 'cancel') env.end(50, 'pointercancel')
    else env.start(2)
    env.end(50)
    assert.deepEqual(env.calls, [])
    assert.equal(env.captures.size, 0)
  }
})

test('3D buttons, volume drags, vertical gestures and desktop rotation cannot skip tracks', () => {
  for (const options of [{ action: 'play' }, { action: 'volume' }, { mobile: false, action: 'rotate' }]) {
    const env = player(options)
    env.start(); env.move(50); env.end(50)
    assert.equal(env.calls.some(call => call.startsWith('next') || call === 'previous'), false)
  }
  const env = player()
  env.start(); env.move(150, 150); env.move(50, 150); env.end(50)
  assert.deepEqual(env.calls, [])
})

test('dragging the chassis with the cursor never rotates the player', () => {
  const env = player({ mobile: false, action: 'rotate' })
  env.start(); env.move(80, 70); env.move(230, 140); env.end(230)
  assert.deepEqual(env.rotations, [])
  assert.deepEqual(env.calls, [])
})
