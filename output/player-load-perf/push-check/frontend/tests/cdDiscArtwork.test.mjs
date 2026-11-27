import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { transform } from 'esbuild'
import { paintCdDiscArtwork, paintCdDiscReflection } from '../src/utils/cdDiscArtwork.js'
import { createDiscSpin, DISC_REVOLUTION_SECONDS, SOFTWARE_DISC_FPS } from '../src/utils/discSpin.js'
import { createCdDiscExchange } from '../src/utils/cdDiscExchange.js'

const source = await readFile(new URL('../src/components/DesktopCdPlayer.jsx', import.meta.url), 'utf8')
const component = source.slice(source.indexOf('function SoftwareDiscOverlay('), source.indexOf('\nfunction DesktopCdPlayer('))
const { code } = await transform(`${component}\nmodule.exports = SoftwareDiscOverlay`, { loader: 'jsx', jsx: 'automatic', format: 'cjs' })

test('a complete disc surface is prepared before replacing the visible texture without clearing it', () => {
  let allocations = 0, liveClears = 0, copied = 0, artworkDrawn = false
  const radii = []
  const gradient = () => ({ addColorStop() {} })
  const image = { naturalWidth: 400, naturalHeight: 400 }
  const stagingContext = {
    createRadialGradient: gradient, clearRect() {}, fillRect() {},
    save() {}, restore() {}, beginPath() {}, fill() {}, stroke() {},
    arc(_x, _y, radius) { radii.push(radius) },
    drawImage(source) { assert.equal(source, image); artworkDrawn = true },
  }
  const frame = { getContext: () => stagingContext }
  const liveContext = {
    canvas: { ownerDocument: { createElement() { allocations++; return frame } } },
    clearRect() { liveClears++ }, save() {}, restore() {},
    drawImage(source) {
      assert.equal(source, frame)
      assert.equal(artworkDrawn, true)
      assert.equal(this.globalCompositeOperation, 'copy')
      copied++
    },
  }
  paintCdDiscArtwork(liveContext, 512, 0.2, image)
  paintCdDiscArtwork(liveContext, 512, 0.2, image)
  assert.equal(allocations, 1)
  assert.equal(copied, 2)
  assert.equal(liveClears, 0)
  assert.ok(radii.includes(512 / 2 * 0.12), 'The center has a small physical spindle hole surrounded by the silver clamp')
})

function mount(coverSrc = '/first.jpg') {
  const hooks = [], images = [], animations = [], subscribers = new Set()
  let index = 0, effects = [], tree, notifications = 0
  let state = { currentTrack: { id: 1 }, isPlaying: false, currentTime: 0 }
  const context = () => ({
    fills: [], draws: [],
    createRadialGradient: () => ({ addColorStop() {} }),
    clearRect() { this.fills = []; this.draws = [] },
    fillRect() { this.fills.push(this.fillStyle) },
    drawImage(image) { this.draws.push(image.src) },
    save() {}, restore() {}, translate() {}, scale() {}, beginPath() {}, arc() {}, stroke() {}, fill() {},
  })
  const canvas = () => {
    const ctx = context()
    return {
      ctx, style: {}, dataset: {}, parentElement: {},
      getContext: () => ctx,
      animate(keyframes, options) {
        const animation = {
          keyframes, options, playState: 'running', cancelled: false,
          pause() { this.playState = 'paused' },
          play() { this.playState = 'running' },
          cancel() { this.cancelled = true; this.playState = 'idle' },
        }
        animations.push(animation)
        return animation
      },
    }
  }
  const artwork = canvas(), reflection = canvas(), overlay = { style: {} }
  const geometry = { transform: 'matrix(1, 0, 0, 1, 0, 0)', facing: true, hubRadiusRatio: 0.1 }
  let props = { geometry, geometryRef: { current: geometry }, coverSrc, active: true, powerSave: false, gestureRef: {}, swipeRef: {}, sceneApiRef: { current: null }, lid: 'clear', softwareRendering: false, onArtworkChange: () => notifications++ }
  const effect = (callback, deps) => {
    const position = index++, previous = hooks[position]
    if (deps && previous?.deps && deps.every((value, i) => Object.is(value, previous.deps[i]))) return
    const next = { deps, cleanup: previous?.cleanup }
    hooks[position] = next
    effects.push(() => { next.cleanup?.(); next.cleanup = callback() })
  }
  const jsx = (type, props) => ({ type, props })
  const module = { exports: {} }
  new vm.Script(code).runInContext(vm.createContext({
    module, exports: module.exports,
    require: () => ({ jsx, jsxs: jsx }),
    useRef: (initial) => hooks[index++] ??= { current: initial },
    useCallback: callback => callback,
    useState(initial) {
      const hook = hooks[index++] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [hook.value, () => {}]
    },
    useEffect: effect, useLayoutEffect: effect,
    SOFTWARE_DISC_SIZE: 512, DISC_REVOLUTION_SECONDS, SOFTWARE_DISC_FPS, createDiscSpin,
    paintCdDiscArtwork, paintCdDiscReflection, createCdDiscExchange, URL,
    usePlayerStore: {
      getState: () => state,
      subscribe(callback) { subscribers.add(callback); return () => subscribers.delete(callback) },
    },
    Image: class {
      constructor() { images.push(this); this.naturalWidth = this.naturalHeight = 300 }
      removeAttribute() {}
    },
    IntersectionObserver: class { observe() {} disconnect() {} },
    performance,
    window: { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), setTimeout: () => 1 },
    document: { hidden: false, baseURI: 'http://localhost/', createElement: () => artwork, addEventListener() {}, removeEventListener() {} },
    clearTimeout() {},
  }))
  function render(next = {}) {
    props = { ...props, ...next }
    index = 0
    tree = module.exports(props)
    if (tree) {
      tree.props.ref(overlay)
      tree.props.children[0].props.ref.current = { parentElement: overlay, append() {} }
      tree.props.children[1].props.ref.current = reflection
    }
    for (const run of effects.splice(0)) run()
  }
  render()
  return {
    artwork, images, animations, render,
    createCanvas: canvas,
    gesture: props.gestureRef,
    updateState(update) {
      const previous = state
      state = { ...state, ...update }
      for (const callback of subscribers) callback(state, previous)
    },
    get tree() { return tree },
    get notifications() { return notifications },
    changeTrack() {
      const previous = state
      state = { ...state, currentTrack: { id: state.currentTrack.id + 1 } }
      for (const callback of subscribers) callback(state, previous)
    },
    unmount() { for (const hook of hooks) hook.cleanup?.() },
  }
}

