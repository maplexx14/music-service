import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../src/hooks/usePlaybackProgress.js', import.meta.url), 'utf8')

async function environment(options = {}) {
  let clock = 1005.25, cleanup
  let state = { currentTime: 10.237, duration: 100, isPlaying: true, currentTrack: { id: 1 } }
  const subscribers = new Set(), visible = new Map(), swaps = new Set(), animations = []
  const frames = new Map()
  let sequence = 0, writes = 0
  const media = { currentTime: state.currentTime, playbackRate: 1, paused: false, seeking: false, readyState: 4, addEventListener() {}, removeEventListener() {} }
  const document = { hidden: false, timeline: { get currentTime() { return clock } }, addEventListener: (name, callback) => visible.set(name, callback), removeEventListener: name => visible.delete(name) }
  const refs = Array.from({ length: 3 }, () => {
    let transform
    return { current: {
    style: { get transform() { return transform }, set transform(value) { transform = value; writes++ } },
    animate(frames, options) {
      let started = clock, held = 0, running = true
      const animation = {
        frames, options, playState: 'running',
        get startTime() { return started },
        set startTime(value) { started = value },
        get currentTime() { return running ? clock - started : held },
        cancel() { held = 0; running = false; this.playState = 'idle' },
      }
      animations.push(animation)
      return animation
    },
  } }
  })
  const context = vm.createContext({ document, requestAnimationFrame: callback => { frames.set(++sequence, callback); return sequence }, cancelAnimationFrame: id => frames.delete(id) })
  const exports = {
    react: { useRef: value => ({ current: value }), useLayoutEffect: callback => { cleanup = callback() } },
    '../store/playerStore': { usePlayerStore: { getState: () => state, subscribe: callback => { subscribers.add(callback); return () => subscribers.delete(callback) } } },
    '../services/audioEngine': { getActive: () => media, getIdle: () => null, onSwap: callback => { swaps.add(callback); return () => swaps.delete(callback) } },
    '../utils/frameMeter': { PLAYBACK_ANIMATION_ID: 'playback' },
  }
  const module = new vm.SourceTextModule(source, { context })
  await module.link(name => new vm.SyntheticModule(Object.keys(exports[name]), function () {
    for (const [key, value] of Object.entries(exports[name])) this.setExport(key, value)
  }, { context }))
  await module.evaluate()
  const control = module.namespace.usePlaybackProgress(refs.map(ref => ({ ref, frame: ratio => `translateX(${(ratio - 1) * 100}%)` })), options)
  const change = patch => {
    const previous = state
    state = { ...state, ...patch }
    for (const callback of subscribers) callback(state, previous)
  }
  return {
    refs, animations, control, media, change,
    advance(ms) {
      const end = clock + ms
      while (clock < end) {
        const step = frames.size ? Math.min(1000 / 144, end - clock) : end - clock
        clock += step
        media.currentTime += step / 1000 * media.playbackRate
        const callbacks = [...frames.values()]
        frames.clear()
        for (const callback of callbacks) callback(clock)
      }
      change({ currentTime: media.currentTime })
    },
    visibility(hidden) { document.hidden = hidden; visible.get('visibilitychange')?.() },
    dispose: () => cleanup(),
    get listeners() { return subscribers.size + visible.size + swaps.size },
    get pendingFrames() { return frames.size },
    get writes() { return writes },
  }
}