test('the new disc waits for audible playback and starts one native motor ramp', () => {
  const app = mount()
  app.updateState({ isPlaying: true })
  assert.equal(app.animations.length, 1)
  assert.equal(app.animations[0].playState, 'paused')
  app.updateState({ audibleTrackId: 1 })
  const ramp = app.animations.at(-1)
  assert.equal(ramp.id, 'cd-disc-spin-up')
  assert.ok(ramp.options.duration > 0 && ramp.options.duration <= 480)
  const count = app.animations.length
  app.updateState({ currentTime: 0.1 })
  assert.equal(app.animations.length, count, 'Audio ticks must not restart the acceleration')
  app.unmount()
  assert.equal(ramp.cancelled, true)
})

test('the arriving disc starts from zero instead of inheriting the departing spin phase', () => {
  const app = mount()
  app.images[0].onload()
  const oldAnimation = app.animations[0]
  oldAnimation.currentTime = 7000
  app.artwork.style.transform = 'rotate(168deg)'
  const arriving = app.createCanvas()
  app.gesture.current.setCanvas(arriving)
  assert.equal(oldAnimation.cancelled, true)
  assert.equal(app.animations.length, 2)
  assert.equal(app.animations[1].currentTime, 0)
  assert.equal(app.animations[1].playState, 'paused')
  assert.equal(app.artwork.style.transform, 'rotate(168deg)', 'The outgoing disc retains its own frozen orientation')
  app.unmount()
})

test('a skip keeps the painted disc and its animation through a missing or delayed cover', () => {
  const app = mount()
  app.images[0].onload()
  const animation = app.animations[0], revision = app.artwork.dataset.cdTextureVersion
  const notifications = app.notifications
  app.changeTrack()
  app.render({ coverSrc: null })
  assert.ok(app.tree, 'The disc remains mounted while useDiscCover waits for decoding')
  app.render({ coverSrc: '/next.jpg' })
  assert.deepEqual(app.artwork.ctx.draws, ['/first.jpg'])
  assert.equal(app.artwork.style.opacity ?? '1', '1')
  assert.equal(app.artwork.dataset.cdTextureVersion, revision)
  assert.equal(app.animations.length, 1)
  assert.equal(animation.cancelled, false)
  app.images.at(-1).onload()
  assert.deepEqual(app.artwork.ctx.draws, ['/next.jpg'])
  assert.equal(app.notifications, notifications + 1, 'A paused GPU compositor receives the new artwork')
  app.unmount()
  assert.equal(animation.cancelled, true)
})

test('rapid skips cannot apply a late cover from a superseded track', () => {
  const app = mount()
  app.images[0].onload()
  app.render({ coverSrc: '/slow.jpg' })
  const staleLoad = app.images.at(-1).onload
  app.render({ coverSrc: '/latest.jpg' })
  app.images.at(-1).onload()
  staleLoad()
  assert.deepEqual(app.artwork.ctx.draws, ['/latest.jpg'])
  assert.equal(app.animations.length, 1)
  app.unmount()
})

test('CORS retries and failed artwork preserve the visible disc', () => {
  const app = mount()
  app.images[0].onload()
  app.render({ coverSrc: '/failed.jpg' })
  const image = app.images.at(-1)
  image.onerror()
  image.onerror()
  assert.equal(image.src, '/failed.jpg')
  assert.deepEqual(app.artwork.ctx.draws, ['/first.jpg'])
  assert.equal(app.artwork.style.opacity ?? '1', '1')
  app.unmount()
})

test('the physical disc is opaque before the first cover and beneath transparent artwork', () => {
  const app = mount(null)
  assert.ok(app.tree)
  assert.equal(app.artwork.ctx.fills[0], '#c7ced3')
  app.render({ coverSrc: '/transparent.png' })
  app.images[0].onload()
  assert.equal(app.artwork.ctx.fills[0], '#c7ced3')
  assert.deepEqual(app.artwork.ctx.draws, ['/transparent.png'])
  app.unmount()
})