test('capped progress shares one exact 60Hz timeline even for a fractional remaining duration', async () => {
  const env = await environment({ frameRate: 60 })
  assert.equal(env.animations.length, 3)
  const starts = env.animations.map(animation => animation.startTime)
  assert.ok(starts.every(start => start === starts[0]))
  assert.ok(Math.abs(starts[0] / (1000 / 60) - Math.round(starts[0] / (1000 / 60))) < 1e-8)
  for (const animation of env.animations) {
    const steps = Number(animation.options.easing.match(/steps\((\d+)/)[1])
    assert.ok(Math.abs(animation.options.duration / steps - 1000 / 60) < 1e-10)
    assert.ok(Math.abs(animation.currentTime) < 1000 / 60)
  }
  env.advance(5000)
  assert.equal(env.animations.length, 3, 'Audio ticks cannot restart or desynchronise the existing animations')
  env.dispose()
  assert.equal(env.listeners, 0)
})

test('pause and seeking place the exact audio position without a background animation', async () => {
  const env = await environment({ frameRate: 60 })
  env.advance(1000)
  env.media.paused = true
  env.change({ isPlaying: false })
  assert.ok(env.animations.every(animation => animation.playState === 'idle'))
  assert.ok(env.refs.every(ref => Math.abs(parseFloat(ref.current.style.transform.slice(11)) - (env.media.currentTime - 100)) < 1e-8))
  env.change({ seekRequest: { time: 80 } })
  assert.ok(env.refs.every(ref => Math.abs(parseFloat(ref.current.style.transform.slice(11)) + 20) < 1e-8))
  env.media.currentTime = 80
  env.media.paused = false
  env.change({ seekRequest: null, isPlaying: true, currentTime: 80 })
  assert.equal(env.animations.length, 6)
  env.dispose()
})

test('holding progress freezes its image until release and playback rate changes keep the cadence', async () => {
  const env = await environment({ frameRate: 60 })
  env.advance(1000)
  env.control.current.hold()
  const held = env.refs.map(ref => ref.current.style.transform)
  env.advance(2000)
  assert.deepEqual(env.refs.map(ref => ref.current.style.transform), held)
  env.media.playbackRate = 2
  env.control.current.release()
  assert.equal(env.animations.length, 6)
  for (const animation of env.animations.slice(-3)) {
    const steps = Number(animation.options.easing.match(/steps\((\d+)/)[1])
    assert.ok(Math.abs(animation.options.duration / steps - 1000 / 60) < 1e-10)
  }
  env.advance(1000)
  assert.equal(env.animations.length, 6)
  env.dispose()
})

test('stepped mode creates no animations and uncapped callers retain their existing timeline', async () => {
  const stepped = await environment({ stepped: true, frameRate: 60 })
  assert.equal(stepped.animations.length, 0)
  stepped.advance(1000)
  assert.equal(stepped.animations.length, 0)
  stepped.dispose()
  const uncapped = await environment()
  assert.ok(uncapped.animations.every(animation => animation.options.easing === 'linear'))
  uncapped.dispose()
})

test('frame-driven progress writes at 60Hz on a 144Hz screen without native animations', async () => {
  const env = await environment({ frameRate: 60, native: false })
  const before = env.writes
  assert.equal(env.animations.length, 0)
  assert.equal(env.pendingFrames, 1)
  env.advance(1000)
  const updates = (env.writes - before) / 3
  assert.ok(updates >= 59 && updates <= 62, `${updates} updates on a 144Hz screen`)
  assert.equal(env.pendingFrames, 1, 'Audio ticks cannot create a second frame loop')
  assert.equal(env.animations.length, 0)
  env.dispose()
  assert.equal(env.pendingFrames, 0)
  assert.equal(env.listeners, 0)
})

test('frame-driven progress stops on pause and visibility changes and resumes at the current audio time', async () => {
  const env = await environment({ frameRate: 60, native: false })
  env.advance(1000)
  env.media.paused = true
  env.change({ isPlaying: false })
  assert.equal(env.pendingFrames, 0)
  env.change({ seekRequest: { time: 80 } })
  assert.ok(env.refs.every(ref => Math.abs(parseFloat(ref.current.style.transform.slice(11)) + 20) < 1e-8))
  env.media.currentTime = 80
  env.media.paused = false
  env.change({ seekRequest: null, isPlaying: true, currentTime: 80 })
  assert.equal(env.pendingFrames, 1)
  env.visibility(true)
  assert.equal(env.pendingFrames, 0)
  env.advance(2000)
  assert.equal(env.pendingFrames, 0)
  env.visibility(false)
  assert.equal(env.pendingFrames, 1)
  assert.ok(env.refs.every(ref => Math.abs(parseFloat(ref.current.style.transform.slice(11)) + 18) < 1e-8))
  env.dispose()
  assert.equal(env.pendingFrames, 0)
})
